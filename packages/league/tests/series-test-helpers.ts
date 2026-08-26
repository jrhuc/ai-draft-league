import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Bo3Context, RecordedSeriesContext } from "../src/series.js";
import { chanceEventCounts } from "../src/series.js";
import { showdownCommit } from "../src/showdown.js";
import type { JsonObject } from "../src/types.js";

export function fakeEngines(): Bo3Context["engines"] {
  const engine = () => {
    const fake: Pick<Bo3Context["engines"]["p1"], "beginGame" | "endGame" | "decisionStats"> = {
      beginGame() {},
      endGame() {},
      decisionStats() {
        return { fallbacks: 0 };
      },
    };
    // SAFETY: the folded-series path calls only these three engine methods.
    return fake as Bo3Context["engines"]["p1"];
  };
  return { p1: engine(), p2: engine() };
}

export function attemptFixture(
  kind: "attempt_started" | "attempt_completed" | "attempt_aborted",
  attemptId: string,
  seriesId: string,
  extra: JsonObject = {},
) {
  const head = {
    context_id: null,
    sequence: 0,
    byte_length: 0,
    sha256: createHash("sha256").update("").digest("hex"),
  };
  return {
    kind,
    schema_version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    attempt_id: attemptId,
    series_id: seriesId,
    adopted_completed_games: 0,
    context_heads: { start: { p1: head, p2: head }, end: { p1: head, p2: head } },
    ...extra,
  };
}

export interface CompletionSummaryFixture {
  winner: string | null;
  winner_side: "p1" | "p2" | null;
  turns: number;
  errors?: { p1: number; p2: number };
  model_choice_fallbacks?: { p1: number; p2: number };
  simulator_substitutions?: { p1: number; p2: number };
  timer_autodefaults?: { p1: number; p2: number };
  chance_events?: ReturnType<typeof chanceEventCounts>;
}

export function writeGameCompletionMarkerFixture(
  seriesDir: string,
  seriesId: string,
  gameNumber: number,
  attemptId: string,
  seed: [number, number, number, number],
  result: CompletionSummaryFixture,
): void {
  const logPath = path.join(seriesDir, `game-${gameNumber}.log`);
  const logBytes = fs.readFileSync(logPath);
  const relativeLog = path.relative(process.cwd(), logPath);
  const zeros = { p1: 0, p2: 0 };
  const emptyChance = chanceEventCounts([]);
  fs.writeFileSync(
    path.join(seriesDir, `game-${gameNumber}.complete.json`),
    `${JSON.stringify({
      kind: "game_complete",
      schema_version: 1,
      series_id: seriesId,
      game_number: gameNumber,
      attempt_id: attemptId,
      seed,
      log_sha256: createHash("sha256").update(logBytes).digest("hex"),
      summary: {
        winner: result.winner,
        winner_side: result.winner_side,
        turns: result.turns,
        errors: result.errors ?? zeros,
        model_choice_fallbacks: result.model_choice_fallbacks ?? zeros,
        simulator_substitutions: result.simulator_substitutions ?? zeros,
        timer_autodefaults: result.timer_autodefaults ?? zeros,
        chance_events: result.chance_events ?? emptyChance,
        log: relativeLog.startsWith("..") ? logPath : relativeLog,
      },
    })}
`,
  );
}

export function recordedFixtureOptions(
  pool: { format: string; teams: Array<{ id: string; packed: string }> },
  psDir: string,
  runDir: string,
  seriesIndex: number,
  players: Record<"p1" | "p2", string> = { p1: "random", p2: "random" },
  overrides: Partial<RecordedSeriesContext> = {},
): RecordedSeriesContext {
  return {
    seriesIndex,
    players,
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    engineSeeds: { p1: 11, p2: 22 },
    format: pool.format,
    psDir,
    runDir,
    ...overrides,
  };
}

export function optionalFixtureDigests(values: Partial<Record<"p1" | "p2", string>> | undefined) {
  return Object.fromEntries(
    (["p1", "p2"] as const).map((pid) => {
      const value = values?.[pid];
      return [pid, value === undefined ? null : createHash("sha256").update(value).digest("hex")];
    }),
  );
}

export function recordedIdentityFixture(context: RecordedSeriesContext) {
  return {
    players: context.players,
    team_ids: { p1: context.teams.p1.id, p2: context.teams.p2.id },
    packed_teams: { p1: context.teams.p1.packed, p2: context.teams.p2.packed },
    format: context.format,
    game_seeds: context.gameSeeds,
    series_index: context.seriesIndex ?? null,
    engine_seeds: context.engineSeeds,
    showdown_commit: showdownCommit(context.psDir),
    scaffold: {
      timer_scale: context.timerScale ?? "off",
      require_winner: context.requireWinner ?? false,
      closed_sheets: context.closedSheets ?? false,
      reasoning: context.reasoning ?? null,
      reasoning_by_model: context.reasoningByModel ?? null,
      initial_notebook_digests: optionalFixtureDigests(context.initialNotebooks),
      draft_roster_digests: optionalFixtureDigests(context.draftRosters),
      briefing_digests: optionalFixtureDigests(context.briefings),
    },
  };
}

export function writeDecidedAdoption(
  runDir: string,
  seriesId: string,
  context: RecordedSeriesContext,
  started?: string,
): string {
  const seriesDir = path.join(runDir, "series", seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, "series.json"),
    `${JSON.stringify({
      schema_version: 3,
      series_id: seriesId,
      started: started ?? "2026-01-01T00:00:00.000Z",
      identity: recordedIdentityFixture(context),
    })}\n`,
  );
  const fixtureAttempt = `${seriesId}-fixture`;
  fs.writeFileSync(
    path.join(seriesDir, "series-attempts.jsonl"),
    `${JSON.stringify(attemptFixture("attempt_started", fixtureAttempt, seriesId))}\n${JSON.stringify(
      attemptFixture("attempt_completed", fixtureAttempt, seriesId, { completed_games: 2 }),
    )}\n`,
  );
  const names = { p1: `p1-${context.players.p1}`, p2: `p2-${context.players.p2}` };
  for (const game of [1, 2]) {
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      [
        `|player|p1|${names.p1}|1|`,
        `|player|p2|${names.p2}|2|`,
        `|turn|${game}`,
        `|win|${names.p1}`,
        "",
      ].join("\n"),
    );
    writeGameCompletionMarkerFixture(
      seriesDir,
      seriesId,
      game,
      fixtureAttempt,
      context.gameSeeds[game - 1]!,
      {
        winner: context.players.p1,
        winner_side: "p1",
        turns: game,
      },
    );
  }
  return seriesDir;
}
