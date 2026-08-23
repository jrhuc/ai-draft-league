import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type AgentContextEvent,
  type AgentContextKind,
  type AgentContextQuery,
  AgentContextStream,
} from './agent-context.js';
import type { ChoiceSubstitution, DecisionLog, DecisionStats, GameEnd, GameStart } from './battle-agent.js';
import { BaseEngine } from './battle-agent.js';
import { summarizeBattleEvents } from './battle-transcript.js';
import type { MenuHints, SlotMenu, TargetNames } from './choices.js';
import { buildMenus } from './choices.js';
import {
  battleSystemPrompt,
  DRAFT_SERIES_REFLECTION_SYSTEM,
  REFLECTION_SYSTEM,
  renderDecision,
  SERIES_REFLECTION_SYSTEM,
  type SheetPolicy,
  SYSTEM,
} from './prompts.js';
import type { ReasoningLevel } from './providers.js';
import {
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  toolResultMessage,
  uniqueToolCalls,
} from './providers.js';
import { DEX_TOOLS, ShowdownReference } from './reference.js';
import { normalizeStageEvidence, noStageEvidence, type StageEvidence } from './stage-evidence.js';
import { BattleState } from './state.js';
import type {
  ActionSubmission,
  AgentContext,
  BattleRequest,
  CompleteOptions,
  Completion,
  JsonObject,
  JsonValue,
  Pid,
  Provider,
  ProviderMessage,
  SubmissionSource,
  ToolCall,
  ToolDefinition,
} from './types.js';
import { clip, isRecord, text } from './value.js';

interface ParsedDecision {
  choices: number[];
  rationale?: string;
  notebook?: string;
  evidence: StageEvidence;
}

interface Reflection {
  summary: string;
  adjustment: string;
  notebook: string;
}

const decisionToolParametersSchema = z.object({ properties: z.record(z.string(), z.json()) }).passthrough();
const replayDecisionSchema = z.object({
  request_digest: z.string(),
  pid: z.enum(['p1', 'p2']),
  series_id: z.string().nullable(),
  game_id: z.string(),
  game_number: z.number(),
  turn: z.number(),
  phase: z.enum(['team_preview', 'forced_switch', 'turn']),
  action: z.string(),
  submission_id: z.string(),
  submission_source: z.enum(['model', 'automatic', 'model-default']),
  outcome: z.enum(['accepted', 'rejected']),
  notebook: z.string().optional().catch(undefined),
  rationale: z.string().optional().catch(undefined),
});
const reflectionSchema = z.object({
  summary: z.string(),
  adjustment: z.string(),
  notebook: z.string(),
});
const suppliedDecisionEvidenceSchema = z.object({ rationale: z.string(), notebook: z.string() });

interface ToolTrace extends JsonObject {
  name: string;
  arguments: JsonObject;
  result: string;
}

/** Thrown when a decision was superseded or yielded to the battle timer; the stale act() must not commit. */
class DecisionAbandonedError extends Error {
  constructor() {
    super('decision abandoned');
    this.name = 'DecisionAbandonedError';
  }
}

interface PendingDecision {
  prompt?: string;
  rawResponse?: string;
  evidence?: StageEvidence;
  reasoning?: string;
  generation: number;
  usage?: Record<string, number>;
  upstreamProviders?: string[];
  fallback?: boolean;
  error?: string;
  latencyMs?: number;
  toolCalls?: ToolTrace[];
  failedAttempts?: { response: string; error: string }[];
  parseFailures?: number;
  toolRounds?: number;
  errorSummary?: string;
  maxTokens?: number;
  timer?: { turnSeconds?: number; seconds?: number };
}

export interface LLMEngineOptions {
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
  /** Full draft roster with the registered six marked; its presence switches the series-final
   * reflection to the draft variant that also reviews the registration itself. */
  draftRoster?: string;
  briefing?: string;
  closedSheets?: boolean;
}

const CONSECUTIVE_DECISION_FAILURE_LIMIT = 3;
const FORCE_COMMIT_MS = 25_000;
const FORCE_COMMIT_TURN_FRACTION = 0.5;
const BANK_HEALTHY_SECONDS = 300;
const BANK_LOW_SECONDS = 120;
const DECISION_MIN_TOKENS = 1024;
/** Timed budgets follow generation pace so replies arrive before the gameplay timer expires. The untimed
 * ceiling sits above observed traffic while still bounding runaway reasoning loops. */
export const DECISION_MAX_TOKENS_CEILING = 65_536;
const ASSUMED_TOKENS_PER_SECOND = 75;
const PACE_SAFETY = 0.8;
const PACE_SAMPLE_MIN_TOKENS = 256;
const PACE_SAMPLE_MIN_MS = 2000;
/** Timed tool budgets keep lookups from burning the battle clock; untimed budgets exist only to bound
 * runaway loops, so they allow wide mechanical verification. */
const DECISION_MAX_TOOL_ROUNDS = 2;
const DECISION_MAX_STANDARD_TOOL_CALLS = 2;
const DECISION_MAX_ORDER_TOOL_CALLS = 1;
/** Doom-loop backstops only: run-3 traffic piled up at the old round cap of 12 (101 decisions stopped
 * at exactly 12), so real analyses were being interrupted; identical repeat calls are now answered from
 * cache, which is the loop catch these caps used to approximate. */
const UNTIMED_MAX_TOOL_ROUNDS = 30;
const UNTIMED_MAX_STANDARD_TOOL_CALLS = 12;
const UNTIMED_MAX_ORDER_TOOL_CALLS = 4;
const DECISION_PARSE_ATTEMPTS = 2;
const UNTIMED_DECISION_PARSE_ATTEMPTS = 4;
const UNTIMED_EMPTY_RESPONSE_RETRIES = 2;
/** Content backstops, not budgets: run-3 hit the old notebook cap of 1600 on 190 decisions, every one
 * amputating the newest plans mid-sentence. Anything these do clip carries a visible marker. */
