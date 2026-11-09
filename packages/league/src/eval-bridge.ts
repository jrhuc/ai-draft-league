import { createHash } from "node:crypto";
import readline from "node:readline";
import { BaseEngine, type ChoiceSubstitution, RandomEngine } from "./battle-agent.js";
import { summarizeBattleEvents } from "./battle-transcript.js";
import type { SlotMenu } from "./choices.js";
import { battleMenuHints } from "./llm-engine-menu.js";
import {
  ACTION_ORDER_TOOL,
  BATTLE_HISTORY_TOOL,
  decisionPhase,
  decisionTools,
} from "./llm-engine-support.js";
import { auditGame, type GameMechanicsAudit } from "./monitor-mechanics.js";
import { defaultPsDir } from "./paths.js";
import { PerspectiveState } from "./perspective-state.js";
import { type Rng, seededRng } from "./random.js";
import { battleSystemPrompt, renderDecision, type SheetPolicy } from "./prompts.js";
import { ShowdownReference } from "./reference.js";
import { harnessCommit, showdownCommit } from "./showdown.js";
import { SimBattle } from "./sim.js";
import { activeEntry } from "./state-tools.js";
import { loadPool } from "./teams.js";
import type {
  ActionSubmission,
  AgentContext,
  BattleAgent,
  BattleOutcome,
  BattleRequest,
  JsonObject,
  JsonValue,
  Pid,
  SubmissionContext,
  SubmissionOutcome,
  SubmissionSource,
  ToolDefinition,
} from "./types.js";
import { asRecord, count, text } from "./value.js";

export interface DecisionEvent {
  kind: "decision";
  pid: Pid;
  decision: number;
  turn: number;
  phase: "team_preview" | "turn" | "forced_switch";
  prompt: string;
  slot_names: string[];
  menus: string[][];
  error: string | null;
  request: BattleRequest;
}

export interface EndEvent {
  kind: "end";
  outcome: BridgeOutcome;
}

export type BridgeEvent = DecisionEvent | EndEvent;

export interface BridgeOutcome {
  winner: string | null;
  turns: number;
  log: string[];
  log_sha256: string;
  errors: Record<Pid, number>;
  simulator_substitutions: Record<Pid, number>;
  submissions: Record<Pid, SubmissionRecord[]>;
}

export interface SubmissionRecord {
  decision: number;
  turn: number;
  phase: DecisionEvent["phase"];
  choice: string;
  source: SubmissionSource;
  outcome: SubmissionOutcome;
  showdown_error: string | null;
  tool_calls: number;
}

interface PendingDecision {
  event: DecisionEvent;
  menus: SlotMenu[];
  resolve: (choices: number[]) => void;
}

type Waiter = (event: BridgeEvent) => void;

class ExternalSeat extends BaseEngine {
  readonly state: PerspectiveState;
  readonly traceRows: JsonObject[] = [];
  readonly submissions: SubmissionRecord[] = [];
  pending: PendingDecision | undefined;
  private observations: string[] = [];
  private calls: JsonObject[] = [];
  private decisions = 0;
  private defaulted = false;
  private request: BattleRequest | undefined;
  private readonly bySubmission = new Map<string, SubmissionRecord>();

  constructor(
    pid: Pid,
    private readonly reference: ShowdownReference,
    private readonly announce: (event: BridgeEvent) => void,
  ) {
    super(pid);
    this.state = new PerspectiveState(pid);
  }

  override observe(lines: string[]): void {
    this.state.feed(lines);
    this.observations.push(...lines);
  }

  protected override menuHints(request: BattleRequest) {
    return battleMenuHints(this.state, this.pid, request);
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    this.observe(context.povLines);
    this.request = request;
    try {
      return await super.act(request, context);
    } finally {
      this.request = undefined;
    }
  }

  protected override decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> {
    const rendered = this.state.render(request, (mon) => this.reference.describeCompact(mon));
    const speed = request.teamPreview ? "" : this.state.renderEffectiveSpeeds(this.reference);
    const sides = this.state.activeMatchupSides(this.reference);
    const slotNames = menus.map((_, slot) => this.state.slotName(slot, request));
    const prompt = renderDecision({
      state: speed ? `${rendered}\n${speed}` : rendered,
      slotNames,
      menus,
      transcript: summarizeBattleEvents(this.observations, this.pid),
      memory: { teamPlaybook: "", seriesMemory: "", nextGamePlan: "" },
      initial: false,
      matchups: this.reference.renderActiveMatchups(
        [...sides.allies, ...sides.foes],
        [...sides.foes, ...sides.allies],
        this.state.weather?.name ?? "",
      ),
    });
    this.observations = [];
    this.calls = [];
    this.defaulted = false;
    const event: DecisionEvent = {
      kind: "decision",
      pid: this.pid,
      decision: ++this.decisions,
      turn: this.state.turn,
      phase: decisionPhase(request),
      prompt,
      slot_names: slotNames,
      menus: menus.map((menu) => menu.map((item) => item.label)),
      error: context.error ?? null,
      request,
    };
    return new Promise<number[]>((resolve) => {
      this.pending = { event, menus, resolve };
      this.announce(event);
    });
  }

