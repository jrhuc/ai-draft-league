import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { writeAtomicJson } from "./atomic-json.js";
import { appendJsonlObject, readJsonlObjects } from "./jsonl.js";
import { LEAGUE_ROOT } from "./paths.js";
import type { ModelReasoningConfig, ReasoningLevel } from "./providers.js";
import { reasoningForModel } from "./providers.js";
import { showdownCommit } from "./showdown.js";
import type { Team } from "./teams.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import type { BattleOutcome, JsonObject, Pid, TimerScale } from "./types.js";
import { isErrnoCode } from "./value.js";
import {
  chanceEventCounts,
  foldSeriesGames,
  gameSeedSchema,
  seriesGameResultSchema,
  seriesGameSummarySchema,
} from "./series-core.js";
import type { GameSeed, SeriesFold, SeriesGameResult } from "./series-core.js";

export const SERIES_GAME_COMPLETION_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const gameCompletionMarkerSchema = z.strictObject({
  kind: z.literal("game_complete"),
  schema_version: z.literal(SERIES_GAME_COMPLETION_SCHEMA_VERSION),
  series_id: z.string().min(1),
  game_number: z.number().int().positive(),
  attempt_id: z.string().min(1),
  seed: gameSeedSchema,
  log_sha256: sha256Schema,
  summary: seriesGameSummarySchema,
});

type GameCompletionMarker = z.infer<typeof gameCompletionMarkerSchema>;

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
  apiKeys?: Readonly<Record<string, string>>;
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

export interface AdoptedSeries {
  seriesId: string;
  seriesDir: string;
  started: string | undefined;
  games: JsonObject[];
  folded: SeriesFold;
  attemptRows: SeriesAttemptRow[];
  decisions: Record<Pid, JsonObject[]>;
  notebooks: Partial<Record<Pid, string>>;
  replay: Record<Pid, JsonObject[]>;
  resumeFrom: string | undefined;
}

function optionalTextDigests(values: Partial<Record<Pid, string>> | undefined) {
  const digest = (value: string | undefined): string | null =>
    value === undefined ? null : createHash("sha256").update(value).digest("hex");
  return { p1: digest(values?.p1), p2: digest(values?.p2) };
}

export const RECORDED_SERIES_METADATA_SCHEMA_VERSION = 3 as const;

