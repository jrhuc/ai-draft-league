import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentRuntime } from "./agent-runtime.js";
import { readJsonlObjects } from "./jsonl.js";
import type { ModelReasoningConfig, ReasoningLevel } from "./providers.js";
import { reasoningForModel, reasoningLevelSchema } from "./providers.js";
import { findStoredSeries, latestSeriesMemory, readStoredSeries } from "./series-store.js";
import { foldSeriesGames, gameSeedSchema } from "./series-core.js";
import { showdownCommit } from "./showdown.js";
import type { Team } from "./teams.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import type { JsonObject, Pid, TimerScale } from "./types.js";

export interface RecordedSeriesContext extends ModelReasoningConfig {
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  seriesIndex?: number;
  initialNotebooks?: Partial<Record<Pid, string>>;
  draftRosters?: Partial<Record<Pid, string>>;
  briefings?: Partial<Record<Pid, string>>;
  engineSeeds: Record<Pid, number>;
  format: string;
  psDir: string;
  runDir: string;
  agents: AgentRuntime;
  signal?: AbortSignal;
  onGameUpdate?: (game: number, lines: string[], publicLines: string[]) => void;
  onGameEnd?: (
    game: number,
    winner: string | null,
    turns: number,
    score: Record<Pid, number>,
  ) => void;
  onDecision?: (pid: Pid, row: JsonObject) => void;
  requireWinner?: boolean;
  tournamentRound?: "round" | "final";
  timerScale?: TimerScale;
  closedSheets?: boolean;
}

export interface RecordedSeriesFields extends JsonObject {
  timestamp: string;
  run_id: string;
  series_id: string;
  attempt_id: string;
  format: string;
  players: Record<Pid, string>;
  teams: Record<Pid, string>;
  winner: string | null;
  winner_side: Pid | null;
  score: Record<Pid, number>;
  turns: number;
  games: JsonObject[];
  engine_seeds: Record<Pid, number>;
  timer_scale: TimerScale;
  closed_sheets?: true;
  reasoning: ReasoningLevel | null;
  sampling: "provider-default";
  reasoning_by_player?: Record<Pid, ReasoningLevel | null>;
  decision_stats: JsonObject;
}

export type CompletedSeriesFields = Pick<
  RecordedSeriesFields,
  | "series_id"
  | "attempt_id"
  | "format"
  | "players"
  | "teams"
  | "winner"
  | "winner_side"
  | "score"
  | "turns"
  | "games"
  | "engine_seeds"
  | "timer_scale"
  | "closed_sheets"
  | "reasoning"
  | "sampling"
  | "reasoning_by_player"
>;

export interface RecordedSeries {
  coachNotes: Record<Pid, string>;
  winnerSide: Pid | undefined;
  fields: RecordedSeriesFields;
}

