import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { insertOnce, readRunDatabase, transact } from "./run-database.js";

const leagueRunStateSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("draft"), completedPicks: z.number().int().nonnegative() }),
  z.strictObject({
    phase: z.literal("roundrobin"),
    week: z.number().int().nonnegative(),
    rosterVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    phase: z.literal("window"),
    week: z.number().int().positive(),
    rosterVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({ phase: z.literal("playoffs"), round: z.number().int().nonnegative() }),
  z.strictObject({ phase: z.literal("done"), champion: z.number().int().nonnegative() }),
]);

export type LeagueRunState = z.infer<typeof leagueRunStateSchema>;

const storedCheckpointSchema = z.strictObject({
  stage: z.enum(["draft", "week", "transactions"]),
  week: z.number().int().nonnegative(),
  entrant: z.number().int().nonnegative(),
  model: z.string().min(1),
  roster_version: z.number().int().nonnegative(),
  memory_json: z.string().min(1),
  reasoning: z.string(),
  fallback: z.union([z.literal(0), z.literal(1)]),
});

const rosterMonSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  cost: z.number().int().nonnegative(),
});
const storedRosterSchema = z.strictObject({
  roster_version: z.number().int().nonnegative(),
  entrant: z.number().int().nonnegative(),
  team_name: z.string(),
  budget: z.number().int().nonnegative(),
  roster_json: z.string().min(1),
});

const memorySchema = z.record(z.string(), z.string());
const countSchema = z.object({ count: z.number().int().nonnegative() });

export interface FranchiseCheckpoint {
  stage: "draft" | "week" | "transactions";
  week: number;
  entrant: number;
  model: string;
  rosterVersion: number;
  memory: Record<string, string>;
  reasoning: string;
  fallback: boolean;
}

type RosterMon = z.infer<typeof rosterMonSchema>;

export interface FranchiseRosterState {
  rosterVersion: number;
  entrant: number;
  teamName: string;
  budget: number;
  roster: RosterMon[];
}

function stateKey(state: LeagueRunState): string {
  switch (state.phase) {
    case "draft":
      return `draft:${state.completedPicks}`;
    case "roundrobin":
      return `roundrobin:${state.week}:${state.rosterVersion}`;
    case "window":
      return `window:${state.week}:${state.rosterVersion}`;
    case "playoffs":
      return `playoffs:${state.round}`;
    case "done":
      return `done:${state.champion}`;
  }
}

function validTransition(previous: LeagueRunState, next: LeagueRunState, weeks: number): boolean {
  if (previous.phase === "draft") {
    if (next.phase === "draft") return next.completedPicks === previous.completedPicks + 1;
    return next.phase === "roundrobin" && next.week === 0 && next.rosterVersion === 0;
  }
  if (previous.phase === "roundrobin") {
    if (next.phase === "window") {
      return next.week === previous.week && next.rosterVersion === previous.rosterVersion;
    }
    if (next.phase === "roundrobin") {
      return next.week === previous.week + 1 && next.rosterVersion === previous.rosterVersion;
    }
    return next.phase === "playoffs" && previous.week === weeks && next.round === 0;
  }
  if (previous.phase === "window") {
    return (
      next.phase === "roundrobin" &&
      next.week === previous.week &&
      next.rosterVersion === previous.rosterVersion + 1
    );
  }
  if (previous.phase === "playoffs") {
    if (next.phase === "playoffs") return next.round === previous.round + 1;
    return next.phase === "done";
  }
  return false;
}

function count(database: DatabaseSync, sql: string, ...parameters: number[]): number {
  return countSchema.parse(database.prepare(sql).get(...parameters)).count;
}

function requireBarriers(
  database: DatabaseSync,
  previous: LeagueRunState | undefined,
  next: LeagueRunState,
  entrants: number,
): void {
  if (previous?.phase === "roundrobin" && previous.week > 0) {
    const reviewed = count(
      database,
      "SELECT count(*) AS count FROM franchise_checkpoints WHERE stage = 'week' AND week = ?",
      previous.week,
    );
    if (reviewed !== entrants) {
      throw new Error(
        `round-robin week ${previous.week} has ${reviewed}/${entrants} franchise memory checkpoints`,
      );
    }
  }
  if (next.phase !== "roundrobin") return;
  const rosters = count(
    database,
    "SELECT count(*) AS count FROM franchise_rosters WHERE roster_version = ?",
    next.rosterVersion,
  );
  if (rosters !== entrants) {
    throw new Error(
      `roster version ${next.rosterVersion} has ${rosters}/${entrants} franchise snapshots`,
    );
  }
  if (previous?.phase !== "window") return;
  const changed = z.array(z.object({ entrant: z.number().int().nonnegative() })).parse(
    database
      .prepare(
        `SELECT current.entrant
           FROM franchise_rosters current
           JOIN franchise_rosters previous ON previous.entrant = current.entrant
           WHERE current.roster_version = ?
             AND previous.roster_version = ?
             AND current.roster_json <> previous.roster_json`,
      )
      .all(next.rosterVersion, next.rosterVersion - 1),
  );
  const reconciled = database.prepare(
    "SELECT 1 FROM franchise_checkpoints WHERE stage = 'transactions' AND week = ? AND roster_version = ? AND entrant = ?",
  );
  const missing = changed.filter(
    ({ entrant }) => !reconciled.get(next.week, next.rosterVersion, entrant),
  );
  if (missing.length) {
    throw new Error(
      `roster version ${next.rosterVersion} lacks transaction memory for franchise ${missing.map(({ entrant }) => entrant).join(", ")}`,
    );
  }
}