const DECISION_NOTE_LIMIT = 8000;
const DECISION_RATIONALE_LIMIT = 2000;
export const REFLECTION_MAX_TOKENS = 32_768;
const TRANSCRIPT_CHARACTER_LIMIT = 24000;
const TRANSCRIPT_CLIP_MARKER = '[Earlier turns are omitted from this timeline.]';

const ACTION_ORDER_TOOL: ToolDefinition = {
  name: 'compare_action_order',
  description:
    'Compare two Pokémon (active or benched) using live Speed state without revealing hidden EVs. Applies visible items, boosts, status, Tailwind, weather abilities, Trick Room, and move priority including ability modifiers (Prankster, Gale Wings, Triage, Grassy Glide, Stall, Mycelium Might) and priority items (Quick Claw, Lagging Tail); also explains Encore timing and redundant locks. Pass "switch" as a move to time a switch-out, which resolves before moves.',
  parameters: {
    type: 'object',
    properties: {
      first: { type: 'string', description: 'Species name (active or benched) or ally/foe slot, such as ally 1.' },
      second: { type: 'string', description: 'Species name (active or benched) or ally/foe slot, such as foe 2.' },
      first_move: {
        type: 'string',
        description: 'Optional move being considered for the first Pokémon, or "switch" for switching out.',
      },
      second_move: {
        type: 'string',
        description: 'Optional move being considered for the second Pokémon, or "switch" for switching out.',
      },
    },
    required: ['first', 'second'],
    additionalProperties: false,
  },
};

const DAMAGE_TOOL_DESCRIPTIONS = {
  open: 'Estimate damage using the current battle request and open team sheets. Supply only the two visible Pokémon and move; the harness applies known abilities, items, exact own stats, opposing nature ranges, boosts, status, HP, screens, weather, terrain, both active allies with their abilities, and the fainted count that scales Last Respects. Helping Hand and critical-hit flags are optional hypothetical modifiers.',
  closed:
    'Estimate damage using the current battle request and what the battle has revealed. Supply only the two visible Pokémon and move; the harness applies revealed abilities and items, exact own stats, legal opposing stat ranges, boosts, status, HP, screens, weather, terrain, both active allies with their abilities, and the fainted count that scales Last Respects. Helping Hand and critical-hit flags are optional hypothetical modifiers.',
} satisfies Record<SheetPolicy, string>;

function decisionTools(sheets: SheetPolicy): ToolDefinition[] {
  return [
    ...DEX_TOOLS.map((tool) => {
      if (tool.name !== 'estimate_damage') return tool;
      const parameters = decisionToolParametersSchema.parse(tool.parameters);
      return {
        ...tool,
        description: DAMAGE_TOOL_DESCRIPTIONS[sheets],
        parameters: {
          ...parameters,
          properties: Object.fromEntries(
            ['attacker', 'defender', 'move', 'helping_hand', 'is_critical_hit'].map((name) => [
              name,
              parameters.properties[name] ?? null,
            ]),
          ),
        },
      };
    }),
    ACTION_ORDER_TOOL,
  ];
}

/** reasoning_tokens is a breakdown of output_tokens, so summing input and output covers the full spend. */
function totalTokens(usage: Record<string, number> | undefined): number {
  return Math.trunc((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0));
}

/** Absent means the provider did not report a reasoning breakdown; zero means it reported none used. */
function reasoningField(usage: Record<string, number> | undefined): Record<string, number> {
  const value = usage?.reasoning_tokens;
  return value === undefined ? {} : { reasoning_tokens: Math.trunc(value) };
}

export function decisionTokenBudget(remainingMs: number, tokensPerSecond: number): number {
  if (!Number.isFinite(remainingMs)) return DECISION_MAX_TOKENS_CEILING;
  const feasible = Math.floor(((remainingMs / 1000) * tokensPerSecond * PACE_SAFETY) / 256) * 256;
  return Math.min(DECISION_MAX_TOKENS_CEILING, Math.max(DECISION_MIN_TOKENS, feasible));
}

export function updatedPace(previous: number | undefined, outputTokens: number, elapsedMs: number): number | undefined {
  if (outputTokens < PACE_SAMPLE_MIN_TOKENS || elapsedMs < PACE_SAMPLE_MIN_MS) return previous;
  const rate = (1000 * outputTokens) / elapsedMs;
  return previous === undefined ? rate : (previous + rate) / 2;
}

function boundedToolCalls(calls: ToolCall[], standardMax: number, orderMax: number) {
  const order = calls.filter((call) => call.name === ACTION_ORDER_TOOL.name).slice(0, orderMax);
  const standard = calls.filter((call) => call.name !== ACTION_ORDER_TOOL.name).slice(0, standardMax);
  const selectedIds = new Set([...standard, ...order].map((call) => call.id));
  return {
    kept: calls.filter((call) => selectedIds.has(call.id)),
    dropped: calls.filter((call) => !selectedIds.has(call.id)),
  };
}

type DecisionPhase = 'team_preview' | 'forced_switch' | 'turn';

const DECISION_REQUEST_DIGEST_VERSION = 'battle-decision-request-v1';

function decisionPhase(request: BattleRequest): DecisionPhase {
  return request.teamPreview ? 'team_preview' : request.forceSwitch ? 'forced_switch' : 'turn';
}

function decisionRequestProjection(request: BattleRequest): JsonObject {
  return {
    active: request.active ?? null,
    force_switch: request.forceSwitch ?? null,
    max_chosen_team_size: request.maxChosenTeamSize ?? null,
    side: request.side ?? null,
    team_preview: request.teamPreview ?? null,
    timer: request.timer ?? null,
    wait: request.wait ?? null,
  };
}

