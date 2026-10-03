import path from "node:path";

import { z } from "zod";

import type { AgentRuntime } from "./agent-runtime.js";
import { playDraftLeague } from "./draftleague.js";
import {
  type DraftLeagueEvent,
  type DraftLeagueOptions,
  rankedTable,
} from "./draftleague-protocol.js";
import { type ExternalExchange, ExternalRunner } from "./external-runner.js";
import { LiveRun } from "./live-run.js";
import { defaultPsDir } from "./paths.js";
import { harnessCommit, showdownCommit } from "./showdown.js";
import type { JsonObject, Pid } from "./types.js";
import type { DraftTableRow } from "./views.js";

const EXTERNAL_SEAT = /^external:[a-z0-9][a-z0-9._-]*$/i;
const FIXED_SEATS = ["bot", "random"];

export const leagueSchema = z.object({
  seats: z.array(z.string()).min(2),
  seed: z.int().nonnegative(),
  run_dir: z.string().min(1),
  board: z.string().default("regmc-202609"),
  concurrency: z.int().positive().default(4),
  transactions: z.boolean().default(true),
});
export type LeagueInput = z.input<typeof leagueSchema>;

export interface LeagueSeries {
  index: number;
  stage: "roundrobin" | "playoff";
  round: number;
  entrants: [number, number];
  score: Record<Pid, number>;
  winner: number | null;
}

export interface LeagueOutcome {
  run_dir: string;
  entrants: string[];
  team_names: string[];
  standings: DraftTableRow[];
  series: LeagueSeries[];
  placement: number[];
  error: string | null;
}

export type LeagueEvent =
  | { kind: "exchange"; entrant: number; exchange: ExternalExchange }
  | { kind: "series"; series: LeagueSeries }
  | { kind: "end"; outcome: LeagueOutcome };

const seriesRecordSchema = z.object({
  series_index: z.int(),
  stage: z.enum(["roundrobin", "playoff"]),
  round: z.int(),
  entrants: z.tuple([z.int(), z.int()]),
  score: z.object({ p1: z.int(), p2: z.int() }),
});

export function finalPlacement(standings: DraftTableRow[], series: LeagueSeries[]): number[] {
  const rank = (entrant: number) => standings.findIndex((row) => row.entrant === entrant);
  const placed: number[] = [];
  const playoffs = series.filter((entry) => entry.stage === "playoff");
  for (const round of [...new Set(playoffs.map((entry) => entry.round))].sort((a, b) => b - a)) {
    const fresh = playoffs
      .filter((entry) => entry.round === round)
      .flatMap((entry) =>
        entry.entrants.map((entrant) => ({ entrant, won: entry.winner === entrant })),
      )
      .filter(({ entrant }) => !placed.includes(entrant))
      .sort((a, b) => Number(b.won) - Number(a.won) || rank(a.entrant) - rank(b.entrant));
    placed.push(...fresh.map(({ entrant }) => entrant));
  }
  placed.push(
    ...standings.map((row) => row.entrant).filter((entrant) => !placed.includes(entrant)),
  );
  return placed;
}

export class LeagueBridge {
  readonly runner = new ExternalRunner((exchange) =>
    this.emit({ kind: "exchange", entrant: this.entrants.indexOf(exchange.model), exchange }),
  );
  private entrants: string[] = [];
  private teamNames: string[] = [];
  private readonly series = new Map<number, LeagueSeries>();
  private runDir = "";
  private started = false;
  private outcome: LeagueOutcome | undefined;

  constructor(
    private readonly emit: (event: LeagueEvent) => void,
    private readonly psDir = defaultPsDir(),
  ) {}

