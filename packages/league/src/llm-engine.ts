import type { AgentContextEvent, AgentContextQuery } from "./agent-context.js";
import type { ChoiceSubstitution, DecisionLog, GameEnd, GameStart } from "./battle-agent.js";
import { BaseEngine } from "./battle-agent.js";
import type { MenuHints, SlotMenu } from "./choices.js";
import { buildMenus } from "./choices.js";
import { LLMEngineContext } from "./llm-engine-context.js";
import { battleMenuHints } from "./llm-engine-menu.js";
import { LLMEngineStats } from "./llm-engine-stats.js";
import { reflectionPrompt, requestReflection } from "./llm-engine-reflection.js";
import {
  ACTION_ORDER_TOOL,
  ASSUMED_TOKENS_PER_SECOND,
  BANK_HEALTHY_SECONDS,
  BANK_LOW_SECONDS,
  boundedToolCalls,
  DECISION_MAX_ORDER_TOOL_CALLS,
  DECISION_MAX_STANDARD_TOOL_CALLS,
  DECISION_MAX_TOOL_ROUNDS,
  DECISION_PARSE_ATTEMPTS,
  DECISION_PREFILL,
  decisionPhase,
  decisionRequestDigest,
  decisionTokenBudget,
  decisionTools,
  DEX_LOOKUP_CACHE_LIMIT,
  extractChoices,
  FORCE_COMMIT_MS,
  FORCE_COMMIT_TURN_FRACTION,
  type ParsedDecision,
  type PendingDecision,
  reasoningField,
  reflectionTools,
  REFLECTION_MAX_TOKENS,
  replayDecisionSchema,
  type ToolTrace,
  totalTokens,
  type DecisionPhase,
  UNTIMED_DECISION_PARSE_ATTEMPTS,
  UNTIMED_EMPTY_RESPONSE_RETRIES,
  UNTIMED_MAX_ORDER_TOOL_CALLS,
  UNTIMED_MAX_STANDARD_TOOL_CALLS,
  UNTIMED_MAX_TOOL_ROUNDS,
  updatedPace,
} from "./llm-engine-support.js";
import { BattleTranscript } from "./llm-engine-transcript.js";
import {
  battleSystemPrompt,
  CLOSED_SERIES_REFLECTION_SYSTEM,
  DRAFT_SERIES_REFLECTION_SYSTEM,
  REFLECTION_SYSTEM,
  renderDecision,
  SERIES_REFLECTION_SYSTEM,
  type SheetPolicy,
  SYSTEM,
  TOURNAMENT_REFLECTION_SYSTEM,
  TOURNAMENT_RETROSPECTIVE_SYSTEM,
} from "./prompts.js";
import type { ReasoningLevel } from "./providers.js";
import {
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  toolResultMessage,
  uniqueToolCalls,
} from "./providers.js";
import { ShowdownReference } from "./reference.js";
import { noStageEvidence } from "./stage-evidence.js";
import {
  type MemoryUpdateScope,
  normalizeStrategicMemory,
  rememberVerifiedReference,
} from "./strategic-memory.js";
import { BattleState } from "./state.js";
import type {
  ActionSubmission,
  AgentContext,
  BattleRequest,
  CompleteOptions,
  Completion,
  JsonObject,
  Pid,
  Provider,
  ProviderMessage,
  SubmissionSource,
  ToolDefinition,
} from "./types.js";
import { text } from "./value.js";

/** Thrown when a decision was superseded or yielded to the battle timer; the stale act() must not commit. */
class DecisionAbandonedError extends Error {
  constructor() {
    super("decision abandoned");
    this.name = "DecisionAbandonedError";
  }
}

interface LLMEngineOptions {
  provider?: Provider;
  apiKey?: string;
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
  carryInNotebook?: string;
  draftRoster?: string;
  briefing?: string;
  closedSheets?: boolean;
}

export { DECISION_MAX_TOKENS_CEILING, REFLECTION_MAX_TOKENS } from "./llm-engine-support.js";

export class LLMEngine extends BaseEngine {
  provider: Provider;
  readonly reference: ShowdownReference;
  private state: BattleState;
  private readonly context: LLMEngineContext;
  private readonly transcript: BattleTranscript;
  private readonly stats = new LLMEngineStats();
  private readonly dexLookupCache = new Map<string, string>();
  private notebook: string;
  private readonly carryInNotebook: string;
  private gameId: string;
  private seriesId?: string;
  private gameNumber = 1;
  private seriesScore = { p1: 0, p2: 0 };
  private observedTokensPerSecond: number | undefined;
  private loggedNotebook = "";
  private pending: PendingDecision | undefined;
  private replayQueue: JsonObject[] = [];
  private generation = 0;
  private decisionController: AbortController | undefined;
  private activeToolRequest: BattleRequest | undefined;
  private readonly sheets: SheetPolicy;
  private readonly decisionTools: ToolDefinition[];
  private readonly reflectionTools: ToolDefinition[];