function readTransitions(database: DatabaseSync): LeagueRunState[] {
  return z
    .array(z.object({ state_json: z.string() }))
    .parse(database.prepare("SELECT state_json FROM league_transitions ORDER BY sequence").all())
    .map((row) => leagueRunStateSchema.parse(JSON.parse(row.state_json)));
}

/** A state already on the journal is a no-op; a new state must follow the latest one and satisfy its barriers. */
export function recordLeagueTransition(
  runDir: string,
  value: LeagueRunState,
  weeks: number,
  entrants: number,
): void {
  const state = leagueRunStateSchema.parse(value);
  const key = stateKey(state);
  transact(runDir, (database) => {
    const transitions = readTransitions(database);
    if (transitions.some((existing) => stateKey(existing) === key)) return;
    const previous = transitions.at(-1);
    if (previous && !validTransition(previous, state, weeks)) {
      throw new Error(
        `invalid league transition ${JSON.stringify(previous)} -> ${JSON.stringify(state)}`,
      );
    }
    requireBarriers(database, previous, state, entrants);
    database
      .prepare(
        "INSERT INTO league_transitions (state_key, recorded_at, state_json) VALUES (?, ?, ?)",
      )
      .run(key, new Date().toISOString(), JSON.stringify(state));
  });
}

export function readLeagueTransitions(runDir: string): LeagueRunState[] {
  return readRunDatabase(runDir, readTransitions, []);
}

export function latestRosterVersion(runDir: string): number {
  return readRunDatabase(
    runDir,
    (database) =>
      z
        .object({ version: z.number().int().nonnegative().nullable() })
        .parse(
          database.prepare("SELECT max(roster_version) AS version FROM franchise_rosters").get(),
        ).version ?? 0,
    0,
  );
}

type StoredRow = Record<string, SQLOutputValue> | undefined;

function checkpointFromStored(value: StoredRow): FranchiseCheckpoint {
  const row = storedCheckpointSchema.parse(value);
  return {
    stage: row.stage,
    week: row.week,
    entrant: row.entrant,
    model: row.model,
    rosterVersion: row.roster_version,
    memory: memorySchema.parse(JSON.parse(row.memory_json)),
    reasoning: row.reasoning,
    fallback: row.fallback === 1,
  };
}

export function storeFranchiseCheckpoint(runDir: string, value: FranchiseCheckpoint): void {
  transact(runDir, (database) =>
    insertOnce(
      database,
      "franchise_checkpoints",
      {
        stage: value.stage,
        week: value.week,
        entrant: value.entrant,
        model: value.model,
        roster_version: value.rosterVersion,
        memory_json: JSON.stringify(memorySchema.parse(value.memory)),
        reasoning: value.reasoning,
        fallback: value.fallback ? 1 : 0,
      },
      ["stage", "week", "entrant"],
      `franchise ${value.entrant} ${value.stage} ${value.week} checkpoint`,
    ),
  );
}

export function readFranchiseCheckpoints(
  runDir: string,
  stage?: FranchiseCheckpoint["stage"],
  week?: number,
): FranchiseCheckpoint[] {
  const filters: string[] = [];
  const parameters: Array<string | number> = [];
  if (stage !== undefined) {
    filters.push("stage = ?");
    parameters.push(stage);
  }
  if (week !== undefined) {
    filters.push("week = ?");
    parameters.push(week);
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  return readRunDatabase(
    runDir,
    (database) =>
      database
        .prepare(
          `SELECT stage, week, entrant, model, roster_version, memory_json, reasoning, fallback FROM franchise_checkpoints${where} ORDER BY week, stage, entrant`,
        )
        .all(...parameters)
        .map(checkpointFromStored),
    [],
  );
}

function rosterFromStored(value: StoredRow): FranchiseRosterState {
  const row = storedRosterSchema.parse(value);
  return {
    rosterVersion: row.roster_version,
    entrant: row.entrant,
    teamName: row.team_name,
    budget: row.budget,
    roster: z.array(rosterMonSchema).parse(JSON.parse(row.roster_json)),
  };
}

export function storeFranchiseRosterVersion(
  runDir: string,
  values: readonly FranchiseRosterState[],
): void {
  if (!values.length) throw new Error("a roster version must contain at least one franchise");
  const version = values[0]!.rosterVersion;
  if (
    values.some((value) => value.rosterVersion !== version) ||
    new Set(values.map((value) => value.entrant)).size !== values.length
  ) {
    throw new Error(`roster version ${version} must contain each franchise once`);
  }
  transact(runDir, (database) => {
    for (const value of values) {
      insertOnce(
        database,
        "franchise_rosters",
        {
          roster_version: value.rosterVersion,
          entrant: value.entrant,
          team_name: value.teamName,
          budget: value.budget,
          roster_json: JSON.stringify(z.array(rosterMonSchema).parse(value.roster)),
        },
        ["roster_version", "entrant"],
        `franchise ${value.entrant} roster version ${value.rosterVersion}`,
      );
    }
  });
}

export function readFranchiseRosterVersion(
  runDir: string,
  rosterVersion: number,
): FranchiseRosterState[] {
  return readRunDatabase(
    runDir,
    (database) =>
      database
        .prepare(
          "SELECT roster_version, entrant, team_name, budget, roster_json FROM franchise_rosters WHERE roster_version = ? ORDER BY entrant",
        )
        .all(rosterVersion)
        .map(rosterFromStored),
    [],
  );
}
