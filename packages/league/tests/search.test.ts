import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RandomEngine } from "../src/battle-agent.js";
import {
  acceptedBattleActionEntries,
  type GameSource,
  openPosition,
  replayGame,
} from "../src/fork.js";
import { GreedyEngine, SearchEngine } from "../src/policy-engines.js";
import { seededRng } from "../src/random.js";
import { searchAction, type SearchSettings, solveZeroSum } from "../src/search.js";
import { SimBattle } from "../src/sim.js";
import { loadPool } from "../src/teams.js";
import type { JsonObject } from "../src/types.js";
import { text } from "../src/value.js";

const SETTINGS: SearchSettings = { shortlistPerSide: 2, rolloutsPerCell: 1, maxTurns: 2 };
const SEED: [number, number, number, number] = [9, 8, 7, 6];

function players(first = 0, second = 1) {
  const pool = loadPool();
  return {
    format: pool.format,
    p1: { name: "A", team: pool.teams[first]!.packed },
    p2: { name: "B", team: pool.teams[second]!.packed },
  };
}

async function midGame() {
  const { format, p1, p2 } = players();
  const rows: JsonObject[][] = [[], []];
  const outcome = await new SimBattle(format, { p1, p2 }, SEED).run({
    p1: new RandomEngine("p1", 3, rows[0]),
    p2: new RandomEngine("p2", 4, rows[1]),
  });
  const choices = (decisions: JsonObject[]) =>
    decisions.filter((row) => row.outcome === "accepted").map((row) => text(row.action));
  const source: GameSource = {
    format,
    seed: SEED,
    names: { p1: p1.name, p2: p2.name },
    packed: { p1: p1.team, p2: p2.team },
    choices: { p1: choices(rows[0]!), p2: choices(rows[1]!) },
  };
  const replay = replayGame(source, outcome.log);
  assert.ok(replay.verified);
  const position = replay.positions.find(
    (candidate) =>
      candidate.turn >= 2 &&
      candidate.pending.length === 2 &&
      !candidate.requests.p1.forceSwitch &&
      !candidate.requests.p2.forceSwitch,
  );
  assert.ok(position);
  return position;
}

test("regret matching finds the equilibrium row strategy", () => {
  const cycle = solveZeroSum([
    [0.5, 0, 1],
    [1, 0.5, 0],
    [0, 1, 0.5],
  ]);
  for (const weight of cycle) assert.ok(Math.abs(weight - 1 / 3) < 0.02, `${weight}`);
  const dominant = solveZeroSum([
    [0.2, 0.3],
    [0.6, 0.7],
  ]);
  assert.ok(dominant[1]! > 0.98);
  assert.deepEqual(solveZeroSum([]), []);
});

test("search returns an accepted action, repeats for a seed, and ignores a committed reply", async () => {
  const position = await midGame();
  const battle = openPosition(position);
  const first = searchAction(battle, "p1", SETTINGS, seededRng("search"));
  assert.ok(first.rollouts > 0);
  assert.ok(first.value >= 0 && first.value <= 1);
  assert.ok(
    acceptedBattleActionEntries(battle, "p1").some((entry) => entry.command === first.command),
  );

  const reply = acceptedBattleActionEntries(battle, "p2").at(-1)!;
  assert.ok(battle.getSide("p2").choose(reply.command));
  assert.ok(battle.getSide("p2").isChoiceDone());
  assert.deepEqual(searchAction(battle, "p1", SETTINGS, seededRng("search")), first);
  assert.ok(battle.getSide("p2").isChoiceDone(), "the live battle keeps its committed choice");
});

test("the greedy policy beats the random policy on most seeds", async () => {
  const { format, p1, p2 } = players(2, 3);
  let wins = 0;
  for (const seed of [1, 2, 3, 4]) {
    const outcome = await new SimBattle(format, { p1, p2 }, seed).run({
      p1: new GreedyEngine("p1", seed),
      p2: new RandomEngine("p2", seed),
    });
    assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
    if (outcome.winner === p1.name) wins += 1;
  }
  assert.ok(wins >= 3, `greedy won ${wins} of 4`);
});

test("a search seat plays a whole game from the live simulator", async () => {
  const { format, p1, p2 } = players(4, 5);
  const rows: JsonObject[] = [];
  const outcome = await new SimBattle(format, { p1, p2 }, 11).run({
    p1: new SearchEngine("p1", 11, SETTINGS, rows),
    p2: new GreedyEngine("p2", 11),
  });
  assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
  assert.ok(outcome.winner);
  assert.match(text(rows[0]?.action), /^team [1-6]{4}$/);
  assert.equal(new Set(text(rows[0]?.action).slice(5)).size, 4);
  const sources = new Set(rows.map((row) => text(row.submission_source)));
  assert.ok(sources.has("policy"));
  assert.ok([...sources].every((source) => source === "policy" || source === "automatic"));
  assert.ok(rows.every((row) => row.outcome === "accepted"));
});

test("a policy seat refuses to play without the live simulator", async () => {
  const seat = new GreedyEngine("p1", 1);
  await assert.rejects(
    seat.submit(
      { teamPreview: true, maxChosenTeamSize: 4, side: { pokemon: [{}, {}, {}, {}, {}, {}] } },
      { povLines: [], submissionId: "s1" },
    ),
    /none attached/,
  );
});
