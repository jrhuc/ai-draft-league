import type { AgentContextEvent, AgentContextQuery } from "./agent-context.js";
import type { AgentRunner, AgentResult, AgentTask, AgentTool } from "./agent-runtime.js";
import {
  BaseEngine,
  type ChoiceSubstitution,
  type DecisionLog,
  type GameAdaptationTask,
  type GameEnd,
  type GameStart,
} from "./battle-agent.js";
import {
  createBattleMemory,
  type BattleMemory,
  memoryTelemetry,
  memoryUpdateTelemetry,
  nextOpponentMemory,
  renderNotebook,
  serializeBattleMemory,
} from "./battle-memory.js";
import { summarizeBattleEvents } from "./battle-transcript.js";
import type { MenuHints, SlotMenu } from "./choices.js";
import { LLMEngineContext } from "./llm-engine-context.js";
import { battleMenuHints } from "./llm-engine-menu.js";
import { reflectionPrompt } from "./llm-engine-reflection.js";
import { LLMEngineStats } from "./llm-engine-stats.js";
import {
  ACTION_ORDER_TOOL,
  BATTLE_HISTORY_TOOL,
  decisionPhase,
  decisionSchema,
  decisionTools,
  parseDecision,
  parseReflection,
  parseTournamentRetrospective,
  noDecisionEvidence,
  type ParsedDecision,
  reasoningField,
  reflectionSchema,
  retrospectiveSchema,
  totalTokens,
  type Reflection,
} from "./llm-engine-support.js";
import {
  battleSystemPrompt,
  CLOSED_SERIES_REFLECTION_TASK,
  DRAFT_SERIES_REFLECTION_TASK,
  REFLECTION_TASK,
  renderDecision,
  SERIES_REFLECTION_TASK,
  type SheetPolicy,
  TOURNAMENT_REFLECTION_TASK,
  TOURNAMENT_RETROSPECTIVE_TASK,
} from "./prompts.js";
import type { ReasoningLevel } from "./providers.js";
import { ShowdownReference } from "./reference.js";
import { PerspectiveState } from "./perspective-state.js";
import { submissionTool } from "./stage-agent.js";
import type {
  ActionSubmission,
  AgentContext,
  BattleRequest,
  JsonObject,
  Pid,
  SubmissionSource,
  ToolDefinition,
} from "./types.js";
import { text } from "./value.js";

interface LLMEngineOptions {
  runAgent: AgentRunner;
  decisionLog?: DecisionLog;
  traceLog?: DecisionLog;
  contextLog?: DecisionLog;
  initialContext?: readonly AgentContextEvent[];
  format?: string;
  psDir?: string;
  reference?: ShowdownReference;
  reasoning?: ReasoningLevel;
  signal?: AbortSignal;
  initialNotebook?: string;
  draftRoster?: string;
  briefing?: string;
  closedSheets?: boolean;
}

interface PendingDecision {
  generation: number;
  prompt?: string;
  result?: AgentResult<ParsedDecision>;
}

const SUBMIT_ACTION = submissionTool("submit_action", decisionSchema);
const SUBMIT_REVIEW = submissionTool("submit_review", reflectionSchema);
const BATTLE_SUBMISSIONS = [SUBMIT_ACTION, SUBMIT_REVIEW];

export class LLMEngine extends BaseEngine {
  readonly reference: ShowdownReference;
  private state: PerspectiveState;
  private readonly context: LLMEngineContext;
  private readonly stats = new LLMEngineStats();
  private memory: BattleMemory;
  private gameId: string;
  private seriesId?: string;
  private gameNumber = 1;
  private seriesScore = { p1: 0, p2: 0 };
  private loggedMemoryState = "";
  private pending: PendingDecision | undefined;
  private generation = 0;
  private decisionController: AbortController | undefined;
  private activeToolRequest: BattleRequest | undefined;
  private readonly sheets: SheetPolicy;
  private readonly tools: ToolDefinition[];
  private timed = false;
  private observations: string[] = [];
  private firstDecision = true;
  private decisionSequence = 0;
  private abandonedTask: string | undefined;
  private activeRun: Promise<unknown> | undefined;

