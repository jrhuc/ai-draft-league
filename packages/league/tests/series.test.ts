import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { RandomEngine } from "../src/battle-agent.js";
import {
  chanceEventCounts,
  foldSeriesGames,
  playBo3,
  seriesSeedSchedule,
  SINGLE_ELIMINATION_GAME_LIMIT,
} from "../src/series.js";
import type { Bo3Context } from "../src/series.js";
import { readStoredSeries } from "../src/series-store.js";
import type { BattleOutcome } from "../src/types.js";

function engines() {
  return { p1: new RandomEngine("p1", 1), p2: new RandomEngine("p2", 2) };
}

function outcome(winner: string | null, turns = 1): BattleOutcome {
  return {
    winner,
    turns,
    log: winner ? [`|win|${winner}`] : ["|tie"],
    pov: { p1: [], p2: [] },
    errors: { p1: 0, p2: 0 },
    simulatorSubstitutions: { p1: 0, p2: 0 },
    timerAutodefaults: { p1: 0, p2: 0 },
  };
}

function matchContext(directory: string): Bo3Context {
  return {
    engines: engines(),
    names: { p1: "Side One", p2: "Side Two" },
    players: { p1: "model-one", p2: "model-two" },
    teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
    gameSeeds: [[1, 2, 3, 4]],
    seriesId: "series",
    seriesDir: directory,
    runDir: directory,
    format: "test",
    psDir: "",
  };
}

test("chance-event counts retain uninterpreted protocol facts per side", () => {
  const counts = chanceEventCounts([
    "|move|p2a: Aerodactyl|Rock Slide|p1a: Politoed|[spread] p1a,p1b",
    "|-miss|p2a: Aerodactyl|p1b: Gengar",
    "|-crit|p1a: Politoed",
    "|cant|p1a: Politoed|flinch",
    "|cant|p1b: Tinkaton|flinch",
    "|cant|p2b: Kingambit|par",
  ]);
  assert.deepEqual(counts.p1, { misses: 0, crits_taken: 1, flinched_turns: 2, full_paralysis: 0 });
  assert.deepEqual(counts.p2, { misses: 1, crits_taken: 0, flinched_turns: 0, full_paralysis: 1 });
});

test("resolved games survive an adaptation crash and resume without replaying Showdown", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-resume-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = matchContext(directory);
  let battles = 0;
  first.runBattle = async () => {
    battles += 1;
    return outcome("Side One");
  };
  first.engines.p2.completeGameEnd = async () => {
    throw new Error("coach disconnected");
  };

  await assert.rejects(playBo3(first), /coach disconnected/);
  const interrupted = readStoredSeries(directory, "series");
  assert.equal(interrupted?.games.length, 1);
  assert.equal(
    interrupted?.adaptations.find((row) => row.pid === "p1")?.completedAt !== undefined,
    true,
  );
  assert.equal(interrupted?.adaptations.find((row) => row.pid === "p2")?.completedAt, undefined);

  const resumed = matchContext(directory);
  resumed.runBattle = async () => {
    battles += 1;
    return outcome("Side Two");
  };
  const result = await playBo3(resumed);
  assert.equal(battles, 1);
  assert.equal(result.winnerSide, "p1");
  const completed = readStoredSeries(directory, "series");
  assert.ok(completed?.completedAttemptId);
  assert.equal(
    completed?.adaptations.every((row) => row.completedAt !== undefined),
    true,
  );
});

test("game summaries record simulator substitutions and timer defaults per side", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-evidence-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = matchContext(directory);
  context.runBattle = async () => ({
    ...outcome("Side One"),
    simulatorSubstitutions: { p1: 1, p2: 0 },
    timerAutodefaults: { p1: 2, p2: 0 },
  });
  const result = await playBo3(context);
  assert.deepEqual(result.games[0]!.simulator_substitutions, { p1: 1, p2: 0 });
  assert.deepEqual(result.games[0]!.timer_autodefaults, { p1: 2, p2: 0 });
});

test("single-elimination seed schedule precommits deterministic extension seeds", () => {
  const regulation: [number, number, number, number][] = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const first = seriesSeedSchedule(regulation, true);
  const second = seriesSeedSchedule(regulation, true);
  assert.equal(first.length, SINGLE_ELIMINATION_GAME_LIMIT);
  assert.deepEqual(first, second);
  assert.deepEqual(first.slice(0, 3), regulation);
  assert.equal(new Set(first.map((seed) => JSON.stringify(seed))).size, first.length);
});

test("foldSeriesGames derives terminal playoff tiebreaks rather than fabricating a winner", () => {
  const seeds: [number, number, number, number][] = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const schedule = seriesSeedSchedule(seeds, true);
  const games = schedule.slice(0, 4).map((seed, index) => ({
    number: index + 1,
    seed,
    winner_side: index === 3 ? "p1" : null,
    winner: index === 3 ? "one" : null,
  }));
  const folded = foldSeriesGames(seeds, games, {
    requireWinner: true,
    players: { p1: "one", p2: "two" },
  });
  assert.equal(folded.complete, true);
  assert.equal(folded.winnerSide, "p1");
});

test("single elimination runs deterministic tiebreak games until one side wins", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-tiebreak-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = matchContext(directory);
  context.requireWinner = true;
  context.gameSeeds = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const winners: Array<string | null> = ["Side One", "Side Two", null, "Side One"];
  let game = 0;
  context.runBattle = async () => outcome(winners[game++] ?? null);
  const result = await playBo3(context);
  assert.equal(result.games.length, 4);
  assert.equal(result.winnerSide, "p1");
  assert.deepEqual(result.games[3]!.seed, seriesSeedSchedule(context.gameSeeds, true)[3]);
});

test("single elimination stops after the finite tiebreak safety cap", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-cap-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = matchContext(directory);
  context.requireWinner = true;
  context.gameSeeds = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  let games = 0;
  context.runBattle = async () => {
    games += 1;
    return outcome(null);
  };
  await assert.rejects(playBo3(context), /remained tied after 9 games/);
  assert.equal(games, SINGLE_ELIMINATION_GAME_LIMIT);
});