  constructor(
    pid: Pid,
    readonly spec: string,
    private readonly options: LLMEngineOptions = {},
  ) {
    super(pid, options.decisionLog);
    this.transcript = new BattleTranscript(pid);
    this.sheets = options.closedSheets === true ? "closed" : "open";
    this.decisionTools = decisionTools(this.sheets);
    this.reflectionTools = reflectionTools();
    if (options.provider) this.provider = options.provider;
    else {
      this.provider = makeProvider(parseSpec(spec), {
        apiKey: options.apiKey,
        reasoning: options.reasoning,
      });
    }
    this.reference =
      options.reference ??
      new ShowdownReference(options.format ?? "gen9championsvgc2026regmbbo3", options.psDir);
    this.state = new BattleState(pid);
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
    this.notebook = normalizeStrategicMemory(options.initialNotebook?.trim() ?? "");
    this.carryInNotebook = normalizeStrategicMemory(options.carryInNotebook?.trim() ?? "");
    this.gameId = spec;
  }

  override beginGame(context: GameStart): void {
    super.beginGame(context);
    this.decisionController?.abort(new Error("game changed"));
    this.decisionController = undefined;
    this.gameId = context.gameId;
    this.gameNumber = context.gameNumber;
    this.seriesId = context.seriesId;
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    this.state = new BattleState(this.pid);
    this.pending = undefined;
    this.transcript.reset();
    this.transcript.remember(
      `[Game ${context.gameNumber} begins; series score ${this.scoreText()}]`,
    );
    this.context.append("episode", {
      event: "game_begin",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      series_score: this.seriesScore,
    });
  }

  override coachingNote(): string {
    return this.notebook;
  }

  override async endGame(context: GameEnd): Promise<void> {
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    const winner = text(context.outcome.winner, "tie") || "tie";
    const won = context.outcome.won === true;
    const result = winner === "tie" ? "tied" : won ? "won" : "lost";
    this.transcript.remember(
      `[Game ${context.gameNumber} ended; you ${result}; series score ${this.scoreText()}]`,
    );
    this.context.append("episode", {
      event: "game_end",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      result,
      series_score: this.seriesScore,
    });
    await this.reflect(context, result);
  }

  override observe(lines: string[]): void {
    if (!lines.length) return;
    this.state.feed(lines);
    this.transcript.rememberEvents(lines);
    this.context.observe(lines);
  }

  override abandonDecision(): void {
    this.decisionController?.abort(new Error("decision abandoned"));
    this.decisionController = undefined;
    this.generation += 1;
    this.pending = undefined;
  }

  /** Recorded decisions from an interrupted game, replayed against the re-simulated battle so a
   * resumed run fast-forwards to where it stopped at zero provider cost. Rows must be this
   * engine's in-flight-game decision rows in file order. */
  primeReplay(rows: JsonObject[]): void {
    this.replayQueue = [...rows];
  }

  private requestDigest(request: BattleRequest, menus: SlotMenu[], phase: DecisionPhase): string {
    return decisionRequestDigest({
      pid: this.pid,
      seriesId: this.seriesId,
      gameId: this.gameId,
      gameNumber: this.gameNumber,
      turn: this.state.turn,
      phase,
      request,
      menus,
    });
  }

  private replayAction(request: BattleRequest): string | undefined {
    const rawRow = this.replayQueue.shift();
    if (!rawRow) return undefined;
    const parsedRow = replayDecisionSchema.safeParse(rawRow);
    const phase = decisionPhase(request);
    const menus = buildMenus(request, this.menuHints(request));
    const requestDigest = this.requestDigest(request, menus, phase);
    if (!parsedRow.success) {
      this.replayQueue = [];
      return undefined;
    }
    const row = parsedRow.data;
    if (
      row.request_digest !== requestDigest ||
      row.pid !== this.pid ||
      row.series_id !== (this.seriesId ?? null) ||
      row.game_id !== this.gameId ||
      row.game_number !== this.gameNumber ||
      row.turn !== this.state.turn ||
      row.phase !== phase
    ) {
      /** The live battle diverged from the recording, so the recording is no longer the truth;
       * the rest of the game is decided live. */
      this.replayQueue = [];
      return undefined;
    }
    if (row.notebook !== undefined) {
      this.notebook = normalizeStrategicMemory(row.notebook);
      this.loggedNotebook = this.notebook;
    }
    this.transcript.rememberTurnDetail(`Decision: ${row.action}`);
    this.context.append("decision", {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      phase,
      action: row.action,
      rationale: row.rationale ?? "",
      notebook: this.notebook,
      menus: this.context.menus(menus),
      replayed: true,
    });
    this.restoreSubmission({
      submissionId: row.submission_id,
      choice: row.action,
      source: row.submission_source,
    });
    return row.action;
  }