const pidTextSchema = z.strictObject({ p1: z.string().min(1), p2: z.string().min(1) });
const pidPackedTeamSchema = z.strictObject({ p1: z.string(), p2: z.string() });
const pidOptionalDigestSchema = z.strictObject({
  p1: sha256Schema.nullable(),
  p2: sha256Schema.nullable(),
});
const reasoningLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const recordedSeriesIdentitySchema = z.object({
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
export const recordedSeriesMetadataSchema = z.strictObject({
  schema_version: z.literal(RECORDED_SERIES_METADATA_SCHEMA_VERSION),
  series_id: z.string().min(1),
  started: z.string().min(1),
  identity: recordedSeriesIdentitySchema,
});
export const storedSeriesMetadataSchema = z
  .looseObject({
    players: pidTextSchema.optional(),
    identity: z
      .looseObject({
        players: pidTextSchema.optional(),
        series_index: z.number().int().nonnegative().nullable().optional(),
      })
      .optional(),
  })
  .transform((stored) => ({
    players: stored.identity?.players ?? stored.players ?? null,
    seriesIndex: stored.identity?.series_index ?? null,
  }));

export type RecordedSeriesIdentity = z.infer<typeof recordedSeriesIdentitySchema>;
type RecordedSeriesMetadata = z.infer<typeof recordedSeriesMetadataSchema>;

export function recordedSeriesIdentity(context: RecordedSeriesContext): RecordedSeriesIdentity {
  const packedTeams = { p1: context.teams.p1.packed, p2: context.teams.p2.packed };
  return recordedSeriesIdentitySchema.parse({
    players: context.players,
    team_ids: { p1: context.teams.p1.id, p2: context.teams.p2.id },
    packed_teams: packedTeams,
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

export function adoptSeriesDir(
  context: RecordedSeriesContext,
  expectedIdentity: RecordedSeriesIdentity,
): AdoptedSeries | undefined {
  const root = path.join(context.runDir, "series");
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const candidates: AdoptedSeries[] = [];
  for (const seriesId of entries) {
    const seriesDir = path.join(root, seriesId);
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(path.join(seriesDir, "series.json"), "utf8"));
    } catch {
      continue;
    }
    const parsed = recordedSeriesMetadataSchema.safeParse(value);
    if (!parsed.success) {
      const indexed = storedSeriesMetadataSchema.safeParse(value);
      if (indexed.success && indexed.data.seriesIndex === context.seriesIndex) {
        throw new Error(
          `recorded series metadata for schedule slot ${String(context.seriesIndex)} (${seriesId}) is not current: ${z.prettifyError(parsed.error)}`,
        );
      }
      continue;
    }
    const meta: RecordedSeriesMetadata = parsed.data;
    if (meta.identity.series_index !== context.seriesIndex) continue;
    if (meta.series_id !== seriesId) {
      throw new Error(`recorded series metadata identity does not match directory ${seriesId}`);
    }
    if (!isDeepStrictEqual(meta.identity, expectedIdentity)) {
      throw new Error(
        `recorded series identity mismatch for schedule slot ${String(context.seriesIndex)} (${seriesId})`,
      );
    }
    candidates.push(
      reconstructAdoptedSeries(context, meta.identity.players, seriesId, seriesDir, meta.started),
    );
  }
  if (!candidates.length) return undefined;
  const completedGames = Math.max(...candidates.map((candidate) => candidate.games.length));
  const best = candidates.filter((candidate) => candidate.games.length === completedGames);
  if (best.length > 1) {
    const ids = best.map(({ seriesId }) => seriesId).sort();
    throw new Error(
      `ambiguous recorded series adoption for schedule slot ${String(context.seriesIndex)} (${ids.join(", ")})`,
    );
  }
  return best[0];
}

export function gameCompletionMarkerPath(seriesDir: string, gameNumber: number): string {
  return path.join(seriesDir, `game-${gameNumber}.complete.json`);
}

function seriesGameResult(marker: GameCompletionMarker): SeriesGameResult {
  const result = seriesGameResultSchema.parse({
    number: marker.game_number,
    seed: marker.seed,
    ...marker.summary,
  });
  if ((result.winner_side === null) !== (result.winner === null)) {
    throw new Error(`game ${result.number} winner and winner side do not agree`);
  }
  return result;
}

interface CompletedGameEvidence {
  marker: GameCompletionMarker;
  result: SeriesGameResult;
}

export function completedGameEvidence(input: {
  seriesId: string;
  attemptId: string;
  gameNumber: number;
  seed: GameSeed;
  players: Record<Pid, string>;
  winnerSide: Pid | undefined;
  outcome: BattleOutcome;
  modelChoiceFallbacks: Record<Pid, number>;
  log: string;
  logBytes: Buffer;
}): CompletedGameEvidence {
  const marker = gameCompletionMarkerSchema.parse({
    kind: "game_complete",
    schema_version: SERIES_GAME_COMPLETION_SCHEMA_VERSION,
    series_id: input.seriesId,
    game_number: input.gameNumber,
    attempt_id: input.attemptId,
    seed: input.seed,
    log_sha256: createHash("sha256").update(input.logBytes).digest("hex"),
    summary: {
      winner: input.winnerSide ? input.players[input.winnerSide] : null,
      winner_side: input.winnerSide ?? null,
      turns: input.outcome.turns,
      errors: input.outcome.errors,
      model_choice_fallbacks: input.modelChoiceFallbacks,
      simulator_substitutions: input.outcome.simulatorSubstitutions,
      timer_autodefaults: input.outcome.timerAutodefaults,
      chance_events: chanceEventCounts(input.outcome.log),
      log: input.log,
    },
  });
  return { marker, result: seriesGameResult(marker) };
}

export function writeGameCompletionMarker(seriesDir: string, marker: GameCompletionMarker): void {
  writeAtomicJson(
    gameCompletionMarkerPath(seriesDir, marker.game_number),
    gameCompletionMarkerSchema.parse(marker),
  );
}

function gameCompletionMarker(
  seriesDir: string,
  seriesId: string,
  gameNumber: number,
): GameCompletionMarker | undefined {
  const file = gameCompletionMarkerPath(seriesDir, gameNumber);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`invalid game completion marker ${file}`, { cause });
  }
  const parsed = gameCompletionMarkerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid game completion marker ${file}: ${z.prettifyError(parsed.error)}`);
  }
  const marker = parsed.data;
  if (marker.series_id !== seriesId || marker.game_number !== gameNumber) {
    throw new Error(`game completion marker ${file} does not match its series and game identity`);
  }
  const logPath = path.join(seriesDir, `game-${gameNumber}.log`);
  if (marker.summary.log !== relativeSeriesFile(logPath)) {
    throw new Error(`game completion marker ${file} does not bind its canonical log path`);
  }
  let logBytes: Buffer;
  try {
    logBytes = fs.readFileSync(logPath);
  } catch (cause) {
    throw new Error(`game completion marker ${file} has no canonical game log`, { cause });
  }
  const actualDigest = createHash("sha256").update(logBytes).digest("hex");
  if (actualDigest !== marker.log_sha256) {
    throw new Error(`canonical game log digest does not match completion marker ${file}`);
  }
  seriesGameResult(marker);
  return marker;
}

interface SideDecisionRows {
  p1: JsonObject[];
  p2: JsonObject[];
}

const decisionNotebookSchema = z.looseObject({ notebook: z.string() });
const attemptOwnedDecisionSchema = z.looseObject({ attempt_id: z.string().min(1) });
const replayableDecisionSchema = z.looseObject({
  request_digest: z.string(),
  submission_source: z.coerce.string(),
  timer: z.json().optional(),
});
const terminalDecisionSchema = z.looseObject({
  kind: z.literal("decision"),
  outcome: z.enum(["accepted", "rejected"]),
  submission_id: z.string(),
  action: z.string(),
});

function reconstructAdoptedSeries(
  context: RecordedSeriesContext,
  storedPlayers: Record<Pid, string>,
  seriesId: string,
  seriesDir: string,
  started: string | undefined,
): AdoptedSeries {
  const attemptRows = attemptLedgerRows(attemptLedgerPath(seriesDir));
  const markerNumbers = fs
    .readdirSync(seriesDir)
    .flatMap((entry) => {
      if (!entry.startsWith("game-") || !entry.endsWith(".complete.json")) return [];
      const match = /^game-([1-9]\d*)\.complete\.json$/u.exec(entry);
      if (!match)
        throw new Error(
          `recorded series ${seriesId} has an invalid completion marker filename ${entry}`,
        );
      return [Number(match[1])];
    })
    .sort((left, right) => left - right);
  const completedLineages = new Map<number, Set<string>>();
  const completedAttempts: CompletedDecisionAttempt[] = [];
  const games: JsonObject[] = [];
  let folded = foldSeriesGames(context.gameSeeds, games, {
    requireWinner: context.requireWinner,
    players: storedPlayers,
    label: `recorded series ${seriesId}`,
  });
  for (let number = 1; ; number += 1) {
    const marker = gameCompletionMarker(seriesDir, seriesId, number);
    if (folded.complete) {
      if (marker)
        throw new Error(
          `recorded series ${seriesId} records game ${number} after the series was clinched`,
        );
      break;
    }
    const gameSeed = folded.nextSeed;
    if (!gameSeed || !marker) break;
    const markerStart = attemptRows.find(
      (row) => row.kind === "attempt_started" && row.attempt_id === marker.attempt_id,
    );
    const lineage = resolveAttemptLineage(attemptRows, marker.attempt_id);
    if (markerStart?.series_id !== seriesId || !lineage) {
      throw new Error(
        `game completion marker for recorded series ${seriesId} has no valid attempt lineage`,
      );
    }
    if (!isDeepStrictEqual(marker.seed, gameSeed)) {
      throw new Error(
        `game completion marker for recorded series ${seriesId} game ${number} has the wrong seed`,
      );
    }
    completedLineages.set(number, new Set(lineage));
    completedAttempts.push({ gameNumber: number, attemptId: marker.attempt_id });
    games.push(seriesGameResult(marker));
    folded = foldSeriesGames(context.gameSeeds, games, {
      requireWinner: context.requireWinner,
      players: storedPlayers,
      label: `recorded series ${seriesId}`,
    });
  }
  if (
    !isDeepStrictEqual(
      markerNumbers,
      games.map((_, index) => index + 1),
    )
  ) {
    throw new Error(
      `recorded series ${seriesId} completion markers are not its exact consecutive game prefix`,
    );
  }

  const currentAttemptId = attemptRows.findLast(
    (row) => row.kind === "attempt_started" && row.series_id === seriesId,
  )?.attempt_id;
  const currentLineage =
    currentAttemptId === undefined
      ? undefined
      : resolveAttemptLineage(attemptRows, currentAttemptId);
  const currentAttempts = new Set(currentLineage ?? []);
  const decisions: SideDecisionRows = { p1: [], p2: [] };
  const replay: SideDecisionRows = { p1: [], p2: [] };
  const notebooks: Partial<Record<Pid, string>> = {};
  for (const pid of ["p1", "p2"] as const) {
    const rows = readJsonlObjects(path.join(seriesDir, `${pid}-decisions.jsonl`));
    const completedRows = selectCompletedDecisionRows(rows, attemptRows, completedAttempts);
    decisions[pid].push(...completedRows);
    for (const row of completedRows) {
      const recordedNotebook = decisionNotebookSchema.safeParse(row);
      if (recordedNotebook.success) notebooks[pid] = recordedNotebook.data.notebook;
    }
    for (const row of rows) {
      const ownedDecision = attemptOwnedDecisionSchema.safeParse(row);
      const attemptId = ownedDecision.success ? ownedDecision.data.attempt_id : undefined;
      const gameNumber = Number(row.game_number);
      const completedLineage = completedLineages.get(gameNumber);
      if (attemptId && completedLineage?.has(attemptId)) continue;
      if (
        attemptId &&
        currentAttempts.has(attemptId) &&
        gameNumber === games.length + 1 &&
        isTerminalDecision(row)
      ) {
        replay[pid].push(row);
      }
    }
  }

  const replayable =
    currentLineage !== undefined &&
    storedPlayers.p1 !== "random" &&
    storedPlayers.p2 !== "random" &&
    (["p1", "p2"] as const).every((pid) =>
      replay[pid].every((row) => {
        const parsed = replayableDecisionSchema.safeParse(row);
        return (
          parsed.success &&
          ["model", "automatic", "model-default"].includes(parsed.data.submission_source) &&
          !parsed.data.timer
        );
      }),
    );
  const hasReplay = replay.p1.length > 0 || replay.p2.length > 0;
  if (replayable && hasReplay) {
    for (const pid of ["p1", "p2"] as const) {
      decisions[pid].push(...replay[pid]);
      for (const row of replay[pid]) {
        const recordedNotebook = decisionNotebookSchema.safeParse(row);
        if (recordedNotebook.success) notebooks[pid] = recordedNotebook.data.notebook;
      }
    }
  } else {
    replay.p1 = [];
    replay.p2 = [];
  }
  return {
    seriesId,
    seriesDir,
    started,
    games,
    folded,
    attemptRows,
    decisions,
    notebooks,
    replay,
    resumeFrom: replayable && hasReplay ? currentAttemptId : undefined,
  };
}

function isTerminalDecision(row: JsonObject): boolean {
  return terminalDecisionSchema.safeParse(row).success;
}

export const SERIES_ATTEMPT_SCHEMA_VERSION = 1 as const;

const contextLedgerHeadSchema = z.strictObject({
  context_id: z.string().min(1).nullable(),
  sequence: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  sha256: sha256Schema,
});
const contextLedgerHeadsSchema = z.strictObject({
  p1: contextLedgerHeadSchema,
  p2: contextLedgerHeadSchema,
});
const contextLedgerBoundsSchema = z.strictObject({
  start: contextLedgerHeadsSchema,
  end: contextLedgerHeadsSchema,
});
const attemptIdentityFields = {
  schema_version: z.literal(SERIES_ATTEMPT_SCHEMA_VERSION),
  timestamp: z.string().min(1),
  attempt_id: z.string().min(1),
  series_id: z.string().min(1),
  adopted_completed_games: z.number().int().nonnegative(),
  context_heads: contextLedgerBoundsSchema,
};
const seriesAttemptRowSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("attempt_started"),
    ...attemptIdentityFields,
    resumed_from: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("attempt_superseded"),
    ...attemptIdentityFields,
    superseded_by: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("attempt_completed"),
    ...attemptIdentityFields,
    completed_games: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("attempt_aborted"),
    ...attemptIdentityFields,
    error: z.strictObject({ name: z.string().min(1), message: z.string() }),
  }),
]);

type SeriesAttemptRow = z.infer<typeof seriesAttemptRowSchema>;
const attemptLineageStartSchema = z.looseObject({
  kind: z.literal("attempt_started"),
  attempt_id: z.string(),
  series_id: z.string(),
  resumed_from: z.string().min(1).optional(),
});
type AttemptLineageStart = z.infer<typeof attemptLineageStartSchema>;

interface AttemptLineageEntry {
  row: AttemptLineageStart;
  index: number;
}

function attemptLedgerRows(file: string): SeriesAttemptRow[] {
  return readJsonlObjects(file).map((row, index) => {
    const parsed = seriesAttemptRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`invalid series attempt row ${index + 1}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  });
}