  call(name: string, input: JsonObject): string {
    const stateTool = name === ACTION_ORDER_TOOL.name || name === "estimate_damage";
    if (stateTool && !this.request) throw new Error("battle state tools need a pending decision");
    const result = !stateTool
      ? this.reference.lookup(name, input)
      : name === ACTION_ORDER_TOOL.name
        ? this.state.compareActionOrder(input, this.reference)
        : this.state.estimateDamage(input, this.request!, this.reference);
    this.calls.push({ name, arguments: input, result });
    return result;
  }

  decide(input: { choices: number[] } | "default"): string {
    const pending = this.pending;
    if (!pending) throw new Error(`${this.pid} has no pending decision`);
    let choices: number[];
    let parts: string[];
    if (input === "default") {
      [choices, parts] = BaseEngine.defaults(pending.menus);
      this.defaulted = true;
    } else {
      choices = input.choices;
      if (choices.length !== pending.menus.length)
        throw new Error(
          `choices must hold exactly ${pending.menus.length} entries, one per displayed slot in slot order`,
        );
      parts = BaseEngine.parts(pending.menus, choices);
    }
    this.pending = undefined;
    this.traceRows.push({
      kind: "decision_trace",
      pid: this.pid,
      turn: pending.event.turn,
      phase: pending.event.phase,
      tool_calls: this.calls,
    });
    pending.resolve(choices);
    return parts.join(", ");
  }

  protected override submissionSource(
    automatic: boolean,
    substitution?: ChoiceSubstitution,
  ): SubmissionSource {
    if (substitution || this.defaulted) return "model-default";
    return automatic ? "automatic" : "model";
  }

  protected override actionSubmitted(
    request: BattleRequest,
    context: AgentContext,
    menus: SlotMenu[],
    choices: number[],
    parts: string[],
    automatic: boolean,
    submission: ActionSubmission,
    substitution?: ChoiceSubstitution,
  ): void {
    super.actionSubmitted(
      request,
      context,
      menus,
      choices,
      parts,
      automatic,
      submission,
      substitution,
    );
    const record: SubmissionRecord = {
      decision: this.decisions,
      turn: this.state.turn,
      phase: decisionPhase(request),
      choice: submission.choice,
      source: submission.source,
      outcome: "accepted",
      showdown_error: null,
      tool_calls: this.calls.length,
    };
    this.bySubmission.set(submission.submissionId, record);
    this.submissions.push(record);
  }

  override resolveSubmission(
    submission: ActionSubmission,
    outcome: SubmissionOutcome,
    showdownError?: string,
  ): void {
    super.resolveSubmission(submission, outcome, showdownError);
    const record = this.bySubmission.get(submission.submissionId);
    if (!record) return;
    record.outcome = outcome;
    record.showdown_error = showdownError ?? null;
  }
}

const DAMAGE_RANGE = /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)% of maximum HP/;

function hpPercent(hp: string | undefined): number {
  const match = /^(\d+)\/(\d+)/.exec(hp ?? "");
  if (!match || !Number(match[2])) return hp?.endsWith("fnt") ? 0 : 100;
  return (Number(match[1]) * 100) / Number(match[2]);
}

/**
 * A fixed opponent that plays the largest expected damage the harness's own calculator projects
 * for each slot, preferring a hit that finishes its target. It gives a focal model real pressure
 * without a second model in the loop, and it is deterministic for a seed.
 */
export class GreedySeat extends BaseEngine {
  readonly state: PerspectiveState;
  private readonly random: Rng;

  constructor(
    pid: Pid,
    private readonly reference: ShowdownReference,
    seed: number | string,
  ) {
    super(pid);
    this.state = new PerspectiveState(pid);
    this.random = seededRng(seed);
  }

  override observe(lines: string[]): void {
    this.state.feed(lines);
  }

