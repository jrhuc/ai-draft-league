import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { buildTournaments } from "../src/evidence.js";
import { TEAMS_DIR } from "../src/paths.js";
import type { ParsedSeriesRecord } from "../src/records.js";
import { seriesRecordFixture } from "./fixtures/records.js";

function tournamentMatch(
  seriesIndex: number,
  round: number,
  seeds: [number, number],
  p1: string,
  p2: string,
  winnerSide: "p1" | "p2",
): ParsedSeriesRecord {
  return seriesRecordFixture({
    mode: "tournament",
    run_id: "cup-2",
    timestamp: `2026-07-25T0${seriesIndex}:00:00.000Z`,
    series_index: seriesIndex,
    round,
    entrant_count: 3,
    seeds: { p1: seeds[0], p2: seeds[1] },
    pool: "majors",
    players: { p1, p2 },
    teams: { p1: `team-${seeds[0]}`, p2: `team-${seeds[1]}` },
    winner: winnerSide === "p1" ? p1 : p2,
    winner_side: winnerSide,
    score: winnerSide === "p1" ? { p1: 2, p2: 0 } : { p1: 1, p2: 2 },
    turns: 12,
    advanced: winnerSide === "p1" ? p1 : p2,
  });
}

function threeEntrantRows(): ParsedSeriesRecord[] {
  return [
    tournamentMatch(0, 1, [1, 2], "openai:beta", "openai:gamma", "p2"),
    tournamentMatch(1, 2, [0, 2], "openai:alpha", "openai:gamma", "p1"),
  ];
}

test("buildTournaments reconstructs a bracket with byes from row seeds", () => {
  const rows = threeEntrantRows();
  const response = buildTournaments(rows, "/nonexistent", null);
  assert.deepEqual(response.summary, { tournaments: 1, matches: 2 });
  assert.ok(!("records" in response.summary), "cross-tournament model placements are not exposed");
  assert.equal(response.tournaments.length, 1);
  const archive = response.tournaments[0]!;
  assert.equal(archive.complete, true);
  assert.equal(archive.champion, 0);
  assert.equal(archive.entrants[0]!.model, "openai:alpha");
  assert.equal(archive.entrants[2]!.team, "team-2");
  assert.equal(archive.rounds.length, 2);
  const bye = archive.rounds[0]!.find((view) => view.score === null);
  assert.ok(bye, "the bye survives reconstruction");
  assert.equal(bye!.winner, 0, "the bye advances seed 0");
  const final = archive.rounds[1]![0]!;
  assert.deepEqual(final.slots, [0, 2]);
  assert.deepEqual(final.score, [2, 0]);
  assert.equal(buildTournaments(rows, "/nonexistent", "other-pool").tournaments.length, 0);
});

test("tournament folds reject contradictory structural facts", () => {
  const repeatedIdentity = threeEntrantRows();
  repeatedIdentity[1]!.players.p1 = "openai:beta";
  const duplicateSeries = threeEntrantRows();
  duplicateSeries.push(structuredClone(duplicateSeries[0]!));
  const conflictingSides = threeEntrantRows();
  conflictingSides[1]!.seeds = { p1: 0, p2: 1 };
  conflictingSides[1]!.players.p2 = "openai:beta";
  conflictingSides[1]!.teams = { p1: "team-0", p2: "team-1" };
  const conflictingResult = threeEntrantRows();
  conflictingResult[1]!.score = { p1: 0, p2: 2 };
  const ambiguousModels = threeEntrantRows();
  ambiguousModels[0]!.players.p1 = "openai:gamma";

  for (const [name, rows] of Object.entries({
    repeatedIdentity,
    duplicateSeries,
    conflictingSides,
    conflictingResult,
    ambiguousModels,
  })) {
    assert.equal(buildTournaments(rows, "/nonexistent", null).tournaments.length, 0, name);
  }
});

test("tournament archives include open team sheets for the shared match viewer", () => {
  const rows = [
    seriesRecordFixture({
      mode: "tournament",
      run_id: "cup-sheets",
      timestamp: "2026-08-06T21:00:00.000Z",
      series_index: 0,
      round: 1,
      entrant_count: 2,
      seeds: { p1: 0, p2: 1 },
      pool: "test",
      players: { p1: "provider:alpha", p2: "provider:beta" },
      teams: { p1: "boschmans-mega-pyroar", p2: "cybertron-mega-staraptor" },
      winner: "provider:alpha",
      winner_side: "p1",
      score: { p1: 2, p2: 0 },
      turns: 8,
    }),
  ];
  const archive = buildTournaments(rows, "/nonexistent", "test", TEAMS_DIR).tournaments[0]!;
  assert.equal(archive.entrants[0]!.teamSheet?.length, 6);
  assert.equal(archive.entrants[1]!.teamSheet?.length, 6);
  assert.ok(archive.entrants[0]!.teamSheet?.every((set) => set.spriteId && set.moves.length > 0));
});