export function resolveAttemptLineage(
  rows: readonly JsonObject[],
  attemptId: string,
  cutoff = rows.length,
): string[] | undefined {
  if (!attemptId || !Number.isInteger(cutoff) || cutoff < 0 || cutoff > rows.length)
    return undefined;
  const starts = new Map<string, AttemptLineageEntry>();
  for (const [index, row] of rows.slice(0, cutoff).entries()) {
    const parsedStart = attemptLineageStartSchema.safeParse(row);
    if (!parsedStart.success) continue;
    if (starts.has(parsedStart.data.attempt_id)) return undefined;
    starts.set(parsedStart.data.attempt_id, { row: parsedStart.data, index });
  }
  const reverse: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = attemptId;
  let childIndex = cutoff;
  let seriesId: string | undefined;
  while (current !== undefined) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const entry = starts.get(current);
    const currentSeriesId = entry?.row.series_id;
    if (!entry || entry.index >= childIndex || !currentSeriesId) {
      return undefined;
    }
    const start = entry.row;
    childIndex = entry.index;
    if (seriesId === undefined) seriesId = currentSeriesId;
    else if (currentSeriesId !== seriesId) return undefined;
    reverse.push(current);
    current = start.resumed_from;
  }
  return reverse.reverse();
}

export interface CompletedDecisionAttempt {
  gameNumber: number;
  attemptId: string;
}