  protected override menuHints(request: BattleRequest) {
    return battleMenuHints(this.state, this.pid, request);
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    this.observe(context.povLines);
    return super.act(request, context);
  }

  protected override decideJoint(menus: SlotMenu[], request: BattleRequest): number[] {
    if (request.teamPreview) return this.preview(menus);
    const choices: number[] = [];
    const parts: string[] = [];
    for (const [slot, menu] of menus.entries()) {
      const candidates = BaseEngine.remaining(menu, parts);
      let best: SlotMenu[number] | undefined;
      let bestScore = -Infinity;
      for (const item of candidates) {
        const score = this.score(item, slot, request);
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (!best) {
        choices.push(-1);
        parts.push("pass");
        continue;
      }
      choices.push(menu.indexOf(best));
      parts.push(best.part);
    }
    return choices;
  }

  private preview(menus: SlotMenu[]): number[] {
    const order = [...Array(menus[0]?.length ?? 0).keys()];
    for (let index = order.length - 1; index > 0; index--) {
      const swap = Math.floor(this.random() * (index + 1));
      [order[index], order[swap]] = [order[swap]!, order[index]!];
    }
    return menus.map((_, slot) => order[slot] ?? 0);
  }

  private score(item: SlotMenu[number], slot: number, request: BattleRequest): number {
    if (item.kind === "forfeit") return -Infinity;
    if (item.kind === "pass") return -2;
    if (item.kind === "switch") return -1;
    const match = /^move (\d+)(?: ([+-])(\d))?( mega)?$/.exec(item.part);
    const move = match ? request.active?.[slot]?.moves[Number(match[1]) - 1] : undefined;
    if (!match || !move) return 0;
    if (match[2] === "-") return 0;
    const attacker = this.state.slotName(slot, request);
    const foe: Pid = this.pid === "p1" ? "p2" : "p1";
    const mega = match[4] !== undefined;
    const damage = (target: number): number => {
      const defender = activeEntry(this.state, foe, target);
      if (!defender || defender.fainted) return 0;
      const result = this.state.estimateDamage(
        { attacker, defender: defender.species, move: move.move, attacker_mega: mega },
        request,
        this.reference,
      );
      const range = DAMAGE_RANGE.exec(result);
      if (!range) return 0;
      const mid = (Number(range[1]) + Number(range[2])) / 2;
      const remaining = hpPercent(defender.hp);
      return Math.min(mid, remaining) + (mid >= remaining ? 25 : 0);
    };
    const bonus = mega ? 0.5 : 0;
    if (match[2] === "+") return damage(Number(match[3])) + bonus;
    const target = move.target ?? "";
    if (target === "allAdjacentFoes" || target === "allAdjacent" || target === "all")
      return damage(1) + damage(2) + bonus;
    return 0;
  }
}

/** Replays a recorded game's choices for one seat, keeping the wrapped seat's view of the battle
 * current, then hands every later decision to that seat. */
class ScriptedSeat implements BattleAgent {
  private cursor = 0;
  private readonly scripted = new Set<string>();

  constructor(
    private readonly inner: BattleAgent,
    private readonly script: readonly string[],
  ) {}

  async submit(
    request: BattleRequest,
    context: SubmissionContext,
  ): Promise<ActionSubmission | null> {
    const choice = this.script[this.cursor];
    if (choice === undefined) return this.inner.submit(request, context);
    this.cursor += 1;
    await this.inner.observe(context.povLines);
    this.scripted.add(context.submissionId);
    return { submissionId: context.submissionId, choice, source: "automatic" };
  }

  resolveSubmission(
    submission: ActionSubmission,
    outcome: SubmissionOutcome,
    showdownError?: string,
  ): void {
    if (!this.scripted.delete(submission.submissionId)) {
      this.inner.resolveSubmission(submission, outcome, showdownError);
      return;
    }
    if (outcome === "rejected")
      throw new Error(`recorded choice ${submission.choice} was rejected: ${showdownError ?? ""}`);
  }

  observe(lines: string[]): Promise<void> | void {
    return this.inner.observe(lines);
  }

