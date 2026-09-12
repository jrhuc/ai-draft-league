import fs from "node:fs";
import path from "node:path";
import type { RecordedSeriesIdentity } from "../src/recorded-series.js";
import {
  completeStoredAdaptation,
  createStoredSeries,
  finishSeriesAttempt,
  resolveStoredGame,
  startSeriesAttempt,
} from "../src/series-store.js";
import { chanceEventCounts } from "../src/series.js";

interface StoredGameFixture {
  number: number;
  logPath: string;
  winner: string | null;
  winnerSide: "p1" | "p2" | null;
  turns?: number;
  seed?: [number, number, number, number];
}

function fixtureIdentity(
  overrides: Partial<Pick<RecordedSeriesIdentity, "players" | "series_index" | "game_seeds">> = {},
): RecordedSeriesIdentity {
  return {
    players: { p1: "fixture:p1", p2: "fixture:p2" },
    team_ids: { p1: "p1", p2: "p2" },
    packed_teams: { p1: "", p2: "" },
    format: "fixture",
    game_seeds: [[1, 2, 3, 4]],
    series_index: null,
    engine_seeds: { p1: 1, p2: 2 },
    showdown_commit: "unknown",
    scaffold: {
      timer_scale: "off",
      require_winner: false,
      closed_sheets: false,
      reasoning: null,
      reasoning_by_model: null,
      initial_notebook_digests: { p1: null, p2: null },
      draft_roster_digests: { p1: null, p2: null },
      briefing_digests: { p1: null, p2: null },
    },
    ...overrides,
  };
}

export function storeSeriesFixture(
  runDir: string,
  seriesId: string,
  overrides: Parameters<typeof fixtureIdentity>[0] & { startedAt?: string } = {},
): void {
  const { startedAt = "2026-01-01T00:00:00.000Z", ...identity } = overrides;
  createStoredSeries(runDir, seriesId, startedAt, fixtureIdentity(identity));
}

export function storeCompletedSeriesFixture(
  runDir: string,
  seriesId: string,
  games: StoredGameFixture[],
  options: { attemptId?: string; startedAt?: string } = {},
): void {
  const { attemptId = "canonical", startedAt } = options;
  const seeds = games.map((game): [number, number, number, number] =>
    game.seed ? [...game.seed] : [game.number, 2, 3, 4],
  );
  storeSeriesFixture(runDir, seriesId, { game_seeds: seeds, startedAt });
  startSeriesAttempt({ runDir, seriesId, attemptId, adoptedGames: 0 });
  const zeros = { p1: 0, p2: 0 };
  for (const game of games) {
    const bytes = fs.readFileSync(game.logPath);
    const task = { kind: "no-reflection", memory_state: "" };
    resolveStoredGame({
      runDir,
      seriesId,
      attemptId,
      gameNumber: game.number,
      seed: seeds[game.number - 1]!,
      result: {
        number: game.number,
        seed: seeds[game.number - 1]!,
        winner: game.winner,
        winner_side: game.winnerSide,
        turns: game.turns ?? 1,
        errors: zeros,
        simulator_substitutions: zeros,
        timer_autodefaults: zeros,
        chance_events: chanceEventCounts(bytes.toString("utf8").split("\n")),
        log: path.relative(runDir, game.logPath),
      },
      logPath: game.logPath,
      logBytes: bytes,
      adaptations: { p1: task, p2: task },
    });
    for (const pid of ["p1", "p2"] as const) {
      completeStoredAdaptation({ runDir, seriesId, gameNumber: game.number, pid, memoryState: "" });
    }
  }
  finishSeriesAttempt(runDir, seriesId, attemptId);
}