function stableDecisionRequestJson(value: JsonObject): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!isRecord(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}

function decisionRequestDigest(input: {
  pid: Pid;
  seriesId: string | undefined;
  gameId: string;
  gameNumber: number;
  turn: number;
  phase: DecisionPhase;
  request: BattleRequest;
  menus: SlotMenu[];
}): string {
  const projection = {
    version: DECISION_REQUEST_DIGEST_VERSION,
    pid: input.pid,
    series_id: input.seriesId ?? null,
    game_id: input.gameId,
    game_number: input.gameNumber,
    turn: input.turn,
    phase: input.phase,
    request: decisionRequestProjection(input.request),
    menus: input.menus.map((menu) =>
      menu.map((item) => ({ label: item.label, canonical_action: item.part, kind: item.kind })),
    ),
  };
  const hash = createHash('sha256').update(stableDecisionRequestJson(projection)).digest('hex');
  return `${DECISION_REQUEST_DIGEST_VERSION}:${hash}`;
}

export class LLMEngine extends BaseEngine {
  provider: Provider;
  readonly reference: ShowdownReference;
  private state: BattleState;
  private readonly fullContext: AgentContextStream;
  private readonly contextAttempt = randomUUID();
  private transcript: string[] = [];
  private notebook: string;
  private gameId: string;
  private seriesId?: string;
  private gameNumber = 1;
  private seriesScore = { p1: 0, p2: 0 };
  private decisions = 0;
  private fallbacks = 0;
  private reflections = 0;
  private reflectionFallbacks = 0;
  private moveSelections = 0;
  private switchSelections = 0;
  private protectSelections = 0;
  private consecutiveProtectSelections = 0;
  private allyTargetSelections = 0;
  private spreadMoveSelections = 0;
  private megaSelections = 0;
  private toolLookups = 0;
  private repeatedJointActions = 0;
  private teamPreviews = 0;
  private bringChanges = 0;
  private leadChanges = 0;
  private substitutedActions = 0;
  private abandonedDecisions = 0;
  private parseFailureCount = 0;
  private costTotal = 0;
  private reasoningTotal = 0;
  private observedTokensPerSecond: number | undefined;
  private loggedNotebook = '';
  private previousPreview: { brought: string; leads: string } | undefined;
  private previousTurnAction: { gameId: string; turn: number; action: string } | undefined;
  private previousProtect = new Map<string, { gameId: string; turn: number }>();
  private pending: PendingDecision | undefined;
  private replayQueue: JsonObject[] = [];
  private generation = 0;
  private decisionController: AbortController | undefined;
  private activeToolRequest: BattleRequest | undefined;
  private consecutiveDecisionFailures = 0;
  private readonly sheets: SheetPolicy;
  private readonly decisionTools: ToolDefinition[];

  constructor(
    pid: Pid,
    readonly spec: string,
    private readonly options: LLMEngineOptions = {},
  ) {
    super(pid, options.decisionLog);
    this.sheets = options.closedSheets === true ? 'closed' : 'open';
    this.decisionTools = decisionTools(this.sheets);
    if (options.provider) this.provider = options.provider;
    else {
      this.provider = makeProvider(parseSpec(spec), { apiKey: options.apiKey, reasoning: options.reasoning });
    }
    this.reference =
      options.reference ?? new ShowdownReference(options.format ?? 'gen9championsvgc2026regmbbo3', options.psDir);
    this.state = new BattleState(pid);
    this.fullContext = new AgentContextStream(options.initialContext, (event) => {
      this.writeLog(this.options.contextLog, {
        kind: 'agent_context',
        pid: this.pid,
        series_id: this.seriesId ?? null,
        context_id: event.id,
        sequence: event.sequence,
        context_kind: event.kind,
        payload: event.payload,
      });
    });
    this.notebook = clip(options.initialNotebook?.trim() ?? '', DECISION_NOTE_LIMIT);
    this.gameId = spec;
  }