  constructor(
    pid: Pid,
    readonly spec: string,
    private readonly options: LLMEngineOptions,
  ) {
    super(pid, options.decisionLog);
    this.sheets = options.closedSheets === true ? "closed" : "open";
    this.tools = decisionTools(this.sheets);
    this.reference =
      options.reference ??
      new ShowdownReference(options.format ?? "gen9championsvgc2026regmcbo3", options.psDir);
    this.memory = createBattleMemory(options.initialNotebook);
    this.state = new PerspectiveState(pid);
    this.gameId = spec;
    this.context = new LLMEngineContext(
      pid,
      options.initialContext,
      () => ({
        gameId: this.gameId,
        seriesId: this.seriesId,
        gameNumber: this.gameNumber,
        turn: this.state.turn,
      }),
      (row) => this.writeLog(this.options.contextLog, row),
    );
  }

  override beginGame(context: GameStart): void {
    super.beginGame(context);
    this.abandonDecision();
    this.gameId = context.gameId;
    this.gameNumber = context.gameNumber;
    this.seriesId = context.seriesId;
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    this.state = new PerspectiveState(this.pid);
    this.observations = [];
    this.firstDecision = true;
    this.decisionSequence = 0;
    this.abandonedTask = undefined;
    this.context.append("episode", {
      event: "game_begin",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      series_score: this.seriesScore,
    });
  }

  override coachingNote(): string {
    return renderNotebook(this.memory);
  }
  override coachingState(): string {
    return serializeBattleMemory(this.memory);
  }

  override prepareGameEnd(context: GameEnd): GameAdaptationTask {
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    const winner = text(context.outcome.winner, "tie") || "tie";
    const result = winner === "tie" ? "tied" : context.outcome.won === true ? "won" : "lost";
    this.context.append("episode", {
      event: "game_end",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      result,
      series_score: this.seriesScore,
    });
    const mine = this.seriesScore[this.pid];
    const theirs = this.seriesScore[this.pid === "p1" ? "p2" : "p1"];
    const retrospective =
      context.tournamentStatus === "eliminated" || context.tournamentStatus === "champion";
    const instructions =
      this.options.draftRoster !== undefined
        ? context.seriesOver
          ? DRAFT_SERIES_REFLECTION_TASK
          : REFLECTION_TASK
        : retrospective
          ? TOURNAMENT_RETROSPECTIVE_TASK
          : context.tournamentStatus === "advancing"
            ? SERIES_REFLECTION_TASK
            : context.tournamentStatus === "active"
              ? TOURNAMENT_REFLECTION_TASK
              : context.seriesOver
                ? CLOSED_SERIES_REFLECTION_TASK
                : REFLECTION_TASK;
    return {
      kind: "reflection",
      supersedes: this.abandonedTask ?? null,
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      result,
      series_over: context.seriesOver,
      retrospective,
      opponent_scope_reset: context.tournamentStatus === "advancing",
      system: this.battleSystem(),
      memory_state: this.coachingState(),
      prompt: `${instructions}\n\n${reflectionPrompt({
        seriesId: this.seriesId,
        gameNumber: context.gameNumber,
        result,
        scoreText: this.scoreText(),
        seriesOver: context.seriesOver,
        seriesResult: mine > theirs ? "won" : mine < theirs ? "lost" : "drew",
        score: { mine, theirs },
        pid: this.pid,
        draftRoster: context.seriesOver ? this.options.draftRoster : undefined,
        outcome: context.outcome,
        finalState: this.state.renderReview(),
        gameLog: Array.isArray(context.outcome.pov_lines)
          ? context.outcome.pov_lines.filter((line): line is string => typeof line === "string")
          : [],
        memory: this.memory,
        tournamentStatus: context.tournamentStatus,
        retrospective,
      })}`,
    };
  }

