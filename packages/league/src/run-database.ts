import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";

export const RUN_DATABASE_FILE = "league.sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS league_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    state_key TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS franchise_checkpoints (
    stage TEXT NOT NULL CHECK (stage IN ('draft', 'week', 'transactions')),
    week INTEGER NOT NULL,
    entrant INTEGER NOT NULL,
    model TEXT NOT NULL,
    roster_version INTEGER NOT NULL,
    memory_json TEXT NOT NULL CHECK (json_valid(memory_json)),
    reasoning TEXT NOT NULL,
    PRIMARY KEY (stage, week, entrant)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS franchise_rosters (
    roster_version INTEGER NOT NULL,
    entrant INTEGER NOT NULL,
    team_name TEXT NOT NULL,
    budget INTEGER NOT NULL,
    roster_json TEXT NOT NULL CHECK (json_valid(roster_json)),
    PRIMARY KEY (roster_version, entrant)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS series (
    series_id TEXT PRIMARY KEY,
    series_index INTEGER UNIQUE,
    started_at TEXT NOT NULL,
    identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
    completed_attempt_id TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS series_attempts (
    attempt_id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES series(series_id),
    started_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'completed', 'aborted')),
    resumed_from TEXT,
    adopted_games INTEGER NOT NULL,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS series_games (
    series_id TEXT NOT NULL REFERENCES series(series_id),
    game_number INTEGER NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES series_attempts(attempt_id),
    seed_json TEXT NOT NULL CHECK (json_valid(seed_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    log_path TEXT NOT NULL,
    log_sha256 TEXT NOT NULL,
    resolved_at TEXT NOT NULL,
    PRIMARY KEY (series_id, game_number)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS game_adaptations (
    series_id TEXT NOT NULL,
    game_number INTEGER NOT NULL,
    pid TEXT NOT NULL CHECK (pid IN ('p1', 'p2')),
    attempt_id TEXT NOT NULL REFERENCES series_attempts(attempt_id),
    task_json TEXT NOT NULL CHECK (json_valid(task_json)),
    memory_state TEXT,
    completed_at TEXT,
    PRIMARY KEY (series_id, game_number, pid),
    FOREIGN KEY (series_id, game_number) REFERENCES series_games(series_id, game_number),
    CHECK ((memory_state IS NULL) = (completed_at IS NULL))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS run_artifacts (
    namespace TEXT NOT NULL,
    artifact_key TEXT NOT NULL,
    artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (namespace, artifact_key)
  ) STRICT;
`;

const prepared = new Set<string>();

function runDatabaseExists(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, RUN_DATABASE_FILE));
}

function open(runDir: string): DatabaseSync {
  const file = path.join(runDir, RUN_DATABASE_FILE);
  const existed = fs.existsSync(file);
  if (!existed) fs.mkdirSync(runDir, { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  if (!existed || !prepared.has(file)) {
    if (
      existed &&
      database
        .prepare("SELECT 1 FROM pragma_table_info('franchise_checkpoints') WHERE name = 'fallback'")
        .get()
    ) {
      database.close();
      throw new Error(
        `Run database uses the retired fallback checkpoint schema: ${file}. Start a new run.`,
      );
    }
    database.exec(SCHEMA);
    prepared.add(file);
  }
  return database;
}

export function withRunDatabase<T>(runDir: string, task: (database: DatabaseSync) => T): T {
  const database = open(runDir);
  try {
    return task(database);
  } finally {
    database.close();
  }
}

/** Reads without creating a database in directories that never held one. */
export function readRunDatabase<T>(
  runDir: string,
  task: (database: DatabaseSync) => T,
  absent: T,
): T {
  return runDatabaseExists(runDir) ? withRunDatabase(runDir, task) : absent;
}

export function transact<T>(runDir: string, task: (database: DatabaseSync) => T): T {
  return withRunDatabase(runDir, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = task(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  });
}

export type Row = Record<string, SQLInputValue>;

const jsonColumn = z.string().transform((value) => z.json().parse(JSON.parse(value)));

function sameColumn(column: string, stored: SQLOutputValue, requested: SQLInputValue): boolean {
  if (!column.endsWith("_json")) return stored === requested;
  return isDeepStrictEqual(jsonColumn.parse(stored), jsonColumn.parse(requested));
}

/** Inserts a row once; a repeat with equal values is a no-op and a repeat with different values is an error. */
export function insertOnce(
  database: DatabaseSync,
  table: string,
  row: Row,
  key: readonly string[],
  label: string,
): void {
  const columns = Object.keys(row);
  database
    .prepare(
      `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...columns.map((column) => row[column]!));
  const stored = database
    .prepare(
      `SELECT ${columns.join(", ")} FROM ${table} WHERE ${key.map((column) => `${column} = ?`).join(" AND ")}`,
    )
    .get(...key.map((column) => row[column]!));
  if (
    !stored ||
    columns.some((column) => !sameColumn(column, stored[column] ?? null, row[column]!))
  ) {
    throw new Error(`${label} is already committed differently`);
  }
}
