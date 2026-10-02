import { createHash } from "node:crypto";
import readline from "node:readline";

import type { Battle } from "pokemon-showdown";
import { z } from "zod";

import { BaseEngine, type ChoiceSubstitution } from "./battle-agent.js";
import type { SlotMenu } from "./choices.js";
import { ExchangeAbandoned, type ExternalExchange, ExternalRunner } from "./external-runner.js";
import { LLMEngine } from "./llm-engine.js";
import { auditGame, type GameMechanicsAudit } from "./monitor-mechanics.js";
import { defaultPsDir } from "./paths.js";
import { POLICY_SPECS, policyEngine } from "./policy-engines.js";
import { ShowdownReference } from "./reference.js";
import { gameSeedSchema } from "./series-core.js";
import { harnessCommit, showdownCommit } from "./showdown.js";
import { SimBattle } from "./sim.js";
import { loadPool } from "./teams.js";
import type {
  ActionSubmission,
  AgentContext,
  BattleAgent,
  BattleOutcome,
  BattleRequest,
  JsonObject,
  Pid,
  SubmissionContext,
  SubmissionOutcome,
  SubmissionSource,
} from "./types.js";

const EXTERNAL = "external";

const playerSchema = z.object({
  name: z.string().min(1),
  team: z.string().min(1),
  seat: z.string().min(1),
});
const startSchema = z.object({
  seed: z.union([z.int().nonnegative(), gameSeedSchema]),
  p1: playerSchema,
  p2: playerSchema,
  policy_seed: z.int().nonnegative().default(0),
  script: z.object({ p1: z.array(z.string()), p2: z.array(z.string()) }).optional(),
});
export type StartInput = z.input<typeof startSchema>;

export interface BridgeOutcome {
  winner: string | null;
  turns: number;
  log: string[];
  log_sha256: string;
  errors: Record<Pid, number>;
  simulator_substitutions: Record<Pid, number>;
  decisions: Record<Pid, JsonObject[]>;
  error: string | null;
}

export type BridgeEvent =
  | { kind: "exchange"; pid: Pid; exchange: ExternalExchange }
  | { kind: "decision"; pid: Pid; row: JsonObject }
  | { kind: "end"; outcome: BridgeOutcome };

class ExternalCoach extends LLMEngine {
  private gaveUp = false;

  protected override async decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> {
    this.gaveUp = false;
    try {
      return await super.decideJoint(menus, request, context);
    } catch (error) {
      if (!(error instanceof ExchangeAbandoned)) throw error;
      this.gaveUp = true;
      return BaseEngine.defaults(menus)[0];
    }
  }

  protected override submissionSource(
    automatic: boolean,
    substitution?: ChoiceSubstitution,
  ): SubmissionSource {
    return this.gaveUp ? "model-default" : super.submissionSource(automatic, substitution);
  }
}

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

  attachSimulator(battle: () => Battle | null): void {
    this.inner.attachSimulator?.(battle);
  }
}

interface ExternalSeat {
  runner: ExternalRunner;
  decisions: JsonObject[];
  traces: JsonObject[];
}

export class EvalBridge {
  private readonly reference: ShowdownReference;
  private readonly seats = new Map<Pid, ExternalSeat>();
  private started = false;
  private outcome: BridgeOutcome | undefined;

  constructor(
    readonly format: string,
    private readonly emit: (event: BridgeEvent) => void,
    private readonly psDir = defaultPsDir(),
  ) {
    this.reference = new ShowdownReference(format, psDir);
  }

  hello(): JsonObject {
    return {
      format: this.format,
      showdown_commit: showdownCommit(this.psDir),
      harness_commit: harnessCommit(),
      seats: [EXTERNAL, ...POLICY_SPECS],
    };
  }

  pool(name: string): JsonObject {
    const pool = loadPool(name);
    return {
      id: pool.id,
      format: pool.format,
      teams: pool.teams.map((team) => ({ id: team.id, packed: team.packed })),
    };
  }

  start(input: StartInput): void {
    if (this.started) throw new Error("a game is already running");
    const game = startSchema.parse(input);
    const seat = (pid: Pid): BattleAgent => {
      const spec = game[pid].seat;
      const engine =
        spec === EXTERNAL ? this.external(pid) : policyEngine(spec, pid, game.policy_seed);
      if (!engine)
        throw new Error(`${pid} seat must be one of ${[EXTERNAL, ...POLICY_SPECS].join(", ")}`);
      engine.beginGame({ gameId: "eval", gameNumber: 1, seriesId: "eval" });
      return game.script ? new ScriptedSeat(engine, game.script[pid]) : engine;
    };
    const agents = { p1: seat("p1"), p2: seat("p2") };
    if (!this.seats.size) throw new Error("at least one seat must be external");
    this.started = true;
    const players = {
      p1: { name: game.p1.name, team: game.p1.team },
      p2: { name: game.p2.name, team: game.p2.team },
    };
    new SimBattle(this.format, players, game.seed, this.psDir, "off").run(agents).then(
      (outcome) => this.finish(outcome, null),
      (error) =>
        this.finish(
          {
            winner: null,
            turns: 0,
            log: [],
            pov: { p1: [], p2: [] },
            errors: { p1: 0, p2: 0 },
            simulatorSubstitutions: { p1: 0, p2: 0 },
            timerAutodefaults: { p1: 0, p2: 0 },
          },
          error instanceof Error ? error.message : String(error),
        ),
    );
  }