  override async completeGameEnd(task: GameAdaptationTask): Promise<string> {
    if (task.kind !== "reflection") throw new Error(`unknown adaptation ${task.kind}`);
    const gameId = text(task.game_id);
    const gameNumber = Number(task.game_number);
    const prompt = text(task.prompt);
    const system = text(task.system);
    if (!gameId || !Number.isInteger(gameNumber) || gameNumber < 1 || !prompt || !system)
      throw new Error("invalid stored game adaptation task");
    this.memory = createBattleMemory(task.memory_state);
    const retrospective = task.retrospective === true;
    const result = await this.run<Reflection>({
      session: this.sessionKey(gameId),
      task: "reflection",
      supersedes: task.supersedes === null ? undefined : text(task.supersedes),
      system,
      prompt,
      tools: this.battleTools(),
      submission: retrospective
        ? submissionTool(SUBMIT_REVIEW.name, retrospectiveSchema)
        : SUBMIT_REVIEW,
      submissions: BATTLE_SUBMISSIONS,
      validate: (input) =>
        retrospective
          ? parseTournamentRetrospective(input, this.memory)
          : parseReflection(input, this.memory),
    });
    const review = result.value;
    this.stats.reflection(result.usage);
    this.memory =
      task.opponent_scope_reset === true ? nextOpponentMemory(review.memory) : review.memory;
    const memoryState = this.coachingState();
    this.loggedMemoryState = memoryState;
    const fieldsRecorded = review.retrospective
      ? {
          did_well: review.retrospective.didWell,
          did_poorly: review.retrospective.didPoorly,
          would_change: review.retrospective.wouldChange,
        }
      : {};
    const evidence = {
      game_id: gameId,
      series_id: task.series_id ?? null,
      game_number: gameNumber,
      pid: this.pid,
      result: task.result,
      series_over: task.series_over,
      summary: review.summary,
      adjustment: review.adjustment,
      ...fieldsRecorded,
      notebook: renderNotebook(this.memory),
      memory: memoryTelemetry(this.memory),
      memory_update: memoryUpdateTelemetry(review.memoryUpdate),
      memory_repair_attempts: result.attempts - 1,
      opponent_scope_reset: task.opponent_scope_reset,
      session_id: result.sessionID,
      message_id: result.messageID,
    };
    this.context.append("reflection", evidence);
    this.writeLog(this.options.decisionLog, {
      kind: "game_reflection",
      ...evidence,
      memory_state: memoryState,
      total_tokens: totalTokens(result.usage),
      ...reasoningField(result.usage),
      cost: result.usage.cost,
    });
    this.writeLog(this.options.traceLog, {
      kind: "reflection_trace",
      ...evidence,
      prompt,
      raw_response: result.response,
      reasoning: result.reasoning,
      usage: result.usage,
      tool_calls: result.tools,
    });
    return memoryState;
  }

  override async endGame(context: GameEnd): Promise<void> {
    await this.completeGameEnd(this.prepareGameEnd(context));
  }

  override observe(lines: string[]): void {
    this.state.feed(lines);
    this.observations.push(...lines);
    this.context.observe(lines);
  }

  override abandonDecision(): void {
    super.abandonDecision();
    if (this.decisionController && this.decisionSequence)
      this.abandonedTask = `decision-${this.decisionSequence}`;
    this.decisionController?.abort(new Error("decision abandoned"));
    this.decisionController = undefined;
    this.generation += 1;
    this.pending = undefined;
  }

  readContext(query: AgentContextQuery = {}) {
    return this.context.read(query);
  }
  decisionToolDefinitions(): ToolDefinition[] {
    return structuredClone(this.tools);
  }

  private battleSystem(): string {
    return this.briefed(battleSystemPrompt({ sheets: this.sheets, timed: this.timed }));
  }

  private battleTools(): AgentTool[] {
    return this.tools.map((definition) => ({
      definition,
      run: (input: JsonObject) => this.lookupDecisionTool(definition.name, input),
    }));
  }