export function selectCompletedDecisionRows(
  rows: readonly JsonObject[],
  attemptRows: readonly JsonObject[],
  completed: readonly CompletedDecisionAttempt[],
): JsonObject[] {
  const lineages = new Map<number, Set<string>>();
  for (const { gameNumber, attemptId } of completed) {
    const lineage = resolveAttemptLineage(attemptRows, attemptId);
    if (!lineage) throw new Error(`completed game ${gameNumber} has no valid attempt lineage`);
    lineages.set(gameNumber, new Set(lineage));
  }
  return rows.filter((row) => {
    const ownedDecision = attemptOwnedDecisionSchema.safeParse(row);
    const attemptId = ownedDecision.success ? ownedDecision.data.attempt_id : undefined;
    const lineage = lineages.get(Number(row.game_number));
    return Boolean(
      attemptId &&
      lineage?.has(attemptId) &&
      (row.kind === "game_reflection" || isTerminalDecision(row)),
    );
  });
}

function completedGameMarkers(seriesDir: string, seriesId: string): GameCompletionMarker[] {
  const markerNumbers = fs
    .readdirSync(seriesDir)
    .flatMap((entry) => {
      const match = /^game-([1-9]\d*)\.complete\.json$/u.exec(entry);
      return match ? [Number(match[1])] : [];
    })
    .sort((left, right) => left - right);
  const markers: GameCompletionMarker[] = [];
  for (let gameNumber = 1; ; gameNumber += 1) {
    const marker = gameCompletionMarker(seriesDir, seriesId, gameNumber);
    if (!marker) break;
    markers.push(marker);
  }
  if (
    !isDeepStrictEqual(
      markerNumbers,
      markers.map((marker) => marker.game_number),
    )
  ) {
    throw new Error(
      `recorded series ${seriesId} completion markers are not its exact consecutive game prefix`,
    );
  }
  return markers;
}