  abandonDecision(): void {
    this.inner.abandonDecision?.();
  }
}

export type OpponentPolicy = "random" | "greedy";

export interface StartInput {
  format: string;
  seed: number | [number, number, number, number];
  p1: { name: string; team: string };
  p2: { name: string; team: string };
  external: Pid[];
  opponent?: OpponentPolicy;
  opponent_seed?: number;
  script?: Record<Pid, string[]>;
}

/**
 * One battle, driven from outside the process: every decision an external seat must make is
 * published as an event, and the game only advances when that seat submits. Tool lookups run
 * against the same perspective state the league's own engine would see.
 */
export class EvalBridge {
  private readonly reference: ShowdownReference;
  private readonly seats = new Map<Pid, ExternalSeat>();
  private readonly queue: BridgeEvent[] = [];
  private waiter: Waiter | undefined;
  private game: Promise<BattleOutcome> | undefined;
  private outcome: BridgeOutcome | undefined;

  constructor(
    readonly format: string,
    readonly sheets: SheetPolicy = "open",
    readonly psDir = defaultPsDir(),
  ) {
    this.reference = new ShowdownReference(format, psDir);
  }

  hello(): JsonObject {
    return {
      format: this.format,
      sheets: this.sheets,
      showdown_commit: showdownCommit(this.psDir),
      harness_commit: harnessCommit(),
    };
  }

  tools(): ToolDefinition[] {
    return decisionTools(this.sheets).filter((tool) => tool.name !== BATTLE_HISTORY_TOOL.name);
  }

  system(): string {
    return battleSystemPrompt({ sheets: this.sheets, timed: false });
  }

  pool(name: string): JsonObject {
    const pool = loadPool(name);
    return {
      id: pool.id,
      format: pool.format,
      teams: pool.teams.map((team) => ({ id: team.id, packed: team.packed })),
    };
  }

  async start(input: StartInput): Promise<BridgeEvent> {
    if (this.game) throw new Error("a game is already running");
    const announce = (event: BridgeEvent) => this.push(event);
    const seatFor = (pid: Pid): BattleAgent => {
      if (input.external.includes(pid)) {
        const seat = new ExternalSeat(pid, this.reference, announce);
        this.seats.set(pid, seat);
        return seat;
      }
      const seed = input.opponent_seed ?? 0;
      return input.opponent === "greedy"
        ? new GreedySeat(pid, this.reference, seed)
        : new RandomEngine(pid, seed);
    };
    const scripted = (pid: Pid): BattleAgent =>
      input.script ? new ScriptedSeat(seatFor(pid), input.script[pid]) : seatFor(pid);
    const agents = { p1: scripted("p1"), p2: scripted("p2") };
    if (!this.seats.size) throw new Error("at least one seat must be external");
    const battle = new SimBattle(
      input.format,
      { p1: input.p1, p2: input.p2 },
      input.seed,
      this.psDir,
    );
    this.game = battle.run(agents);
    this.game.then(
      (outcome) => announce({ kind: "end", outcome: this.finish(outcome) }),
      (error) => {
        for (const seat of this.seats.values()) seat.pending = undefined;
        this.push({
          kind: "end",
          outcome: this.finish({
            winner: null,
            turns: 0,
            log: [`|error|${error instanceof Error ? error.message : String(error)}`],
            pov: { p1: [], p2: [] },
            errors: { p1: 0, p2: 0 },
            simulatorSubstitutions: { p1: 0, p2: 0 },
            timerAutodefaults: { p1: 0, p2: 0 },
          }),
        });
      },
    );
    return this.next();
  }

  call(pid: Pid, name: string, input: JsonObject): string {
    return this.seat(pid).call(name, input);
  }

  async submit(
    pid: Pid,
    choices: number[] | "default",
  ): Promise<{ choice: string; next: BridgeEvent }> {
    const choice = this.seat(pid).decide(choices === "default" ? "default" : { choices });
    return { choice, next: await this.next() };
  }

  audit(): GameMechanicsAudit {
    if (!this.outcome) throw new Error("the game has not ended");
    return auditGame(1, this.outcome.log, {
      p1: this.seats.get("p1")?.traceRows ?? [],
      p2: this.seats.get("p2")?.traceRows ?? [],
    });
  }

  result(): BridgeOutcome {
    if (!this.outcome) throw new Error("the game has not ended");
    return this.outcome;
  }

  private seat(pid: Pid): ExternalSeat {
    const seat = this.seats.get(pid);
    if (!seat) throw new Error(`${pid} is not an external seat`);
    return seat;
  }

  private finish(outcome: BattleOutcome): BridgeOutcome {
    const submissions = {
      p1: this.seats.get("p1")?.submissions ?? [],
      p2: this.seats.get("p2")?.submissions ?? [],
    };
    this.outcome = {
      winner: outcome.winner,
      turns: outcome.turns,
      log: outcome.log,
      log_sha256: createHash("sha256")
        .update(`${outcome.log.join("\n")}\n`, "utf8")
        .digest("hex"),
      errors: outcome.errors,
      simulator_substitutions: outcome.simulatorSubstitutions,
      submissions,
    };
    return this.outcome;
  }