  lookupDecisionTool(name: string, input: JsonObject): string {
    if (!this.tools.some((tool) => tool.name === name))
      throw new Error(`unknown battle tool ${name}`);
    if (name !== ACTION_ORDER_TOOL.name && name !== "estimate_damage")
      return this.lookupReferenceTool(name, input);
    if (!this.activeToolRequest)
      throw new Error("battle state tools need a battle request first");
    return name === ACTION_ORDER_TOOL.name
      ? this.state.compareActionOrder(input, this.reference)
      : this.state.estimateDamage(input, this.activeToolRequest, this.reference);
  }

  private lookupReferenceTool(name: string, input: JsonObject): string {
    return name === BATTLE_HISTORY_TOOL.name
      ? this.context.readHistory(input)
      : this.reference.lookup(name, input);
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    this.observe(context.povLines);
    this.context.request(request);
    this.activeToolRequest = request;
    this.timed = Boolean(request.timer);
    const generation = this.generation;
    const controller = new AbortController();
    this.decisionController?.abort(new Error("new decision started"));
    this.decisionController = controller;
    this.pending = { generation };
    try {
      const choice = await super.act(request, context);
      return generation === this.generation ? choice : "";
    } catch (error) {
      if (generation !== this.generation) return "";
      throw error;
    } finally {
      if (this.decisionController === controller) this.decisionController = undefined;
      if (this.activeToolRequest === request) this.activeToolRequest = undefined;
    }
  }

  protected override async decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> {
    const generation = this.generation;
    const rendered = this.state.render(request, (mon) => this.reference.describeCompact(mon));
    const speed = request.teamPreview ? "" : this.state.renderEffectiveSpeeds(this.reference);
    const sides = this.state.activeMatchupSides(this.reference);
    const prompt =
      renderDecision({
        state: speed ? `${rendered}\n${speed}` : rendered,
        slotNames: menus.map((_, slot) => this.state.slotName(slot, request)),
        menus,
        transcript: summarizeBattleEvents(this.observations, this.pid),
        memory: this.memory,
        initial: this.firstDecision,
        seriesContext: `Series ${this.seriesId ?? "?"}; game ${this.gameNumber}; score ${this.scoreText()}`,
        matchups: this.reference.renderActiveMatchups(
          [...sides.allies, ...sides.foes],
          [...sides.foes, ...sides.allies],
          this.state.weather?.name ?? "",
        ),
      }) +
      (context.error ? `\nThe simulator rejected the previous action: ${context.error}` : "") +
      (request.timer
        ? `\nShowdown clock: ${request.timer.turnSeconds} seconds this turn; ${request.timer.seconds} seconds in the bank.`
        : "");
    const result = await this.run({
      session: this.sessionKey(this.gameId),
      task: `decision-${++this.decisionSequence}`,
      supersedes: this.abandonedTask,
      timed: this.timed,
      system: this.battleSystem(),
      prompt,
      tools: this.battleTools(),
      submission: SUBMIT_ACTION,
      submissions: BATTLE_SUBMISSIONS,
      validate: (input) => {
        const parsed = parseDecision(input, menus, this.memory);
        BaseEngine.parts(menus, parsed.choices);
        return parsed;
      },
      signal: this.decisionController?.signal,
    });
    if (generation !== this.generation) return [];
    this.firstDecision = false;
    this.observations = [];
    this.pending = { generation, prompt, result };
    return result.value.choices;
  }

