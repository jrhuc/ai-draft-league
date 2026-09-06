import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import type { GameAdaptationTask } from "./battle-agent.js";
import { type RecordedSeriesIdentity, recordedSeriesIdentitySchema } from "./recorded-series.js";
import { readRunDatabase, transact, withRunDatabase } from "./run-database.js";
import { gameSeedSchema, seriesGameResultSchema } from "./series-core.js";
import type { GameSeed, SeriesGameResult } from "./series-core.js";
import type { Pid } from "./types.js";

const storedSeriesSchema = z.strictObject({
  series_id: z.string().min(1),
  series_index: z.number().int().nonnegative().nullable(),
  started_at: z.string().min(1),
  identity_json: z.string().min(1),
  completed_attempt_id: z.string().nullable(),
});

const storedGameSchema = z.strictObject({
  series_id: z.string().min(1),
  game_number: z.number().int().positive(),
  attempt_id: z.string().min(1),
  seed_json: z.string().min(1),
  result_json: z.string().min(1),
  log_path: z.string().min(1),
  log_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  resolved_at: z.string().min(1),
});

const storedAdaptationSchema = z.strictObject({
  series_id: z.string().min(1),
  game_number: z.number().int().positive(),
  pid: z.enum(["p1", "p2"]),
  attempt_id: z.string().min(1),
  task_json: z.string().min(1),
  memory_state: z.string().nullable(),
  completed_at: z.string().nullable(),
});
const gameAdaptationTaskSchema = z
  .object({ kind: z.string(), memory_state: z.string() })
  .catchall(z.json());

const SERIES_COLUMNS = "series_id, series_index, started_at, identity_json, completed_attempt_id";

export interface StoredSeriesGame {
  seriesId: string;
  gameNumber: number;
  attemptId: string;
  seed: GameSeed;
  result: SeriesGameResult;
  logPath: string;
  logSha256: string;
  resolvedAt: string;
}

export interface StoredGameAdaptation {
  seriesId: string;
  gameNumber: number;
  pid: Pid;
  attemptId: string;
  task: GameAdaptationTask;
  memoryState: string | undefined;
  completedAt: string | undefined;
}

export interface StoredSeries {
  seriesId: string;
  startedAt: string;
  identity: RecordedSeriesIdentity;
  completedAttemptId: string | undefined;
  games: StoredSeriesGame[];
  adaptations: StoredGameAdaptation[];
}

export interface StoredSeriesSummary {
  seriesId: string;
  seriesIndex: number | null;
  startedAt: string;
  players: Record<Pid, string>;
  completed: boolean;
}

type StoredRow = Record<string, SQLOutputValue> | undefined;

function gameFromStored(value: StoredRow): StoredSeriesGame {
  const row = storedGameSchema.parse(value);
  return {
    seriesId: row.series_id,
    gameNumber: row.game_number,
    attemptId: row.attempt_id,
    seed: gameSeedSchema.parse(JSON.parse(row.seed_json)),
    result: seriesGameResultSchema.parse(JSON.parse(row.result_json)),
    logPath: row.log_path,
    logSha256: row.log_sha256,
    resolvedAt: row.resolved_at,
  };
}