  override beginGame(context: GameStart): void {
    super.beginGame(context);
    this.decisionController?.abort(new Error('game changed'));
    this.decisionController = undefined;
    this.gameId = context.gameId;
    this.gameNumber = context.gameNumber;
    this.seriesId = context.seriesId;
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    this.state = new BattleState(this.pid);
    this.pending = undefined;
    this.transcript = [];
    this.remember(`[Game ${context.gameNumber} begins; series score ${this.scoreText()}]`);
    this.appendContext('episode', {
      event: 'game_begin',
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
    const winner = text(context.outcome.winner, 'tie') || 'tie';
    const won = context.outcome.won === true;
    const result = winner === 'tie' ? 'tied' : won ? 'won' : 'lost';
    this.remember(`[Game ${context.gameNumber} ended; you ${result}; series score ${this.scoreText()}]`);
    this.appendContext('episode', {
      event: 'game_end',
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
    this.rememberEvents(lines);
    this.appendObservation(lines);
  }

  override abandonDecision(): void {
    this.decisionController?.abort(new Error('decision abandoned'));
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
      this.notebook = row.notebook;
      this.loggedNotebook = row.notebook;
    }
    this.rememberTurnDetail(`Decision: ${row.action}`);
    this.appendContext('decision', {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      phase,
      action: row.action,
      rationale: row.rationale ?? '',
      notebook: this.notebook,
      menus: this.contextMenus(menus),
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
    return this.fullContext.read(query);
  }

  decisionToolDefinitions(): ToolDefinition[] {
    return structuredClone(this.decisionTools);
  }

  lookupDecisionTool(name: string, args: JsonObject): string {
    const request = this.activeToolRequest;
    if (!request) throw new Error('battle tools are available only during an active decision');
    if (!this.decisionTools.some((tool) => tool.name === name)) throw new Error(`unknown battle tool ${name}`);
    if (name === ACTION_ORDER_TOOL.name) return this.state.compareActionOrder(args, this.reference);
    if (name === 'estimate_damage') return this.state.estimateDamage(args, request, this.reference);
    return this.reference.lookup(name, args);
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const events = context.povLines;
    this.state.feed(events);
    this.rememberEvents(events);
    this.appendObservation(events);
    this.appendRequestObservation(request);
    const replayed = this.replayAction(request);
    if (replayed !== undefined) return replayed;
    this.activeToolRequest = request;
    const generation = this.generation;
    const controller = new AbortController();
    this.decisionController?.abort(new Error('new decision started'));
    this.decisionController = controller;
    this.pending = { rawResponse: '', generation };
    if (request.timer) this.pending.timer = request.timer;
    try {
      const choice = await super.act(request, context);
      return generation === this.generation ? choice : '';
    } catch (caught) {
      if (caught instanceof DecisionAbandonedError) return '';
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
    const remainingMs = () => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - performance.now());
    const tokenFloor = this.options.reasoning === 'high' ? 8192 : this.options.reasoning === 'xhigh' ? 16_384 : 0;
    const pace = () => this.observedTokensPerSecond ?? ASSUMED_TOKENS_PER_SECOND;
    let maxTokens = Math.max(tokenFloor, decisionTokenBudget(remainingMs(), pace()));
    let truncatedBudget = 0;
    let earlyLengthStop: { outputTokens: number; requestedMaxTokens: number } | undefined;
    const generation = this.generation;
    const decisionSignal = this.decisionController?.signal;
    const renderedState = this.state.render(request, (mon) => this.reference.describeCompact(mon));
    const speed = request.teamPreview ? '' : this.state.renderEffectiveSpeeds(this.reference);
    const state = speed ? `${renderedState}\n${speed}` : renderedState;
    const sides = this.state.activeMatchupSides(this.reference);
    const matchups = this.reference.renderActiveMatchups(
      [...sides.allies, ...sides.foes],
      [...sides.foes, ...sides.allies],
      this.state.weather?.name ?? '',
    );
    let prompt = renderDecision({
      state,
      slotNames: menus.map((_, slot) => this.state.slotName(slot, request)),
      menus,
      transcript: this.transcript,
      notebook: this.notebook,
      seriesContext: `Series ${this.seriesId ?? '?'}; game ${this.gameNumber}; score ${this.scoreText()}`,
      matchups,
    });
    if (turnSeconds !== undefined) {
      const bank = request.timer?.seconds ?? turnSeconds;
      const bankAdvice =
        bank <= BANK_LOW_SECONDS
          ? 'The bank is low: commit quickly and rebuild time on easy turns.'
          : bank >= BANK_HEALTHY_SECONDS && maxTokens >= 8192
            ? 'The bank is healthy: think as deeply as this decision warrants before committing.'
            : 'Spend time only where it changes the choice.';
      const paceNote =
        tokenFloor > decisionTokenBudget(remainingMs(), pace())
          ? ''
          : ' — what your generation speed fits into the turn';
      prompt += `\n\nShowdown timer: ${Math.round(turnSeconds)} seconds of wall clock this turn; ${Math.round(bank)} seconds remain in the clock bank. Your whole reply, reasoning included, is capped at ${maxTokens} tokens${paceNote}. A reply cut off at the cap submits nothing, so settle on a choice early and answer well inside it. ${bankAdvice}`;
    }
    if (context.error) prompt += `\n\nThe simulator rejected the previous joint action: ${context.error}`;

    let rawResponse = '';
    const usage: Record<string, number> = {};
    let parsed: ParsedDecision | undefined;
    let error = 'no choices found';
    let parseFailures = 0;
    let toolRounds = 0;
    const toolCalls: ToolTrace[] = [];
    const offeredToolNames = new Set(this.decisionTools.map((tool) => tool.name));
    const seenToolResults = new Map<string, string>();
    const failedAttempts: { response: string; error: string }[] = [];
    const reasoningParts: string[] = [];
    const upstreamProviders = new Set<string>();
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
    const failDecision = (cause: unknown): Promise<number[]> => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure = classifyProviderFailure(cause, this.spec);
      this.abandonedDecisions += 1;
      this.consecutiveDecisionFailures += 1;
      const repeated = this.consecutiveDecisionFailures >= CONSECUTIVE_DECISION_FAILURE_LIMIT;
      const stop = failure.terminal || repeated;
      if (this.pending?.generation === generation) this.pending = undefined;
      this.rememberTurnDetail(
        `No choice submitted: ${failure.summary} ${stop ? 'The run cannot continue.' : 'The battle timer acts when time expires.'}`,
      );
      const phase = decisionPhase(request);
      const timer = request.timer
        ? { turn_seconds: request.timer.turnSeconds ?? null, bank_seconds: request.timer.seconds ?? null }
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
        kind: 'decision_trace',
        ...base,
        prompt,
        menus: menus.map((menu) => menu.map((item) => item.label)),
        choices: [],
        parts: [],
        raw_response: rawResponse,
        reasoning: reasoningParts.join('\n\n').trim() || null,
        usage,
        latency_ms: performance.now() - started,
        timer,
        parse_failures: parseFailures,
        tool_rounds: toolRounds,
        max_tokens: maxTokens,
        tokens_per_second: this.observedTokensPerSecond ? Math.round(this.observedTokensPerSecond) : null,
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
          ? `${this.spec} failed to submit ${this.consecutiveDecisionFailures} consecutive decisions. ${failure.summary}`
          : `${failure.summary} The run cannot continue.`;
        throw new Error(reason, { cause: cause });
      }
      return new Promise<number[]>((_resolve, reject) => {
        const abort = () => reject(new DecisionAbandonedError());
        if (decisionSignal?.aborted) abort();
        else decisionSignal?.addEventListener('abort', abort, { once: true });
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
          role: 'assistant',
          content:
            truncatedBudget || earlyLengthStop ? '[response cut off before a choice was submitted]' : rawResponse,
        });
        messages.push({
          role: 'user',
          content: truncatedBudget
            ? `Your previous response ran past its ${truncatedBudget}-token budget before submitting a choice. Reply with the required JSON immediately, keeping reasoning brief enough to finish inside the budget.`
            : earlyLengthStop
              ? `The provider stopped your previous response for length after ${earlyLengthStop.outputTokens} output tokens, below the requested ${earlyLengthStop.requestedMaxTokens}-token cap. Reply with the required JSON immediately.`
              : `Your previous response was invalid. Error: ${error}. Reply again following the required JSON format.`,
        });
      }
      rawResponse = '';
      truncatedBudget = 0;
      earlyLengthStop = undefined;
      const maxToolRounds = deadline === undefined ? UNTIMED_MAX_TOOL_ROUNDS : DECISION_MAX_TOOL_ROUNDS;
      let cutoffAnnounced = false;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        if (generation !== this.generation) throw new DecisionAbandonedError();
        if (request.timer && remainingMs() < 2000) return failDecision(new Error('turn time exhausted'));
        const finalRound = round === maxToolRounds || remainingMs() < forceCommitMs;
        if (finalRound && !cutoffAnnounced) {
          cutoffAnnounced = true;
          messages.push({
            role: 'user',
            content:
              'Tool budget for this decision is exhausted; further tool calls will not be executed. Submit your choice now in the required JSON format.',
          });
        }
        maxTokens = Math.max(tokenFloor, decisionTokenBudget(remainingMs(), pace()));
        let completion: Completion;
        try {
          completion = await this.completeOnce(
            messages,
            {
              maxTokens,
              tools: this.decisionTools,
              toolChoice: finalRound ? 'none' : 'auto',
            },
            this.briefed(battleSystemPrompt({ sheets: this.sheets, timed: Boolean(request.timer) })),
            decisionSignal,
          );
        } catch (caught) {
          if (generation !== this.generation) throw new DecisionAbandonedError();
          if (request.timer && !this.options.signal?.aborted) return failDecision(caught);
          throw caught;
        }
        for (const [key, value] of Object.entries(completion.usage)) {
          usage[key] = (usage[key] ?? 0) + (key === 'cost' ? value : Math.trunc(value));
        }
        if (completion.provider) upstreamProviders.add(completion.provider);
        if (completion.reasoning) reasoningParts.push(completion.reasoning);
        if (completion.toolCalls.length && !finalRound) {
          toolRounds += 1;
          const standardMax =
            deadline === undefined ? UNTIMED_MAX_STANDARD_TOOL_CALLS : DECISION_MAX_STANDARD_TOOL_CALLS;
          const orderMax = deadline === undefined ? UNTIMED_MAX_ORDER_TOOL_CALLS : DECISION_MAX_ORDER_TOOL_CALLS;
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
        else if (completion.finishReason === 'length')
          earlyLengthStop = { outputTokens, requestedMaxTokens: maxTokens };
        if (!completion.text && !completion.toolCalls.length && truncatedBudget) break;
        rawResponse = completion.text;
        /** Some reasoning models via gateways finish with every token in the reasoning channel and an
         * empty text field; the decision they wrote is salvaged rather than bought again on a retry. */
        if (!rawResponse && !completion.toolCalls.length && completion.reasoning) {
          try {
            LLMEngine.extractChoices(completion.reasoning, menus, this.notebook);
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
            : 'empty response';
        failedAttempts.push({ response: '', error });
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
        parsed = LLMEngine.extractChoices(rawResponse, menus, this.notebook);
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
            'the response wrote tool-call markup as plain text, which nothing executes. Call tools through the API tool interface or reply with the required JSON object';
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
      const reasoning = reasoningParts.join('\n\n').trim();
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
      runSignal && operationSignal ? AbortSignal.any([runSignal, operationSignal]) : (runSignal ?? operationSignal);
    const startedAt = performance.now();
    const completion = await this.provider.complete(system, messages, signal ? { ...options, signal } : options);
    this.observedTokensPerSecond = updatedPace(
      this.observedTokensPerSecond,
      completion.usage.output_tokens ?? 0,
      performance.now() - startedAt,
    );
    return completion;
  }

  protected override submissionSource(automatic: boolean, substitution?: ChoiceSubstitution): SubmissionSource {
    return substitution || this.pending?.fallback ? 'model-default' : automatic ? 'automatic' : 'model';
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
    const evidence = automatic ? noStageEvidence(this.notebook) : (pending.evidence ?? noStageEvidence(this.notebook));
    const rationale = automatic
      ? 'Automatic: only one legal joint action.'
      : evidence.rationale || 'No rationale supplied.';
    const evidenceSupplied = {
      rationale: evidence.supplied.rationale,
      notebook_update: evidence.supplied.notebookUpdate,
    };
    if (!automatic) {
      if (!pending.fallback) this.consecutiveDecisionFailures = 0;
      this.notebook = evidence.notebook;
      this.decisions += 1;
      if (pending.fallback) this.fallbacks += 1;
      this.parseFailureCount += pending.parseFailures ?? 0;
      this.costTotal += pending.usage?.cost ?? 0;
      this.reasoningTotal += Math.trunc(pending.usage?.reasoning_tokens ?? 0);
      if (substitution) this.substitutedActions += 1;
    }
    const action = request.teamPreview ? `team ${parts.join('')}` : parts.join(', ');
    this.rememberTurnDetail(`Decision: ${action}`);
    const phase = decisionPhase(request);
    const requestDigest = this.requestDigest(request, menus, phase);
    const selection = choices.map((choice, slot) => menus[slot]?.[choice]?.label ?? parts[slot] ?? 'pass');
    if (!automatic) this.recordTendencies(phase, menus, choices, parts, action, pending.toolCalls ?? []);
    const timer = pending.timer
      ? { turn_seconds: pending.timer.turnSeconds ?? null, bank_seconds: pending.timer.seconds ?? null }
      : null;
    const substituted = substitution
      ? { requested_choices: substitution.requested, substitution_reason: substitution.reason }
      : {};
    this.appendContext('decision', {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      phase,
      action,
      rationale,
      notebook: this.notebook,
      menus: this.contextMenus(menus),
      evidence_supplied: evidenceSupplied,
      automatic,
      fallback: pending.fallback ?? false,
    });
    const submissionEvidence = {
      kind: 'decision',
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
      kind: 'decision_trace',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      phase,
      prompt: pending.prompt ?? '',
      menus: menus.map((menu) => menu.map((item) => item.label)),
      choices,
      parts,
      ...substituted,
      raw_response: pending.rawResponse ?? '',
      reasoning: pending.reasoning ?? null,
      usage: pending.usage ?? {},
      latency_ms: pending.latencyMs ?? 0,
      timer,
      parse_failures: pending.parseFailures ?? 0,
      tool_rounds: pending.toolRounds ?? 0,
      max_tokens: pending.maxTokens ?? null,
      tokens_per_second: this.observedTokensPerSecond ? Math.round(this.observedTokensPerSecond) : null,
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
    const stats: DecisionStats = {
      decisions: this.decisions,
      fallbacks: this.fallbacks,
      reflections: this.reflections,
      reflection_fallbacks: this.reflectionFallbacks,
      move_selections: this.moveSelections,
      switch_selections: this.switchSelections,
      protect_selections: this.protectSelections,
      consecutive_protect_selections: this.consecutiveProtectSelections,
      ally_target_selections: this.allyTargetSelections,
      spread_move_selections: this.spreadMoveSelections,
      mega_selections: this.megaSelections,
      tool_lookups: this.toolLookups,
      repeated_joint_actions: this.repeatedJointActions,
      team_previews: this.teamPreviews,
      bring_changes: this.bringChanges,
      lead_changes: this.leadChanges,
      substituted_actions: this.substitutedActions,
      abandoned_decisions: this.abandonedDecisions,
      parse_failures: this.parseFailureCount,
    };
    if (this.reasoningTotal > 0) stats.reasoning_tokens = this.reasoningTotal;
    if (this.costTotal > 0) stats.cost = Math.round(this.costTotal * 1e6) / 1e6;
    return stats;
  }

  private recordTendencies(
    phase: string,
    menus: SlotMenu[],
    choices: number[],
    parts: string[],
    action: string,
    toolCalls: ToolTrace[],
  ): void {
    this.toolLookups += toolCalls.length;
    if (phase === 'team_preview') {
      this.teamPreviews += 1;
      const brought = [...parts].sort().join(',');
      const leads = parts.slice(0, 2).sort().join(',');
      if (this.previousPreview) {
        if (this.previousPreview.brought !== brought) this.bringChanges += 1;
        if (this.previousPreview.leads !== leads) this.leadChanges += 1;
      }
      this.previousPreview = { brought, leads };
    }
    for (const [slot, part] of parts.entries()) {
      const item = menus[slot]?.[choices[slot]!];
      if (item?.kind === 'move') this.moveSelections += 1;
      if (item?.kind === 'switch') this.switchSelections += 1;
      if (/ -[12](?:\s|$)/.test(part)) this.allyTargetSelections += 1;
      if (item?.kind === 'move' && /\((?:both foes|your side|all adjacent|spread)/.test(item.label))
        this.spreadMoveSelections += 1;
      if (part.endsWith(' mega')) this.megaSelections += 1;

      if (phase !== 'turn') continue;
      const activeKey = this.state.sides[this.pid].active[String.fromCharCode('a'.charCodeAt(0) + slot)];
      if (!activeKey) continue;
      const protect = item?.kind === 'move' && /^Protect(?:\b|\s)/i.test(item.label);
      const previous = this.previousProtect.get(activeKey);
      if (protect) {
        this.protectSelections += 1;
        if (previous?.gameId === this.gameId && previous.turn === this.state.turn - 1)
          this.consecutiveProtectSelections += 1;
        this.previousProtect.set(activeKey, { gameId: this.gameId, turn: this.state.turn });
      } else this.previousProtect.delete(activeKey);
    }
    if (phase === 'turn') {
      if (
        this.previousTurnAction?.gameId === this.gameId &&
        this.previousTurnAction.turn === this.state.turn - 1 &&
        this.previousTurnAction.action === action
      )
        this.repeatedJointActions += 1;
      this.previousTurnAction = { gameId: this.gameId, turn: this.state.turn, action };
    } else this.previousTurnAction = undefined;
  }

  private notebookUpdate(): JsonObject {
    if (this.notebook === this.loggedNotebook) return {};
    this.loggedNotebook = this.notebook;
    return { notebook: this.notebook };
  }

  protected override menuHints(request: BattleRequest): MenuHints | undefined {
    if (request.teamPreview || !request.active) return undefined;
    const names: TargetNames = { foe: {}, ally: {} };
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    for (const [group, pid] of [
      ['ally', this.pid],
      ['foe', foe],
    ] as const) {
      const side = this.state.sides[pid];
      for (const [number, slot] of [
        [1, 'a'],
        [2, 'b'],
      ] as const) {
        const key = side.active[slot];
        const mon = key ? side.mons.get(key) : undefined;
        if (mon && !mon.fainted) names[group][number] = mon.species;
      }
    }
    if (!Object.keys(names.ally).length) {
      for (const [index, mon] of (request.side?.pokemon ?? []).filter((pokemon) => pokemon.active).entries()) {
        names.ally[index + 1] = BattleState.requestName(mon);
      }
    }
    return {
      names,
      protectReduced: this.state.protectReducedSlots(),
      moveAnnotation: (_slot, move, targetSide, targetNumber) =>
        this.state.moveAnnotation(move, targetSide, targetNumber),
    };
  }

  static extractChoices(response: string, menus: SlotMenu[], currentNotebook = ''): ParsedDecision {
    const objects = jsonObjects(response, true).filter((value) => 'choices' in value || 'choice' in value);
    if (!objects.length) throw new Error('no JSON object with a choices key');
    let failure: unknown;
    for (const object of objects.reverse()) {
      try {
        return LLMEngine.parseDecision(object, menus, currentNotebook);
      } catch (caught) {
        failure ??= caught;
      }
    }
    throw failure;
  }

  private static parseDecision(object: JsonObject, menus: SlotMenu[], currentNotebook: string): ParsedDecision {
    const rawChoices = object.choices ?? (menus.length === 1 ? [object.choice] : undefined);
    if (!Array.isArray(rawChoices) || rawChoices.length !== menus.length)
      throw new Error(`choices must be an array of exactly ${menus.length} integers`);
    const choices = rawChoices.map((choice, slot) => {
      const parsedChoice = z.number().int().safeParse(choice);
      if (!parsedChoice.success) throw new Error(`choice for slot ${slot + 1} must be an integer`);
      const index = parsedChoice.data;
      if (index < 0 || index >= menus[slot]!.length)
        throw new Error(`choice for slot ${slot + 1} must be between 0 and ${menus[slot]!.length - 1}`);
      return index;
    });
    const evidence = normalizeStageEvidence(object.rationale, object.notebook, {
      currentNotebook,
      rationaleLimit: DECISION_RATIONALE_LIMIT,
      notebookLimit: DECISION_NOTE_LIMIT,
    });
    const decision: ParsedDecision = { choices, evidence };
    if (evidence.supplied.rationale) decision.rationale = evidence.rationale;
    if (evidence.supplied.notebookUpdate) decision.notebook = evidence.notebook;
    return decision;
  }

  private async reflect(context: GameEnd, result: string): Promise<void> {
    const seriesOver = context.gameNumber >= 3 || Math.max(this.seriesScore.p1, this.seriesScore.p2) >= 2;
    const mine = this.seriesScore[this.pid];
    const theirs = this.seriesScore[this.pid === 'p1' ? 'p2' : 'p1'];
    const seriesResult = mine > theirs ? 'won' : mine < theirs ? 'lost' : 'drew';
    const draftRoster = seriesOver ? this.options.draftRoster : undefined;
    const prompt = [
      `Series ${this.seriesId ?? '?'}; game ${context.gameNumber}; result: ${result}; series score ${this.scoreText()}.`,
      ...(seriesOver ? [`The series is over: you ${seriesResult} it ${mine}-${theirs} (you are ${this.pid}).`] : []),
      ...(draftRoster ? [`Your full draft roster this season: ${draftRoster}`] : []),
      `Turns: ${String(context.outcome.turns ?? '?')}. Decision errors: ${String(context.outcome.errors ?? 0)}. Model-choice defaults: ${String(context.outcome.model_choice_fallbacks ?? 0)}. Simulator substitutions: ${String(context.outcome.simulator_substitutions ?? 0)}. Timer autodefaults: ${String(context.outcome.timer_autodefaults ?? 0)}.`,
      '',
      'Final authoritative state:',
      this.state.render({}),
      '',
      'Compact private battle timeline:',
      ...this.transcript,
      '',
      `Current private notebook: ${this.notebook || '(empty)'}`,
      '',
      'Return the required concise game review and updated notebook.',
    ].join('\n');
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
    const usage: Record<string, number> = {};
    let rawResponse = '';
    let parsed: { summary: string; adjustment: string; notebook: string } | undefined;
    let error: string | undefined;
    let failureSummary: string | undefined;
    let failureKind: string | undefined;
    try {
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        const completion = await this.completeOnce(
          messages,
          { maxTokens: REFLECTION_MAX_TOKENS },
          this.briefed(
            draftRoster ? DRAFT_SERIES_REFLECTION_SYSTEM : seriesOver ? SERIES_REFLECTION_SYSTEM : REFLECTION_SYSTEM,
          ),
        );
        for (const [key, value] of Object.entries(completion.usage)) {
          usage[key] = (usage[key] ?? 0) + (key === 'cost' ? value : Math.trunc(value));
        }
        rawResponse = completion.text;
        if (!rawResponse.trim() && completion.reasoning) {
          try {
            LLMEngine.extractReflection(completion.reasoning);
            rawResponse = completion.reasoning;
          } catch {}
        }
        try {
          parsed = LLMEngine.extractReflection(rawResponse);
          error = undefined;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          if (attempt === 0) {
            messages.push({ role: 'assistant', content: rawResponse || '[the reply contained no visible text]' });
            messages.push({
              role: 'user',
              content: `Invalid review: ${error}. Reply with exactly the required JSON object.`,
            });
          }
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      const failure = classifyProviderFailure(caught, this.spec);
      failureSummary = failure.summary;
      failureKind = failure.kind;
    }
    const fallback = !parsed;
    const review =
      parsed ??
      ({
        summary: `Game ${result}; model reflection unavailable (${failureSummary ?? error ?? 'unparseable review'}).`,
        adjustment: 'Retain the existing series plan and reassess from the next team preview.',
        notebook: this.notebook,
      } satisfies { summary: string; adjustment: string; notebook: string });
    this.reflections += 1;
    if (fallback) this.reflectionFallbacks += 1;
    this.costTotal += usage.cost ?? 0;
    this.reasoningTotal += Math.trunc(usage.reasoning_tokens ?? 0);
    this.notebook = review.notebook;
    this.remember(`Game review: ${review.summary} Next-game adjustment: ${review.adjustment}`);
    this.appendContext('reflection', {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      result,
      series_over: seriesOver,
      summary: review.summary,
      adjustment: review.adjustment,
      notebook: this.notebook,
      fallback,
    });
    const reflectionLog = {
      kind: 'game_reflection',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      pid: this.pid,
      result,
      series_over: seriesOver,
      summary: review.summary,
      adjustment: review.adjustment,
      ...this.notebookUpdate(),
      total_tokens: totalTokens(usage),
      ...reasoningField(usage),
      fallback,
      error: error ?? null,
      error_summary: failureSummary || undefined,
      failure_kind: failureKind || undefined,
    };
    const reflectionTrace = {
      kind: 'reflection_trace',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      pid: this.pid,
      series_over: seriesOver,
      prompt,
      raw_response: rawResponse,
      usage,
      fallback,
      error: error ?? null,
      error_summary: failureSummary || undefined,
      failure_kind: failureKind || undefined,
    };
    this.writeLog(this.options.decisionLog, reflectionLog);
    this.writeLog(this.options.traceLog, reflectionTrace);
  }

  private static extractReflection(response: string): Reflection {
    const object = jsonObjects(response)
      .filter((value) => 'summary' in value || 'adjustment' in value)
      .at(-1);
    if (!object) throw new Error('no JSON game review found');
    const parsed = reflectionSchema.safeParse(object);
    if (!parsed.success) throw new Error('review must contain string summary, adjustment, and notebook fields');
    return {
      summary: clip(parsed.data.summary, DECISION_RATIONALE_LIMIT),
      adjustment: clip(parsed.data.adjustment, DECISION_RATIONALE_LIMIT),
      notebook: clip(parsed.data.notebook, DECISION_NOTE_LIMIT),
    };
  }

  private remember(value: string): void {
    const lines = value.split('\n').filter(Boolean);
    if (!lines.length) return;
    this.transcript.push(...lines);
    this.trimTranscript();
  }

  private rememberTurnDetail(value: string): void {
    const detail = value.trim().replace(/\.$/, '');
    if (!detail) return;
    let index = this.transcript.findLastIndex((line) => /^Turn \d+:/.test(line));
    if (index < 0) index = this.transcript.findLastIndex((line) => line.startsWith('Setup:'));
    if (index < 0) {
      this.remember(`Setup: ${detail}.`);
      return;
    }
    const current = this.transcript[index]!;
    const base = current.endsWith('.') ? current.slice(0, -1) : current;
    this.transcript[index] = `${base}${base.endsWith(':') ? ' ' : '; '}${detail}.`;
    this.trimTranscript();
  }

  private trimTranscript(): void {
    let length = this.transcript.reduce((total, line) => total + line.length, this.transcript.length - 1);
    let dropped = false;
    while (length > TRANSCRIPT_CHARACTER_LIMIT && this.transcript.length > 1) {
      length -= this.transcript.shift()!.length + 1;
      dropped = true;
    }
    if (length > TRANSCRIPT_CHARACTER_LIMIT) {
      const line = this.transcript[0]!;
      const prefix = /^(?:Turn \d+|Setup):/.exec(line)?.[0] ?? '';
      const retained = Math.max(0, TRANSCRIPT_CHARACTER_LIMIT - prefix.length - 2);
      this.transcript[0] = `${prefix} …${line.slice(-retained)}`;
      dropped = true;
    }
    if (dropped && this.transcript[0] !== TRANSCRIPT_CLIP_MARKER) this.transcript.unshift(TRANSCRIPT_CLIP_MARKER);
  }

  private rememberEvents(lines: string[]): void {
    for (const event of summarizeBattleEvents(lines, this.pid)) {
      const turn = /^Turn (\d+) begins\.$/.exec(event);
      if (turn) this.remember(`Turn ${turn[1]}:`);
      else this.rememberTurnDetail(event);
    }
  }

  private appendObservation(lines: string[]): void {
    if (!lines.length) return;
    this.appendContext('observation', {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      lines,
    });
  }

  private appendRequestObservation(request: BattleRequest): void {
    this.appendContext('observation', {
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      event: 'battle_request',
      request,
    });
  }

  private contextMenus(menus: SlotMenu[]) {
    return menus.map((menu) => menu.map(({ label, part, kind }) => ({ label, part, kind })));
  }

  private appendContext(kind: AgentContextKind, payload: JsonObject): void {
    this.fullContext.append(kind, { ...payload, attempt_id: this.contextAttempt });
  }

  private scoreText(): string {
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    return `you ${this.seriesScore[this.pid]}, opponent ${this.seriesScore[foe]}`;
  }
}

function jsonObjects(input: string, preferOuterDecision = false): JsonObject[] {
  const matches: Array<{ value: JsonObject; start: number; end: number }> = [];
  for (let start = input.indexOf('{'); start >= 0; start = input.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        try {
          const value: JsonValue = JSON.parse(input.slice(start, index + 1));
          if (isRecord(value)) matches.push({ value, start, end: index });
        } catch {}
        break;
      }
    }
  }
  if (!preferOuterDecision) return matches.map(({ value }) => value);
  return matches
    .filter(
      (match) =>
        !matches.some(
          (parent) =>
            parent.start < match.start &&
            parent.end >= match.end &&
            ('choices' in parent.value || 'choice' in parent.value) &&
            suppliedDecisionEvidenceSchema.safeParse(parent.value).success,
        ),
    )
    .map(({ value }) => value);
}