function optionalTextDigests(values: Partial<Record<Pid, string>> | undefined) {
  const digest = (value: string | undefined): string | null =>
    value === undefined ? null : createHash("sha256").update(value).digest("hex");
  return { p1: digest(values?.p1), p2: digest(values?.p2) };
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const pidTextSchema = z.strictObject({ p1: z.string().min(1), p2: z.string().min(1) });
const pidPackedTeamSchema = z.strictObject({ p1: z.string(), p2: z.string() });
const pidOptionalDigestSchema = z.strictObject({
  p1: sha256Schema.nullable(),
  p2: sha256Schema.nullable(),
});
export const recordedSeriesIdentitySchema = z.strictObject({
  players: pidTextSchema,
  team_ids: pidTextSchema,
  packed_teams: pidPackedTeamSchema,
  format: z.string().min(1),
  game_seeds: z.array(gameSeedSchema).min(1),
  series_index: z.number().int().nonnegative().nullable(),
  engine_seeds: z.strictObject({ p1: z.number().int(), p2: z.number().int() }),
  showdown_commit: z.union([z.string().regex(/^[0-9a-f]{40}$/u), z.literal("unknown")]),
  scaffold: z.strictObject({
    timer_scale: z.union([z.literal("off"), z.number().positive()]),
    require_winner: z.boolean(),
    closed_sheets: z.boolean(),
    reasoning: reasoningLevelSchema.nullable(),
    reasoning_by_model: z.record(z.string(), reasoningLevelSchema).nullable(),
    initial_notebook_digests: pidOptionalDigestSchema,
    draft_roster_digests: pidOptionalDigestSchema,
    briefing_digests: pidOptionalDigestSchema,
  }),
});

export type RecordedSeriesIdentity = z.infer<typeof recordedSeriesIdentitySchema>;

export function recordedSeriesIdentity(context: RecordedSeriesContext): RecordedSeriesIdentity {
  return recordedSeriesIdentitySchema.parse({
    players: context.players,
    team_ids: { p1: context.teams.p1.id, p2: context.teams.p2.id },
    packed_teams: { p1: context.teams.p1.packed, p2: context.teams.p2.packed },
    format: context.format,
    game_seeds: context.gameSeeds,
    series_index: context.seriesIndex ?? null,
    engine_seeds: context.engineSeeds,
    showdown_commit: showdownCommit(context.psDir),
    scaffold: {
      timer_scale: context.timerScale ?? DEFAULT_TIMER_SCALE,
      require_winner: context.requireWinner ?? false,
      closed_sheets: context.closedSheets ?? false,
      reasoning: context.reasoning ?? null,
      reasoning_by_model: context.reasoningByModel ?? null,
      initial_notebook_digests: optionalTextDigests(context.initialNotebooks),
      draft_roster_digests: optionalTextDigests(context.draftRosters),
      briefing_digests: optionalTextDigests(context.briefings),
    },
  });
}

export function seriesDirectory(runDir: string, seriesId: string): string {
  return path.join(runDir, "series", seriesId);
}

export function readCompletedSeriesGameLogs(runDir: string, seriesId: string): string[][] {
  const series = readStoredSeries(runDir, seriesId);
  if (!series?.completedAttemptId) throw new Error(`series ${seriesId} is not complete`);
  return series.games.map((game) =>
    fs.readFileSync(path.resolve(runDir, game.logPath), "utf8").split("\n"),
  );
}

/** Decision rows of the attempts that resolved each game; rows from superseded attempts are dropped. */
export function readCompletedSeriesDecisionRows(
  runDir: string,
  seriesId: string,
  pid: Pid,
): JsonObject[] {
  const series = readStoredSeries(runDir, seriesId);
  if (!series?.completedAttemptId) throw new Error(`series ${seriesId} is not complete`);
  const owners = new Map(series.games.map((game) => [game.gameNumber, game.attemptId]));
  return readJsonlObjects(
    path.join(seriesDirectory(runDir, seriesId), `${pid}-decisions.jsonl`),
  ).filter((row) => owners.get(Number(row.game_number)) === row.attempt_id);
}

interface CompletedSeriesEvidence {
  coachNotes: Record<Pid, string>;
  winnerSide: Pid | undefined;
  fields: CompletedSeriesFields;
}

export function readCompletedSeriesEvidence(
  context: RecordedSeriesContext,
): CompletedSeriesEvidence {
  if (context.seriesIndex === undefined)
    throw new Error("completed series evidence requires a schedule slot");
  const identity = recordedSeriesIdentity(context);
  const stored = findStoredSeries(context.runDir, context.seriesIndex, identity);
  if (!stored) {
    throw new Error(`schedule slot ${context.seriesIndex} has no exact recorded series evidence`);
  }
  if (!stored.completedAttemptId)
    throw new Error(`schedule slot ${context.seriesIndex} has no completed series evidence`);
  const games = stored.games.map((game) => game.result);
  const folded = foldSeriesGames(identity.game_seeds, games, {
    requireWinner: identity.scaffold.require_winner,
    players: identity.players,
    label: `recorded series ${stored.seriesId}`,
  });
  if (!folded.complete) throw new Error(`recorded series ${stored.seriesId} is not complete`);
  const winnerSide = folded.winnerSide;
  const reasoningConfig: ModelReasoningConfig = {};
  if (identity.scaffold.reasoning !== null) reasoningConfig.reasoning = identity.scaffold.reasoning;
  if (identity.scaffold.reasoning_by_model !== null) {
    reasoningConfig.reasoningByModel = identity.scaffold.reasoning_by_model;
  }
  const fields: CompletedSeriesFields = {
    series_id: stored.seriesId,
    attempt_id: stored.completedAttemptId,
    format: identity.format,
    players: identity.players,
    teams: identity.team_ids,
    winner: winnerSide ? identity.players[winnerSide] : null,
    winner_side: winnerSide ?? null,
    score: folded.score,
    turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
    games,
    engine_seeds: identity.engine_seeds,
    timer_scale: identity.scaffold.timer_scale,
    reasoning: identity.scaffold.reasoning,
    sampling: "provider-default",
  };
  if (identity.scaffold.closed_sheets) fields.closed_sheets = true;
  if (identity.scaffold.reasoning_by_model !== null) {
    fields.reasoning_by_player = {
      p1: reasoningForModel(identity.players.p1, reasoningConfig) ?? null,
      p2: reasoningForModel(identity.players.p2, reasoningConfig) ?? null,
    };
  }
  return {
    coachNotes: {
      p1: latestSeriesMemory(stored, "p1") ?? context.initialNotebooks?.p1 ?? "",
      p2: latestSeriesMemory(stored, "p2") ?? context.initialNotebooks?.p2 ?? "",
    },
    winnerSide,
    fields,
  };
}