  readContext(query: AgentContextQuery = {}) {
    return this.context.read(query);
  }

  decisionToolDefinitions(): ToolDefinition[] {
    return structuredClone(this.decisionTools);
  }

  lookupDecisionTool(name: string, args: JsonObject): string {
    const request = this.activeToolRequest;
    if (!request) throw new Error("battle tools are available only during an active decision");
    if (!this.decisionTools.some((tool) => tool.name === name))
      throw new Error(`unknown battle tool ${name}`);
    if (name === ACTION_ORDER_TOOL.name) return this.state.compareActionOrder(args, this.reference);
    if (name === "estimate_damage") return this.state.estimateDamage(args, request, this.reference);
    return this.lookupReferenceTool(name, args);
  }

  private lookupReferenceTool(name: string, args: JsonObject): string {
    const key = `${name} ${JSON.stringify(args)}`;
    const cached = this.dexLookupCache.get(key);
    let result: string;
    if (cached !== undefined) {
      this.dexLookupCache.delete(key);
      this.dexLookupCache.set(key, cached);
      result = cached;
    } else {
      result = this.reference.lookup(name, args);
      this.dexLookupCache.set(key, result);
      if (this.dexLookupCache.size > DEX_LOOKUP_CACHE_LIMIT) {
        const oldest = this.dexLookupCache.keys().next().value;
        if (oldest !== undefined) this.dexLookupCache.delete(oldest);
      }
    }
    this.notebook = rememberVerifiedReference(this.notebook, {
      tool: name,
      arguments: args,
      format: this.reference.format,
      revision: this.reference.revision,
      result,
    });
    return result;
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const events = context.povLines;
    this.state.feed(events);
    this.transcript.rememberEvents(events);
    this.context.observe(events);
    this.context.request(request);
    const replayed = this.replayAction(request);
    if (replayed !== undefined) return replayed;
    this.activeToolRequest = request;
    const generation = this.generation;
    const controller = new AbortController();
    this.decisionController?.abort(new Error("new decision started"));
    this.decisionController = controller;
    this.pending = { rawResponse: "", generation };
    if (request.timer) this.pending.timer = request.timer;
    try {
      const choice = await super.act(request, context);
      return generation === this.generation ? choice : "";
    } catch (caught) {
      if (caught instanceof DecisionAbandonedError) return "";
      throw caught;
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
    const started = performance.now();
    const turnSeconds = request.timer?.turnSeconds;
    const deadline = turnSeconds === undefined ? undefined : started + 1000 * turnSeconds;
    const forceCommitMs =
      turnSeconds === undefined
        ? FORCE_COMMIT_MS
        : Math.max(FORCE_COMMIT_MS, turnSeconds * 1000 * FORCE_COMMIT_TURN_FRACTION);
    const remainingMs = () =>
      deadline === undefined ? Number.POSITIVE_INFINITY : deadline - performance.now();
    const tokenFloor =
      this.options.reasoning === "high" ? 8192 : this.options.reasoning === "xhigh" ? 16_384 : 0;
    const pace = () => this.observedTokensPerSecond ?? ASSUMED_TOKENS_PER_SECOND;
    let maxTokens = Math.max(tokenFloor, decisionTokenBudget(remainingMs(), pace()));
    let truncatedBudget = 0;
    let earlyLengthStop: { outputTokens: number; requestedMaxTokens: number } | undefined;
    const generation = this.generation;
    const decisionSignal = this.decisionController?.signal;
    const renderedState = this.state.render(request, (mon) => this.reference.describeCompact(mon));
    const speed = request.teamPreview ? "" : this.state.renderEffectiveSpeeds(this.reference);
    const state = speed ? `${renderedState}\n${speed}` : renderedState;
    const sides = this.state.activeMatchupSides(this.reference);
    const matchups = this.reference.renderActiveMatchups(
      [...sides.allies, ...sides.foes],
      [...sides.foes, ...sides.allies],
      this.state.weather?.name ?? "",
    );
    let prompt = renderDecision({
      state,
      slotNames: menus.map((_, slot) => this.state.slotName(slot, request)),
      menus,
      transcript: this.transcript.lines,
      notebook: this.notebook,
      seriesContext: `Series ${this.seriesId ?? "?"}; game ${this.gameNumber}; score ${this.scoreText()}`,
      matchups,
    });
    if (turnSeconds !== undefined) {
      const bank = request.timer?.seconds ?? turnSeconds;
      const bankAdvice =
        bank <= BANK_LOW_SECONDS
          ? "The bank is low: commit quickly and rebuild time on easy turns."
          : bank >= BANK_HEALTHY_SECONDS && maxTokens >= 8192
            ? "The bank is healthy: think as deeply as this decision warrants before committing."
            : "Spend time only where it changes the choice.";
      const paceNote =
        tokenFloor > decisionTokenBudget(remainingMs(), pace())
          ? ""
          : " — what your generation speed fits into the turn";
      prompt += `\n\nShowdown timer: ${Math.round(turnSeconds)} seconds of wall clock this turn; ${Math.round(bank)} seconds remain in the clock bank. Your whole reply, reasoning included, is capped at ${maxTokens} tokens${paceNote}. A reply cut off at the cap submits nothing, so settle on a choice early and answer well inside it. ${bankAdvice}`;
    }
    if (context.error)
      prompt += `\n\nThe simulator rejected the previous joint action: ${context.error}`;

    let rawResponse = "";
    const usage: Record<string, number> = {};
    let parsed: ParsedDecision | undefined;
    let error = "no choices found";
    let parseFailures = 0;
    let toolRounds = 0;
    const toolCalls: ToolTrace[] = [];
    const offeredToolNames = new Set(this.decisionTools.map((tool) => tool.name));
    const seenToolResults = new Map<string, string>();
    const failedAttempts: { response: string; error: string }[] = [];
    const reasoningParts: string[] = [];
    const upstreamProviders = new Set<string>();
    const messages: ProviderMessage[] = [{ role: "user", content: prompt }];
    const failDecision = (cause: unknown): Promise<number[]> => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure = classifyProviderFailure(cause, this.spec);
      const failed = this.stats.abandonedFailure();
      const repeated = failed.repeated;
      const stop = failure.terminal || repeated;
      if (this.pending?.generation === generation) this.pending = undefined;
      this.transcript.rememberTurnDetail(
        `No choice submitted: ${failure.summary} ${stop ? "The run cannot continue." : "The battle timer acts when time expires."}`,
      );
      const phase = decisionPhase(request);
      const timer = request.timer
        ? {
            turn_seconds: request.timer.turnSeconds ?? null,
            bank_seconds: request.timer.seconds ?? null,
          }
        : null;
      const base = {
        game_id: this.gameId,
        series_id: this.seriesId ?? null,
        game_number: this.gameNumber,
        turn: this.state.turn,
        pid: this.pid,
        phase,
      };
      const trace = {
        kind: "decision_trace",
        ...base,
        prompt,
        menus: menus.map((menu) => menu.map((item) => item.label)),
        choices: [],
        parts: [],
        raw_response: rawResponse,
        reasoning: reasoningParts.join("\n\n").trim() || null,
        usage,
        latency_ms: performance.now() - started,
        timer,
        parse_failures: parseFailures,
        tool_rounds: toolRounds,
        max_tokens: maxTokens,
        tokens_per_second: this.observedTokensPerSecond
          ? Math.round(this.observedTokensPerSecond)
          : null,
        tool_calls: toolCalls,
        fallback: true,
        failure_kind: failure.kind,
        error_summary: failure.summary,
        error: message,
        upstream_providers: upstreamProviders.size ? [...upstreamProviders] : undefined,
        failed_attempts: failedAttempts.length ? failedAttempts : undefined,
      };
      this.writeLog(this.options.traceLog, trace);
      if (stop) {
        const reason = repeated
          ? `${this.spec} failed to submit ${failed.count} consecutive decisions. ${failure.summary}`
          : `${failure.summary} The run cannot continue.`;
        throw new Error(reason, { cause: cause });
      }
      return new Promise<number[]>((_resolve, reject) => {
        const abort = () => reject(new DecisionAbandonedError());
        if (decisionSignal?.aborted) abort();
        else decisionSignal?.addEventListener("abort", abort, { once: true });
      });
    };
    const parseAttempts = request.timer ? DECISION_PARSE_ATTEMPTS : UNTIMED_DECISION_PARSE_ATTEMPTS;
    let emptyRetries = 0;
    while (!parsed && parseFailures < parseAttempts) {
      if (generation !== this.generation) throw new DecisionAbandonedError();
      if (parseFailures && (rawResponse || truncatedBudget || earlyLengthStop)) {
        /** Replaying a cut-off ramble verbatim spends the retry's input budget on reasoning that cannot
         * contain the missing ending. Summarise it instead and ask for the answer first. */
        messages.push({
          role: "assistant",
          content:
            truncatedBudget || earlyLengthStop
              ? "[response cut off before a choice was submitted]"
              : rawResponse,
        });
        messages.push({
          role: "user",
          content: truncatedBudget
            ? `Your previous response ran past its ${truncatedBudget}-token budget before submitting a choice. Reply with the required JSON immediately, keeping reasoning brief enough to finish inside the budget.`
            : earlyLengthStop
              ? `The provider stopped your previous response for length after ${earlyLengthStop.outputTokens} output tokens, below the requested ${earlyLengthStop.requestedMaxTokens}-token cap. Reply with the required JSON immediately.`
              : `Your previous response was invalid. Error: ${error}. Reply again following the required JSON format.`,
        });
      }
      rawResponse = "";
      truncatedBudget = 0;
      earlyLengthStop = undefined;
      const maxToolRounds =
        deadline === undefined ? UNTIMED_MAX_TOOL_ROUNDS : DECISION_MAX_TOOL_ROUNDS;
      let cutoffAnnounced = false;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        if (generation !== this.generation) throw new DecisionAbandonedError();
        if (request.timer && remainingMs() < 2000)
          return failDecision(new Error("turn time exhausted"));
        const finalRound = round === maxToolRounds || remainingMs() < forceCommitMs;
        if (finalRound && !cutoffAnnounced) {
          cutoffAnnounced = true;
          messages.push({
            role: "user",
            content:
              "Tool budget for this decision is exhausted; further tool calls will not be executed. Submit your choice now in the required JSON format.",
          });
        }
        maxTokens = Math.max(tokenFloor, decisionTokenBudget(remainingMs(), pace()));
        let completion: Completion;
        try {
          const attemptOptions: CompleteOptions = {
            maxTokens,
            tools: this.decisionTools,
            toolChoice: finalRound ? "none" : "auto",
          };
          if (finalRound) attemptOptions.prefillResponse = DECISION_PREFILL;
          if (request.timer) attemptOptions.failFast = true;
          completion = await this.completeOnce(
            messages,
            attemptOptions,
            this.briefed(
              battleSystemPrompt({ sheets: this.sheets, timed: Boolean(request.timer) }),
            ),
            decisionSignal,
          );
        } catch (caught) {
          if (generation !== this.generation) throw new DecisionAbandonedError();
          if (request.timer && !this.options.signal?.aborted) return failDecision(caught);
          throw caught;
        }
        for (const [key, value] of Object.entries(completion.usage)) {
          usage[key] = (usage[key] ?? 0) + (key === "cost" ? value : Math.trunc(value));
        }
        if (completion.provider) upstreamProviders.add(completion.provider);
        if (completion.reasoning) reasoningParts.push(completion.reasoning);
        if (completion.toolCalls.length && !finalRound) {
          toolRounds += 1;
          const standardMax =
            deadline === undefined
              ? UNTIMED_MAX_STANDARD_TOOL_CALLS
              : DECISION_MAX_STANDARD_TOOL_CALLS;
          const orderMax =
            deadline === undefined ? UNTIMED_MAX_ORDER_TOOL_CALLS : DECISION_MAX_ORDER_TOOL_CALLS;
          const { kept: calls, dropped } = boundedToolCalls(
            uniqueToolCalls(completion.toolCalls),
            standardMax,
            orderMax,
          );
          messages.push(assistantToolMessage(completion));
          for (const call of dropped) {
            const result = `Not executed: this round exceeded its budget of ${standardMax} standard and ${orderMax} order calls. Re-issue the call next round if you still need it.`;
            toolCalls.push({ name: call.name, arguments: call.arguments, result });
            messages.push(toolResultMessage(call.id, result));
          }
          for (const call of calls) {
            const seenKey = `${call.name} ${JSON.stringify(call.arguments)}`;
            const cached = seenToolResults.get(seenKey);
            const result =
              cached !== undefined
                ? `[identical to an earlier call this decision] ${cached}`
                : !offeredToolNames.has(call.name)
                  ? `Not executed: tool ${JSON.stringify(call.name)} was not offered for this decision.`
                  : this.lookupDecisionTool(call.name, call.arguments);
            if (cached === undefined) seenToolResults.set(seenKey, result);
            toolCalls.push({ name: call.name, arguments: call.arguments, result });
            messages.push(toolResultMessage(call.id, result));
          }
          if (deadline !== undefined) {
            const seconds = Math.max(0, Math.round(remainingMs() / 1000));
            const last = messages[messages.length - 1];
            if (last) last.content = `${last.content}\n[Timer: ${seconds}s left this turn]`;
          }
          continue;
        }
        /** Reported output reaching this call's requested cap is budget exhaustion even when a provider
         * omits finishReason. A length stop below that cap is still truncation, but not budget exhaustion. */
        const outputTokens = Math.trunc(completion.usage.output_tokens ?? 0);
        if (outputTokens >= maxTokens) truncatedBudget = maxTokens;
        else if (completion.finishReason === "length")
          earlyLengthStop = { outputTokens, requestedMaxTokens: maxTokens };
        if (!completion.text && !completion.toolCalls.length && truncatedBudget) break;
        rawResponse = completion.text;
        /** Some reasoning models via gateways finish with every token in the reasoning channel and an
         * empty text field; the decision they wrote is salvaged rather than bought again on a retry. */
        if (!rawResponse && !completion.toolCalls.length && completion.reasoning) {
          try {
            extractChoices(completion.reasoning, menus, this.notebook);
            rawResponse = completion.reasoning;
          } catch {}
        }
        break;
      }
      if (!rawResponse) {
        error = truncatedBudget
          ? `reasoning exhausted the ${truncatedBudget}-token response budget`
          : earlyLengthStop
            ? `provider stopped the response for length after ${earlyLengthStop.outputTokens} output tokens, below the requested ${earlyLengthStop.requestedMaxTokens}-token cap`
            : "empty response";
        failedAttempts.push({ response: "", error });
        if (request.timer) return failDecision(new Error(error));
        if (truncatedBudget) {
          parseFailures += 1;
          continue;
        }
        if (emptyRetries < UNTIMED_EMPTY_RESPONSE_RETRIES) {
          emptyRetries += 1;
          continue;
        }
        break;
      }
      try {
        parsed = extractChoices(rawResponse, menus, this.notebook);
        BaseEngine.parts(menus, parsed.choices);
      } catch (caught) {
        parsed = undefined;
        error = truncatedBudget
          ? `reasoning exhausted the ${truncatedBudget}-token response budget before a choice was submitted`
          : earlyLengthStop
            ? `provider stopped the response for length after ${earlyLengthStop.outputTokens} output tokens, below the requested ${earlyLengthStop.requestedMaxTokens}-token cap before a choice was submitted`
            : caught instanceof Error
              ? caught.message
              : String(caught);
        if (!truncatedBudget && /[|｜]\s*DSML\s*[|｜]/.test(rawResponse)) {
          error =
            "the response wrote tool-call markup as plain text, which nothing executes. Call tools through the API tool interface or reply with the required JSON object";
        }
        failedAttempts.push({ response: rawResponse, error });
        parseFailures += 1;
      }
    }
    const fallback = !parsed;
    const decision =
      parsed ??
      ({
        choices: BaseEngine.defaults(menus)[0],
        evidence: {
          ...noStageEvidence(this.notebook),
          rationale: `No valid decision (${error}); defaulted to the first legal option for each slot.`,
        },
      } satisfies ParsedDecision);
    if (generation === this.generation && this.pending) {
      const update: PendingDecision = {
        prompt,
        rawResponse,
        evidence: decision.evidence,
        usage,
        fallback,
        latencyMs: performance.now() - started,
        toolCalls,
        parseFailures,
        toolRounds,
        maxTokens,
        generation,
      };
      const reasoning = reasoningParts.join("\n\n").trim();
      if (reasoning) update.reasoning = reasoning;
      if (fallback) update.error = error;
      if (fallback && (truncatedBudget || earlyLengthStop))
        update.errorSummary = classifyProviderFailure(new Error(error), this.spec).summary;
      if (upstreamProviders.size) update.upstreamProviders = [...upstreamProviders];
      if (failedAttempts.length) update.failedAttempts = failedAttempts;
      Object.assign(this.pending, update);
    }
    return decision.choices;
  }

  private briefed(system: string): string {
    return this.options.briefing ? `${system}\n${this.options.briefing}` : system;
  }

  private async completeOnce(
    messages: ProviderMessage[],
    options: CompleteOptions,
    system = SYSTEM,
    operationSignal?: AbortSignal,
  ): Promise<Completion> {
    const runSignal = this.options.signal;
    const signal =
      runSignal && operationSignal
        ? AbortSignal.any([runSignal, operationSignal])
        : (runSignal ?? operationSignal);
    const startedAt = performance.now();
    const completion = await this.provider.complete(
      system,
      messages,
      signal ? { ...options, signal } : options,
    );
    this.observedTokensPerSecond = updatedPace(
      this.observedTokensPerSecond,
      completion.usage.output_tokens ?? 0,
      performance.now() - startedAt,
    );
    return completion;
  }

  protected override submissionSource(
    automatic: boolean,
    substitution?: ChoiceSubstitution,
  ): SubmissionSource {
    return substitution || this.pending?.fallback
      ? "model-default"
      : automatic
        ? "automatic"
        : "model";
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
    const evidence = automatic
      ? noStageEvidence(this.notebook)
      : (pending.evidence ?? noStageEvidence(this.notebook));
    const rationale = automatic
      ? "Automatic: only one legal joint action."
      : evidence.rationale || "No rationale supplied.";
    const evidenceSupplied = {
      rationale: evidence.supplied.rationale,
      notebook_update: evidence.supplied.notebookUpdate,
    };
    if (!automatic) {
      this.notebook = evidence.notebook;
      this.stats.decision({
        fallback: pending.fallback ?? false,
        parseFailures: pending.parseFailures ?? 0,
        usage: pending.usage,
        substituted: Boolean(substitution),
      });
    }
    const action = request.teamPreview ? `team ${parts.join("")}` : parts.join(", ");
    this.transcript.rememberTurnDetail(`Decision: ${action}`);
    const phase = decisionPhase(request);
    const requestDigest = this.requestDigest(request, menus, phase);
    const selection = choices.map(
      (choice, slot) => menus[slot]?.[choice]?.label ?? parts[slot] ?? "pass",
    );
    if (!automatic)
      this.stats.tendencies({
        phase,
        menus,
        choices,
        parts,
        action,
        toolLookups: pending.toolCalls?.length ?? 0,
        state: this.state,
        pid: this.pid,
        gameId: this.gameId,
      });
    const timer = pending.timer
      ? {
          turn_seconds: pending.timer.turnSeconds ?? null,
          bank_seconds: pending.timer.seconds ?? null,
        }
      : null;
    const substituted = substitution
      ? { requested_choices: substitution.requested, substitution_reason: substitution.reason }
      : {};
    this.context.append("decision", {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      phase,
      action,
      rationale,
      notebook: this.notebook,
      menus: this.context.menus(menus),
      evidence_supplied: evidenceSupplied,
      automatic,
      fallback: pending.fallback ?? false,
    });
    const submissionEvidence = {
      kind: "decision",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      phase,
      request_digest: requestDigest,
      selection,
      action,
      rationale,
      evidence_supplied: evidenceSupplied,
      ...this.notebookUpdate(),
      automatic,
      fallback: pending.fallback ?? false,
      error: pending.error ?? null,
      ...substituted,
      parse_failures: pending.parseFailures ?? 0,
      latency_ms: Math.round(pending.latencyMs ?? 0),
      total_tokens: totalTokens(pending.usage),
      ...reasoningField(pending.usage),
      timer,
      tool_lookups: (pending.toolCalls ?? []).map((call) => call.name),
      error_summary: pending.errorSummary || undefined,
      cost: pending.usage?.cost,
      upstream_providers: pending.upstreamProviders?.length ? pending.upstreamProviders : undefined,
    };
    this.holdSubmissionEvidence(submission, submissionEvidence);
    if (automatic) return;
    const trace = {
      kind: "decision_trace",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      phase,
      prompt: pending.prompt ?? "",
      menus: menus.map((menu) => menu.map((item) => item.label)),
      choices,
      parts,
      ...substituted,
      raw_response: pending.rawResponse ?? "",
      reasoning: pending.reasoning ?? null,
      usage: pending.usage ?? {},
      latency_ms: pending.latencyMs ?? 0,
      timer,
      parse_failures: pending.parseFailures ?? 0,
      tool_rounds: pending.toolRounds ?? 0,
      max_tokens: pending.maxTokens ?? null,
      tokens_per_second: this.observedTokensPerSecond
        ? Math.round(this.observedTokensPerSecond)
        : null,
      tool_calls: pending.toolCalls ?? [],
      fallback: pending.fallback ?? false,
      error: pending.error ?? null,
      upstream_providers: pending.upstreamProviders?.length ? pending.upstreamProviders : undefined,
      failed_attempts: pending.failedAttempts?.length ? pending.failedAttempts : undefined,
      error_summary: pending.errorSummary || undefined,
    };
    this.writeLog(this.options.traceLog, trace);
  }

  override decisionStats() {
    return this.stats.snapshot();
  }

  private notebookUpdate(): JsonObject {
    if (this.notebook === this.loggedNotebook) return {};
    this.loggedNotebook = this.notebook;
    return { notebook: this.notebook };
  }

  protected override menuHints(request: BattleRequest): MenuHints | undefined {
    return battleMenuHints(this.state, this.pid, request);
  }

  static extractChoices(response: string, menus: SlotMenu[], currentNotebook = ""): ParsedDecision {
    return extractChoices(response, menus, currentNotebook);
  }

  private async reflect(context: GameEnd, result: string): Promise<void> {
    const seriesOver = context.seriesOver;
    const mine = this.seriesScore[this.pid];
    const theirs = this.seriesScore[this.pid === "p1" ? "p2" : "p1"];
    const seriesResult = mine > theirs ? "won" : mine < theirs ? "lost" : "drew";
    const draftRoster = seriesOver ? this.options.draftRoster : undefined;
    const draft = this.options.draftRoster !== undefined;
    const retrospective =
      context.tournamentStatus === "eliminated" || context.tournamentStatus === "champion";
    const memoryScope: MemoryUpdateScope =
      context.tournamentStatus === "advancing" ? "next-round" : seriesOver ? "rematch" : "series";
    const prompt = reflectionPrompt({
      seriesId: this.seriesId,
      gameNumber: context.gameNumber,
      result,
      scoreText: this.scoreText(),
      seriesOver,
      seriesResult,
      score: { mine, theirs },
      pid: this.pid,
      draftRoster,
      outcome: context.outcome,
      finalState: this.state.renderReview(),
      timeline: this.transcript.lines,
      gameLog: Array.isArray(context.outcome.pov_lines)
        ? context.outcome.pov_lines.filter((line): line is string => typeof line === "string")
        : [],
      notebook: this.notebook,
      tournamentStatus: context.tournamentStatus,
      retrospective,
    });
    const system = this.briefed(
      draft
        ? seriesOver
          ? DRAFT_SERIES_REFLECTION_SYSTEM
          : REFLECTION_SYSTEM
        : retrospective
          ? TOURNAMENT_RETROSPECTIVE_SYSTEM
          : context.tournamentStatus === "advancing"
            ? SERIES_REFLECTION_SYSTEM
            : context.tournamentStatus === "active"
              ? TOURNAMENT_REFLECTION_SYSTEM
              : seriesOver
                ? CLOSED_SERIES_REFLECTION_SYSTEM
                : REFLECTION_SYSTEM,
    );
    const {
      usage,
      rawResponse,
      error,
      failureSummary,
      failureKind,
      fallback,
      review,
      toolRounds,
      toolCalls,
      failedAttempts,
    } = await requestReflection({
      prompt,
      currentNotebook: this.notebook,
      fallbackNotebook:
        context.tournamentStatus === "advancing" ? this.carryInNotebook : this.notebook,
      memoryScope,
      reference: { format: this.reference.format, revision: this.reference.revision },
      result,
      spec: this.spec,
      tools: this.reflectionTools,
      retrospective,
      complete: (messages, finalRound) =>
        this.completeOnce(
          messages,
          {
            maxTokens: REFLECTION_MAX_TOKENS,
            tools: this.reflectionTools,
            toolChoice: finalRound ? "none" : "auto",
          },
          system,
        ),
      lookupTool: (name, args) => this.lookupReferenceTool(name, args),
    });
    this.stats.reflection(fallback, usage);
    this.notebook = review.notebook;
    this.transcript.remember(
      review.retrospective
        ? `Tournament retrospective: ${review.summary}`
        : `Game review: ${review.summary} Next-game adjustment: ${review.adjustment}`,
    );
    const retrospectiveFields = review.retrospective
      ? {
          did_well: review.retrospective.didWell,
          did_poorly: review.retrospective.didPoorly,
          would_change: review.retrospective.wouldChange,
        }
      : {};
    this.context.append("reflection", {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      result,
      series_over: seriesOver,
      summary: review.summary,
      adjustment: review.adjustment,
      ...retrospectiveFields,
      notebook: this.notebook,
      fallback,
    });
    const reflectionLog = {
      kind: "game_reflection",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      pid: this.pid,
      result,
      series_over: seriesOver,
      summary: review.summary,
      adjustment: review.adjustment,
      ...retrospectiveFields,
      notebook: this.notebook,
      total_tokens: totalTokens(usage),
      ...reasoningField(usage),
      fallback,
      error: error ?? null,
      error_summary: failureSummary || undefined,
      failure_kind: failureKind || undefined,
    };
    const reflectionTrace = {
      kind: "reflection_trace",
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      pid: this.pid,
      series_over: seriesOver,
      prompt,
      raw_response: rawResponse,
      usage,
      tool_rounds: toolRounds,
      tool_calls: toolCalls,
      fallback,
      error: error ?? null,
      error_summary: failureSummary || undefined,
      failure_kind: failureKind || undefined,
      failed_attempts: failedAttempts.length ? failedAttempts : undefined,
    };
    this.writeLog(this.options.decisionLog, reflectionLog);
    this.writeLog(this.options.traceLog, reflectionTrace);
  }

  private scoreText(): string {
    const foe: Pid = this.pid === "p1" ? "p2" : "p1";
    return `you ${this.seriesScore[this.pid]}, opponent ${this.seriesScore[foe]}`;
  }
}