function adaptationFromStored(value: StoredRow): StoredGameAdaptation {
  const row = storedAdaptationSchema.parse(value);
  return {
    seriesId: row.series_id,
    gameNumber: row.game_number,
    pid: row.pid,
    attemptId: row.attempt_id,
    task: gameAdaptationTaskSchema.parse(JSON.parse(row.task_json)),
    memoryState: row.memory_state ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

function storedSeriesFromRow(
  database: DatabaseSync,
  runDir: string,
  value: StoredRow,
): StoredSeries {
  const row = storedSeriesSchema.parse(value);
  const games = database
    .prepare(
      "SELECT series_id, game_number, attempt_id, seed_json, result_json, log_path, log_sha256, resolved_at FROM series_games WHERE series_id = ? ORDER BY game_number",
    )
    .all(row.series_id)
    .map(gameFromStored);
  for (const [index, game] of games.entries()) {
    if (game.gameNumber !== index + 1)
      throw new Error(`series ${row.series_id} games are not consecutive`);
    const bytes = fs.readFileSync(path.resolve(runDir, game.logPath));
    if (createHash("sha256").update(bytes).digest("hex") !== game.logSha256) {
      throw new Error(`canonical game log digest does not match stored game ${game.gameNumber}`);
    }
  }
  const adaptations = database
    .prepare(
      "SELECT series_id, game_number, pid, attempt_id, task_json, memory_state, completed_at FROM game_adaptations WHERE series_id = ? ORDER BY game_number, pid",
    )
    .all(row.series_id)
    .map(adaptationFromStored);
  return {
    seriesId: row.series_id,
    startedAt: row.started_at,
    identity: recordedSeriesIdentitySchema.parse(JSON.parse(row.identity_json)),
    completedAttemptId: row.completed_attempt_id ?? undefined,
    games,
    adaptations,
  };
}

/** The stored series for a schedule slot, which must have been recorded under the same identity. */
export function findStoredSeries(
  runDir: string,
  seriesIndex: number,
  identity: RecordedSeriesIdentity,
): StoredSeries | undefined {
  return readRunDatabase(
    runDir,
    (database) => {
      const value = database
        .prepare(`SELECT ${SERIES_COLUMNS} FROM series WHERE series_index = ?`)
        .get(seriesIndex);
      if (!value) return undefined;
      const stored = storedSeriesFromRow(database, runDir, value);
      if (!isDeepStrictEqual(stored.identity, identity)) {
        throw new Error(`recorded series identity mismatch for schedule slot ${seriesIndex}`);
      }
      return stored;
    },
    undefined,
  );
}

export function readStoredSeries(runDir: string, seriesId: string): StoredSeries | undefined {
  return readRunDatabase(
    runDir,
    (database) => {
      const value = database
        .prepare(`SELECT ${SERIES_COLUMNS} FROM series WHERE series_id = ?`)
        .get(seriesId);
      return value ? storedSeriesFromRow(database, runDir, value) : undefined;
    },
    undefined,
  );
}

export function listStoredSeries(runDir: string): StoredSeriesSummary[] {
  return readRunDatabase(
    runDir,
    (database) =>
      database
        .prepare(`SELECT ${SERIES_COLUMNS} FROM series ORDER BY started_at, series_id`)
        .all()
        .map((value) => {
          const row = storedSeriesSchema.parse(value);
          return {
            seriesId: row.series_id,
            seriesIndex: row.series_index,
            startedAt: row.started_at,
            players: recordedSeriesIdentitySchema.parse(JSON.parse(row.identity_json)).players,
            completed: row.completed_attempt_id !== null,
          };
        }),
    [],
  );
}

export function createStoredSeries(
  runDir: string,
  seriesId: string,
  startedAt: string,
  identity: RecordedSeriesIdentity,
): void {
  withRunDatabase(runDir, (database) =>
    database
      .prepare(
        "INSERT INTO series (series_id, series_index, started_at, identity_json) VALUES (?, ?, ?, ?)",
      )
      .run(seriesId, identity.series_index, startedAt, JSON.stringify(identity)),
  );
}

export function startSeriesAttempt(input: {
  runDir: string;
  seriesId: string;
  attemptId: string;
  adoptedGames: number;
}): string | undefined {
  return transact(input.runDir, (database) => {
    const active = z
      .array(z.object({ attempt_id: z.string() }))
      .parse(
        database
          .prepare(
            "SELECT attempt_id FROM series_attempts WHERE series_id = ? AND status = 'active' ORDER BY started_at",
          )
          .all(input.seriesId),
      );
    const resumedFrom = active.at(-1)?.attempt_id;
    database
      .prepare(
        "UPDATE series_attempts SET status = 'superseded' WHERE series_id = ? AND status = 'active'",
      )
      .run(input.seriesId);
    database
      .prepare(
        "INSERT INTO series_attempts (attempt_id, series_id, started_at, status, resumed_from, adopted_games) VALUES (?, ?, ?, 'active', ?, ?)",
      )
      .run(
        input.attemptId,
        input.seriesId,
        new Date().toISOString(),
        resumedFrom ?? null,
        input.adoptedGames,
      );
    return resumedFrom;
  });
}

/** Commits a game's result together with both prepared adaptation tasks, so a restart can finish
 * the adaptations without replaying Showdown. */
export function resolveStoredGame(input: {
  runDir: string;
  seriesId: string;
  attemptId: string;
  gameNumber: number;
  seed: GameSeed;
  result: SeriesGameResult;
  logPath: string;
  logBytes: Buffer;
  adaptations: Record<Pid, GameAdaptationTask>;
}): void {
  transact(input.runDir, (database) => {
    database
      .prepare(
        "INSERT INTO series_games (series_id, game_number, attempt_id, seed_json, result_json, log_path, log_sha256, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.seriesId,
        input.gameNumber,
        input.attemptId,
        JSON.stringify(input.seed),
        JSON.stringify(seriesGameResultSchema.parse(input.result)),
        path.relative(input.runDir, input.logPath),
        createHash("sha256").update(input.logBytes).digest("hex"),
        new Date().toISOString(),
      );
    const insert = database.prepare(
      "INSERT INTO game_adaptations (series_id, game_number, pid, attempt_id, task_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const pid of ["p1", "p2"] as const) {
      insert.run(
        input.seriesId,
        input.gameNumber,
        pid,
        input.attemptId,
        JSON.stringify(input.adaptations[pid]),
      );
    }
  });
}

export function completeStoredAdaptation(input: {
  runDir: string;
  seriesId: string;
  gameNumber: number;
  pid: Pid;
  memoryState: string;
}): void {
  withRunDatabase(input.runDir, (database) => {
    const result = database
      .prepare(
        "UPDATE game_adaptations SET memory_state = ?, completed_at = ? WHERE series_id = ? AND game_number = ? AND pid = ? AND completed_at IS NULL",
      )
      .run(
        input.memoryState,
        new Date().toISOString(),
        input.seriesId,
        input.gameNumber,
        input.pid,
      );
    if (result.changes === 1) return;
    const stored = storedAdaptationSchema.parse(
      database
        .prepare(
          "SELECT series_id, game_number, pid, attempt_id, task_json, memory_state, completed_at FROM game_adaptations WHERE series_id = ? AND game_number = ? AND pid = ?",
        )
        .get(input.seriesId, input.gameNumber, input.pid),
    );
    if (stored.memory_state !== input.memoryState) {
      throw new Error(
        `series ${input.seriesId} game ${input.gameNumber} ${input.pid} adaptation is already committed differently`,
      );
    }
  });
}

export function finishSeriesAttempt(runDir: string, seriesId: string, attemptId: string): void {
  transact(runDir, (database) => {
    const pending = z
      .object({ count: z.number() })
      .parse(
        database
          .prepare(
            "SELECT count(*) AS count FROM game_adaptations WHERE series_id = ? AND completed_at IS NULL",
          )
          .get(seriesId),
      ).count;
    if (pending) throw new Error(`series ${seriesId} has ${pending} pending game adaptations`);
    const result = database
      .prepare(
        "UPDATE series_attempts SET status = 'completed' WHERE attempt_id = ? AND series_id = ? AND status = 'active'",
      )
      .run(attemptId, seriesId);
    if (result.changes !== 1) throw new Error(`series attempt ${attemptId} is not active`);
    database
      .prepare("UPDATE series SET completed_attempt_id = ? WHERE series_id = ?")
      .run(attemptId, seriesId);
  });
}

export function abortSeriesAttempt(
  runDir: string,
  seriesId: string,
  attemptId: string,
  error: Error | string,
): void {
  withRunDatabase(runDir, (database) =>
    database
      .prepare(
        "UPDATE series_attempts SET status = 'aborted', error_json = ? WHERE attempt_id = ? AND series_id = ? AND status = 'active'",
      )
      .run(
        JSON.stringify({
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        }),
        attemptId,
        seriesId,
      ),
  );
}

export function latestSeriesMemory(series: StoredSeries, pid: Pid): string | undefined {
  return series.adaptations
    .filter((adaptation) => adaptation.pid === pid && adaptation.memoryState !== undefined)
    .at(-1)?.memoryState;
}

export function pendingSeriesAdaptations(series: StoredSeries): StoredGameAdaptation[] {
  return series.adaptations.filter((adaptation) => adaptation.completedAt === undefined);
}
