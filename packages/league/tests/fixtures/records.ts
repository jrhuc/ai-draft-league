import { type ParsedSeriesRecord, parseSeriesRecord } from "../../src/records.js";
import type { JsonObject } from "../../src/types.js";

export function seriesRecordFixture(overrides: JsonObject): ParsedSeriesRecord {
  const games = Array.isArray(overrides.games) ? overrides.games : [];
  return parseSeriesRecord(
    {
      schema_version: 1,
      mode: "rotation",
      timestamp: "2026-07-20T00:00:00.000Z",
      run_id: "run",
      series_id: "series",
      series_index: 0,
      format: "gen9testformat",
      players: { p1: "openai:alpha", p2: "openai:beta" },
      teams: { p1: "alpha", p2: "beta" },
      winner: null,
      winner_side: null,
      score: { p1: 0, p2: 0 },
      turns: 0,
      engine_seeds: { p1: 1, p2: 2 },
      reasoning: null,
      decision_stats: { p1: {}, p2: {} },
      run_seed: 1,
      ps_commit: "unknown",
      ...overrides,
      games: games.map((game) => ({
        winner: null,
        seed: [0, 0, 0, 0],
        ...(game instanceof Object ? game : {}),
      })),
    },
    "fixture",
  );
}