  private push(event: BridgeEvent): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(event);
    } else this.queue.push(event);
  }

  private next(): Promise<BridgeEvent> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.waiter) throw new Error("another request is already waiting for the next event");
    return new Promise<BridgeEvent>((resolve) => {
      this.waiter = resolve;
    });
  }
}

function pidOf(params: JsonObject): Pid {
  const pid = text(params.pid);
  if (pid !== "p1" && pid !== "p2") throw new Error("pid must be p1 or p2");
  return pid;
}

function seedTuple(seed: readonly JsonValue[]): [number, number, number, number] | undefined {
  const [a, b, c, d] = seed.map(Number);
  if (seed.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined)
    return undefined;
  return [a, b, c, d];
}

function startInput(params: JsonObject): StartInput {
  const seed = params.seed;
  const external = Array.isArray(params.external) ? params.external.map(String) : ["p1"];
  const player = (pid: Pid) => {
    const record = asRecord(params[pid]);
    if (!text(record.team)) throw new Error(`${pid} needs a packed team`);
    return { name: text(record.name) || pid, team: text(record.team) };
  };
  const script = params.script === undefined ? undefined : asRecord(params.script);
  const recorded = (pid: Pid) => {
    const choices = script?.[pid];
    return Array.isArray(choices) ? choices.map(String) : [];
  };
  const input: StartInput = {
    format: text(params.format),
    seed: (Array.isArray(seed) ? seedTuple(seed) : undefined) ?? count(seed),
    p1: player("p1"),
    p2: player("p2"),
    external: external.filter((pid): pid is Pid => pid === "p1" || pid === "p2"),
    opponent: text(params.opponent) === "greedy" ? "greedy" : "random",
    opponent_seed: params.opponent_seed === undefined ? undefined : count(params.opponent_seed),
  };
  if (script) input.script = { p1: recorded("p1"), p2: recorded("p2") };
  return input;
}

export async function handleBridgeRequest(
  bridge: EvalBridge | undefined,
  method: string,
  params: JsonObject,
  open: (format: string, sheets: SheetPolicy) => EvalBridge,
): Promise<{ bridge: EvalBridge | undefined; result: unknown }> {
  if (method === "open") {
    const sheets = text(params.sheets) === "closed" ? "closed" : "open";
    const opened = open(text(params.format) || "gen9championsvgc2026regmcbo3", sheets);
    return { bridge: opened, result: opened.hello() };
  }
  if (!bridge) throw new Error("call open first");
  switch (method) {
    case "hello":
      return { bridge, result: bridge.hello() };
    case "tools":
      return { bridge, result: bridge.tools() };
    case "system":
      return { bridge, result: bridge.system() };
    case "pool":
      return { bridge, result: bridge.pool(text(params.name) || "test") };
    case "start":
      return { bridge, result: await bridge.start(startInput(params)) };
    case "call":
      return {
        bridge,
        result: bridge.call(pidOf(params), text(params.name), asRecord(params.arguments)),
      };
    case "submit": {
      const choices =
        params.choices === "default"
          ? "default"
          : Array.isArray(params.choices)
            ? params.choices.map(Number)
            : undefined;
      if (!choices) throw new Error('submit needs choices (a list of menu indices) or "default"');
      return { bridge, result: await bridge.submit(pidOf(params), choices) };
    }
    case "outcome":
      return { bridge, result: bridge.result() };
    case "audit":
      return { bridge, result: bridge.audit() };
    default:
      throw new Error(`unknown method ${method}`);
  }
}

/** JSON lines over stdio: {"id","method","params"} in, {"id","result"} or {"id","error"} out. */
export async function serveBridge(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  psDir = defaultPsDir(),
): Promise<void> {
  let bridge: EvalBridge | undefined;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let id: JsonValue = null;
    try {
      const request = asRecord(JSON.parse(line));
      id = request.id ?? null;
      const handled = await handleBridgeRequest(
        bridge,
        text(request.method),
        asRecord(request.params),
        (format, sheets) => new EvalBridge(format, sheets, psDir),
      );
      bridge = handled.bridge;
      output.write(`${JSON.stringify({ id, result: handled.result })}\n`);
    } catch (error) {
      output.write(
        `${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  }
}