  start(input: LeagueInput): JsonObject {
    if (this.started) throw new Error("a league is already running");
    const league = leagueSchema.parse(input);
    for (const seat of league.seats)
      if (!FIXED_SEATS.includes(seat) && !EXTERNAL_SEAT.test(seat))
        throw new Error(`seat ${JSON.stringify(seat)} must be bot, random, or external:<label>`);
    const external = league.seats.filter((seat) => EXTERNAL_SEAT.test(seat));
    if (new Set(external).size !== external.length)
      throw new Error("external seats need distinct labels");
    this.started = true;
    this.runDir = path.resolve(league.run_dir);
    const agents: AgentRuntime = { run: this.runner.run, live: new LiveRun(this.runDir) };
    const options: DraftLeagueOptions = {
      seed: league.seed,
      board: league.board,
      psDir: this.psDir,
      timerScale: "off",
      concurrency: league.concurrency,
      recordsPath: path.join(this.runDir, "records.jsonl"),
      onEvent: (event) => this.observe(event),
    };
    if (!league.transactions) options.transactions = null;
    playDraftLeague(league.seats, this.runDir, agents, options).then(
      () => this.finish(null),
      (error) => this.finish(error instanceof Error ? error.message : String(error)),
    );
    return {
      run_dir: this.runDir,
      showdown_commit: showdownCommit(this.psDir),
      harness_commit: harnessCommit(),
    };
  }

  result(): LeagueOutcome {
    if (!this.outcome) throw new Error("the league has not ended");
    return this.outcome;
  }

  private observe(event: DraftLeagueEvent): void {
    if (event.type === "draft") {
      this.entrants = event.draft.entrants;
      this.teamNames = event.draft.teamNames;
    }
    if (event.type !== "series-end") return;
    const record = seriesRecordSchema.parse(event.record);
    const { p1, p2 } = record.score;
    const series: LeagueSeries = {
      index: record.series_index,
      stage: record.stage,
      round: record.round,
      entrants: record.entrants,
      score: record.score,
      winner: p1 === p2 ? null : record.entrants[p1 > p2 ? 0 : 1],
    };
    this.series.set(series.index, series);
    this.emit({ kind: "series", series });
  }

  private finish(error: string | null): void {
    this.runner.close("the league ended");
    const series = [...this.series.values()].sort((a, b) => a.index - b.index);
    const rows: DraftTableRow[] = this.entrants.map((_, entrant) => ({
      entrant,
      w: 0,
      l: 0,
      gw: 0,
      gl: 0,
    }));
    for (const entry of series) {
      if (entry.stage !== "roundrobin") continue;
      const [a, b] = entry.entrants;
      rows[a]!.gw += entry.score.p1;
      rows[a]!.gl += entry.score.p2;
      rows[b]!.gw += entry.score.p2;
      rows[b]!.gl += entry.score.p1;
      if (entry.winner === null) continue;
      rows[entry.winner]!.w += 1;
      rows[entry.winner === a ? b : a]!.l += 1;
    }
    const standings = rankedTable(rows);
    this.outcome = {
      run_dir: this.runDir,
      entrants: this.entrants,
      team_names: this.teamNames,
      standings,
      series,
      placement: finalPlacement(standings, series),
      error,
    };
    this.emit({ kind: "end", outcome: this.outcome });
  }
}

const json = z.record(z.string(), z.json());
const leagueRequestSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("tool"),
    params: z.object({ exchange: z.int(), name: z.string(), arguments: json.default({}) }),
  }),
  z.object({
    method: z.literal("submit"),
    params: z.object({
      exchange: z.int(),
      input: json,
      response: z.string().optional(),
      reasoning: z.string().optional(),
      usage: z.record(z.string(), z.number()).optional(),
    }),
  }),
  z.object({
    method: z.literal("abandon"),
    params: z.object({ exchange: z.int(), reason: z.string().default("abandoned") }),
  }),
  z.object({ method: z.literal("outcome"), params: z.object({}).default({}) }),
]);

export function handleLeagueRequest(bridge: LeagueBridge, method: string, params: JsonObject) {
  const parsed = leagueRequestSchema.safeParse({ method, params });
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  const request = parsed.data;
  switch (request.method) {
    case "tool":
      return bridge.runner.tool(
        request.params.exchange,
        request.params.name,
        request.params.arguments,
      );
    case "submit": {
      const { exchange, input, ...reply } = request.params;
      bridge.runner.submit(exchange, input, reply);
      return { accepted: true };
    }
    case "abandon":
      bridge.runner.abandon(request.params.exchange, request.params.reason);
      return { abandoned: true };
    case "outcome":
      return bridge.result();
  }
}