export function readCompletedSeriesGameLogs(seriesDir: string, seriesId: string): string[][] {
  const attemptRows = attemptLedgerRows(attemptLedgerPath(seriesDir));
  return completedGameMarkers(seriesDir, seriesId).map((marker) => {
    if (!resolveAttemptLineage(attemptRows, marker.attempt_id)) {
      throw new Error(`completed game ${marker.game_number} has no valid attempt lineage`);
    }
    return fs
      .readFileSync(path.join(seriesDir, `game-${marker.game_number}.log`), "utf8")
      .split("\n");
  });
}

export function readCompletedSeriesDecisionRows(
  seriesDir: string,
  seriesId: string,
  pid: Pid,
): JsonObject[] {
  const attemptRows = attemptLedgerRows(attemptLedgerPath(seriesDir));
  const completed = completedGameMarkers(seriesDir, seriesId).map((marker) => ({
    gameNumber: marker.game_number,
    attemptId: marker.attempt_id,
  }));
  return selectCompletedDecisionRows(
    readJsonlObjects(path.join(seriesDir, `${pid}-decisions.jsonl`)),
    attemptRows,
    completed,
  );
}

function canonicalCompletedAttempt(
  adopted: AdoptedSeries,
): Extract<SeriesAttemptRow, { kind: "attempt_completed" }> {
  const starts = new Map<string, Extract<SeriesAttemptRow, { kind: "attempt_started" }>>();
  const terminal = new Set<string>();
  for (const row of adopted.attemptRows) {
    if (row.series_id !== adopted.seriesId) {
      throw new Error(
        `recorded series ${adopted.seriesId} attempt ledger contains another series identity`,
      );
    }
    if (row.kind === "attempt_started") {
      if (
        starts.has(row.attempt_id) ||
        !isDeepStrictEqual(row.context_heads.start, row.context_heads.end)
      ) {
        throw new Error(`recorded series ${adopted.seriesId} has an invalid attempt start`);
      }
      starts.set(row.attempt_id, row);
      continue;
    }
    const start = starts.get(row.attempt_id);
    if (
      !start ||
      terminal.has(row.attempt_id) ||
      start.adopted_completed_games !== row.adopted_completed_games ||
      !isDeepStrictEqual(start.context_heads.start, row.context_heads.start)
    ) {
      throw new Error(`recorded series ${adopted.seriesId} has an invalid terminal attempt row`);
    }
    if (row.kind === "attempt_superseded" && !starts.has(row.superseded_by)) {
      throw new Error(
        `recorded series ${adopted.seriesId} supersedes an attempt with an unknown branch`,
      );
    }
    if (row.kind === "attempt_completed" && row.completed_games !== adopted.games.length) {
      throw new Error(
        `recorded series ${adopted.seriesId} completion attempt has the wrong game count`,
      );
    }
    terminal.add(row.attempt_id);
  }
  const completed = adopted.attemptRows.at(-1);
  if (
    !adopted.folded.complete ||
    completed?.kind !== "attempt_completed" ||
    terminal.size !== starts.size ||
    !resolveAttemptLineage(adopted.attemptRows, completed.attempt_id) ||
    !isDeepStrictEqual(completed.context_heads.end, contextLedgerHeads(adopted.seriesDir))
  ) {
    throw new Error(
      `recorded series ${adopted.seriesId} has no canonical terminal completion attempt`,
    );
  }
  return completed;
}