  private async run<T>(
    task: Omit<AgentTask<T>, "model" | "reasoning">,
  ): Promise<AgentResult<T>> {
    const signal =
      this.options.signal && task.signal
        ? AbortSignal.any([this.options.signal, task.signal])
        : (this.options.signal ?? task.signal);
    if (this.activeRun) await this.activeRun;
    signal?.throwIfAborted();
    const pending = this.options.runAgent({
      ...task,
      model: this.spec,
      reasoning: this.options.reasoning,
      signal,
    });
    this.activeRun = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private sessionKey(gameId: string): string {
    return `battle-${gameId}-${this.pid}`;
  }
  private briefed(system: string): string {
    return this.options.briefing ? `${system}\n${this.options.briefing}` : system;
  }

  protected override submissionSource(
    automatic: boolean,
    substitution?: ChoiceSubstitution,
  ): SubmissionSource {
    return substitution ? "model-default" : automatic ? "automatic" : "model";
  }

  protected override actionSubmitted(
    request: BattleRequest,
    _context: AgentContext,
    menus: SlotMenu[],
    choices: number[],
    parts: string[],
    automatic: boolean,
    submission: ActionSubmission,
    substitution?: ChoiceSubstitution,
  ): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.generation !== this.generation) return;
    const result = pending.result;
    const evidence = result?.value.evidence ?? noDecisionEvidence(this.memory);
    const rationale = automatic
      ? "Automatic: only one legal joint action."
      : evidence.rationale || "No rationale supplied.";
    if (!automatic) {
      this.memory = evidence.memory;
      this.stats.decision({
        parseFailures: (result?.attempts ?? 1) - 1,
        usage: result?.usage,
        substituted: Boolean(substitution),
      });
    }
    const phase = decisionPhase(request);
    const action = submission.choice;
    if (automatic) this.observations.push(`|message|Automatic action: ${action}`);
    if (!automatic)
      this.stats.tendencies({
        phase,
        menus,
        choices,
        parts,
        action,
        toolLookups: result?.tools.length ?? 0,
        state: this.state,
        pid: this.pid,
        gameId: this.gameId,
      });
    const evidenceSupplied = {
      rationale: evidence.supplied.rationale,
      notebook_update: evidence.supplied.notebookUpdate,
    };
    const memoryUpdate = memoryUpdateTelemetry(evidence.memoryUpdate);
    const base = {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      phase,
      action,
      rationale,
      automatic,
      evidence_supplied: evidenceSupplied,
      memory_update: memoryUpdate,
      ...(result && {
        session_id: result.sessionID,
        message_id: result.messageID,
        task_id: `decision-${this.decisionSequence}`,
        ...(result.recoveryMs !== undefined && { recovery_ms: result.recoveryMs }),
      }),
    };
    this.context.append("decision", {
      ...base,
      notebook: renderNotebook(this.memory),
      memory: memoryTelemetry(this.memory),
      menus: this.context.menus(menus),
    });
    this.holdSubmissionEvidence(submission, {
      kind: "decision",
      ...base,
      selection: choices.map(
        (choice, slot) => menus[slot]?.[choice]?.label ?? parts[slot] ?? "pass",
      ),
      ...this.memoryStateUpdate(),
      requested_choices: substitution?.requested,
      substitution_reason: substitution?.reason,
      parse_failures: (result?.attempts ?? 1) - 1,
      latency_ms: Math.round(result?.latencyMs ?? 0),
      total_tokens: totalTokens(result?.usage),
      ...reasoningField(result?.usage),
      cost: result?.usage.cost,
      tool_lookups: (result?.tools ?? []).map((tool) => tool.name),
    });
    if (!automatic)
      this.writeLog(this.options.traceLog, {
        kind: "decision_trace",
        ...base,
        submission_id: submission.submissionId,
        prompt: pending.prompt ?? "",
        menus: menus.map((menu) => menu.map((item) => item.label)),
        choices,
        parts,
        raw_response: result?.response ?? "",
        reasoning: result?.reasoning ?? null,
        usage: result?.usage ?? {},
        latency_ms: result?.latencyMs ?? 0,
        tool_calls: result?.tools ?? [],
        parse_failures: (result?.attempts ?? 1) - 1,
      });
  }

  override decisionStats() {
    return this.stats.snapshot();
  }
  private memoryStateUpdate(): JsonObject {
    const state = this.coachingState();
    if (state === this.loggedMemoryState) return {};
    this.loggedMemoryState = state;
    return {
      notebook: renderNotebook(this.memory),
      memory_state: state,
      memory: memoryTelemetry(this.memory),
    };
  }
  protected override menuHints(request: BattleRequest): MenuHints | undefined {
    return battleMenuHints(this.state, this.pid, request);
  }
  private scoreText(): string {
    return `you ${this.seriesScore[this.pid]}, opponent ${this.seriesScore[this.pid === "p1" ? "p2" : "p1"]}`;
  }
}
