import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RandomEngine } from "../src/battle-agent.js";
import { type GameSource, replayGame } from "../src/fork.js";
import { valuePosition } from "../src/position-value.js";
import { SimBattle } from "../src/sim.js";
import { loadPool } from "../src/teams.js";
import type { JsonObject } from "../src/types.js";
import { text } from "../src/value.js";

const SEED: [number, number, number, number] = [5, 6, 7, 8];

async function recordedGame() {
  const pool = loadPool();
  const players = {
    p1: { name: "A", team: pool.teams[0]!.packed },
    p2: { name: "B", team: pool.teams[1]!.packed },
  };
  const p1: JsonObject[] = [];
  const p2: JsonObject[] = [];
  const outcome = await new SimBattle(pool.format, players, SEED).run({
    p1: new RandomEngine("p1", 1, p1),
    p2: new RandomEngine("p2", 2, p2),
  });
  const choices = (decisions: JsonObject[]) =>
    decisions.filter((row) => row.outcome === "accepted").map((row) => text(row.action));
  const source: GameSource = {
    format: pool.format,
    seed: SEED,
    names: { p1: players.p1.name, p2: players.p2.name },
    packed: { p1: players.p1.team, p2: players.p2.team },
    choices: { p1: choices(p1), p2: choices(p2) },
  };
  return { source, log: outcome.log };
}

test("recorded turn decisions are valued over every accepted action", async () => {
  const { source, log } = await recordedGame();
  const replay = replayGame(source, log);
  assert.ok(replay.verified);
  const position = replay.positions.findLast(
    (candidate) => candidate.pending.length === 2 && !candidate.requests.p1.forceSwitch,
  );
  assert.ok(position);
  const value = valuePosition(position, "p1", { samples: 2, epsilon: 0.25, maxTurns: 30, salt: 1 });
  assert.ok(value);
  assert.ok(value.actions.length > 0);
  assert.ok(value.rollouts >= value.actions.length * 4);
  assert.ok(value.actions.every((action) => action.value >= 0 && action.value <= 1));
  assert.ok(value.actions.some((action) => action.command === value.recorded));
  assert.ok(value.actions.some((action) => action.command === value.greedy));
  assert.deepEqual(valuePosition(position, "p1", value.settings), value);
  const recorded = value.actions.filter((action) => action.command === value.recorded);
  assert.deepEqual(
    valuePosition(position, "p1", value.settings, undefined, [value.recorded ?? ""])?.actions,
    recorded,
  );
  assert.equal(valuePosition(replay.positions[0]!, "p1"), null);
});