  runner(pid: Pid): ExternalRunner {
    const seat = this.seats.get(pid);
    if (!seat) throw new Error(`${pid} is not an external seat`);
    return seat.runner;
  }

  audit(): GameMechanicsAudit {
    return auditGame(1, this.result().log, {
      p1: this.seats.get("p1")?.traces ?? [],
      p2: this.seats.get("p2")?.traces ?? [],
    });
  }

  result(): BridgeOutcome {
    if (!this.outcome) throw new Error("the game has not ended");
    return this.outcome;
  }

  private external(pid: Pid): LLMEngine {
    const seat: ExternalSeat = {
      runner: new ExternalRunner((exchange) => this.emit({ kind: "exchange", pid, exchange })),
      decisions: [],
      traces: [],
    };
    this.seats.set(pid, seat);
    return new ExternalCoach(pid, EXTERNAL, {
      runAgent: seat.runner.run,
      decisionLog: (row) => {
        seat.decisions.push(row);
        this.emit({ kind: "decision", pid, row });
      },
      traceLog: seat.traces,
      format: this.format,
      psDir: this.psDir,
      reference: this.reference,
    });
  }

  private finish(outcome: BattleOutcome, error: string | null): void {
    for (const seat of this.seats.values()) seat.runner.close("the game ended");
    this.outcome = {
      winner: outcome.winner,
      turns: outcome.turns,
      log: outcome.log,
      log_sha256: createHash("sha256")
        .update(`${outcome.log.join("\n")}\n`, "utf8")
        .digest("hex"),
      errors: outcome.errors,
      simulator_substitutions: outcome.simulatorSubstitutions,
      decisions: {
        p1: this.seats.get("p1")?.decisions ?? [],
        p2: this.seats.get("p2")?.decisions ?? [],
      },
      error,
    };
    this.emit({ kind: "end", outcome: this.outcome });
  }
}

const json = z.record(z.string(), z.json());
const pid = z.enum(["p1", "p2"]);
const exchangeRef = z.object({ pid, exchange: z.int() });
const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("pool"), params: z.object({ name: z.string().default("test") }) }),
  z.object({ method: z.literal("start"), params: startSchema }),
  z.object({
    method: z.literal("tool"),
    params: exchangeRef.extend({ name: z.string(), arguments: json.default({}) }),
  }),
  z.object({
    method: z.literal("submit"),
    params: exchangeRef.extend({
      input: json,
      response: z.string().optional(),
      reasoning: z.string().optional(),
      usage: z.record(z.string(), z.number()).optional(),
    }),
  }),
  z.object({
    method: z.literal("abandon"),
    params: exchangeRef.extend({ reason: z.string().default("abandoned") }),
  }),
  z.object({ method: z.literal("audit"), params: z.object({}).default({}) }),
  z.object({ method: z.literal("outcome"), params: z.object({}).default({}) }),
]);

export function handleBridgeRequest(bridge: EvalBridge, method: string, params: JsonObject) {
  const parsed = requestSchema.safeParse({ method, params });
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  const request = parsed.data;
  switch (request.method) {
    case "pool":
      return bridge.pool(request.params.name);
    case "start":
      bridge.start(request.params);
      return { started: true };
    case "tool":
      return bridge
        .runner(request.params.pid)
        .tool(request.params.exchange, request.params.name, request.params.arguments);
    case "submit": {
      const { pid: seat, exchange, input: submitted, ...reply } = request.params;
      bridge.runner(seat).submit(exchange, submitted, reply);
      return { accepted: true };
    }
    case "abandon":
      bridge.runner(request.params.pid).abandon(request.params.exchange, request.params.reason);
      return { abandoned: true };
    case "audit":
      return bridge.audit();
    case "outcome":
      return bridge.result();
  }
}

const lineSchema = z.object({ id: z.json(), method: z.string(), params: json.default({}) });

export async function serveBridge(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  psDir = defaultPsDir(),
): Promise<void> {
  const write = <Line extends object>(line: Line) => output.write(`${JSON.stringify(line)}\n`);
  let bridge: EvalBridge | undefined;
  for await (const text of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    let id: z.infer<typeof lineSchema>["id"] = null;
    try {
      const line = lineSchema.parse(JSON.parse(text));
      id = line.id;
      if (line.method === "open") {
        const format = z.object({ format: z.string().min(1) }).parse(line.params).format;
        bridge = new EvalBridge(format, (event) => write({ event }), psDir);
        write({ id, result: bridge.hello() });
        continue;
      }
      if (!bridge) throw new Error("call open first");
      write({ id, result: handleBridgeRequest(bridge, line.method, line.params) });
    } catch (error) {
      write({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