interface CompletedSeriesEvidence {
  winnerSide: Pid | undefined;
  fields: CompletedSeriesFields;
}

export function readCompletedSeriesEvidence(
  context: RecordedSeriesContext,
): CompletedSeriesEvidence {
  if (context.seriesIndex === undefined)
    throw new Error("completed series evidence requires a schedule slot");
  const identity = recordedSeriesIdentity(context);
  const adopted = adoptSeriesDir(context, identity);
  if (!adopted) {
    throw new Error(`schedule slot ${context.seriesIndex} has no exact recorded series evidence`);
  }
  const completed = canonicalCompletedAttempt(adopted);
  const winnerSide = adopted.folded.winnerSide;
  const reasoningConfig: ModelReasoningConfig = {};
  if (identity.scaffold.reasoning !== null) reasoningConfig.reasoning = identity.scaffold.reasoning;
  if (identity.scaffold.reasoning_by_model !== null) {
    reasoningConfig.reasoningByModel = identity.scaffold.reasoning_by_model;
  }
  const fields: CompletedSeriesFields = {
    series_id: adopted.seriesId,
    attempt_id: completed.attempt_id,
    format: identity.format,
    players: identity.players,
    teams: identity.team_ids,
    winner: winnerSide ? identity.players[winnerSide] : null,
    winner_side: winnerSide ?? null,
    score: adopted.folded.score,
    turns: adopted.games.reduce((sum, game) => sum + Number(game.turns), 0),
    games: adopted.games,
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
  return { winnerSide, fields };
}

type ContextLedgerHead = z.infer<typeof contextLedgerHeadSchema>;
type ContextLedgerHeads = z.infer<typeof contextLedgerHeadsSchema>;
const contextLedgerRowSchema = z.looseObject({
  context_id: z.string(),
  sequence: z.number(),
});

interface IncompleteAttempt {
  attemptId: string;
  adoptedCompletedGames: number;
  contextStartHeads: ContextLedgerHeads;
}

const SERIES_ATTEMPTS_FILE = "series-attempts.jsonl";

function contextLedgerHead(seriesDir: string, pid: Pid): ContextLedgerHead {
  const file = path.join(seriesDir, `${pid}-context.jsonl`);
  let contents: Buffer;
  try {
    contents = fs.readFileSync(file);
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
    contents = Buffer.alloc(0);
  }
  let contextId: string | null = null;
  let sequence = 0;
  for (const line of contents.toString("utf8").split("\n")) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      break;
    }
    const parsed = contextLedgerRowSchema.safeParse(value);
    if (!parsed.success) break;
    contextId = parsed.data.context_id;
    sequence = parsed.data.sequence;
  }
  return {
    context_id: contextId,
    sequence,
    byte_length: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

export function contextLedgerHeads(seriesDir: string): ContextLedgerHeads {
  return {
    p1: contextLedgerHead(seriesDir, "p1"),
    p2: contextLedgerHead(seriesDir, "p2"),
  };
}

function attemptLedgerPath(seriesDir: string): string {
  return path.join(seriesDir, SERIES_ATTEMPTS_FILE);
}

export function appendAttemptRecord(seriesDir: string, record: SeriesAttemptRow): void {
  const file = attemptLedgerPath(seriesDir);
  attemptLedgerRows(file);
  appendJsonlObject(file, record);
}

export function incompleteAttempts(seriesDir: string, seriesId: string): IncompleteAttempt[] {
  const started = new Map<string, IncompleteAttempt>();
  const terminal = new Set<string>();
  for (const row of attemptLedgerRows(attemptLedgerPath(seriesDir))) {
    if (row.series_id !== seriesId) continue;
    if (row.kind === "attempt_started") {
      started.set(row.attempt_id, {
        attemptId: row.attempt_id,
        adoptedCompletedGames: row.adopted_completed_games,
        contextStartHeads: row.context_heads.start,
      });
    } else {
      terminal.add(row.attempt_id);
    }
  }
  return [...started.values()]
    .filter((attempt) => !terminal.has(attempt.attemptId))
    .sort((left, right) =>
      left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0,
    );
}

export function attemptRecord(
  kind: SeriesAttemptRow["kind"],
  attemptId: string,
  seriesId: string,
  adoptedCompletedGames: number,
  startHeads: ContextLedgerHeads,
  endHeads: ContextLedgerHeads,
  extra: JsonObject = {},
): SeriesAttemptRow {
  return seriesAttemptRowSchema.parse({
    kind,
    schema_version: SERIES_ATTEMPT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    attempt_id: attemptId,
    series_id: seriesId,
    adopted_completed_games: adoptedCompletedGames,
    context_heads: { start: startHeads, end: endHeads },
    ...extra,
  });
}

export function relativeSeriesFile(file: string): string {
  const value = path.relative(LEAGUE_ROOT, file);
  return value.startsWith("..") ? file : value;
}
