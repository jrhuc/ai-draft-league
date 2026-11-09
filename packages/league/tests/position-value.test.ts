import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { type BridgeEvent, EvalBridge } from "../src/eval-bridge.js";
import { type GameSource, replayGame } from "../src/fork.js";
import { valuePosition } from "../src/position-value.js";
import { loadPool } from "../src/teams.js";
import type { Pid } from "../src/types.js";

const SEED: [number, number, number, number] = [5, 6, 7, 8];

async function recordedGame() {
  const pool = loadPool();
  const players = {
    p1: { name: "A", team: pool.teams[0]!.packed },
    p2: { name: "B", team: pool.teams[1]!.packed },
  };
  const bridge = new EvalBridge(pool.format);
  const events: BridgeEvent[] = [];
  let event = await bridge.start({
    format: pool.format,
    seed: SEED,
    ...players,
    external: ["p1", "p2"],
  });
  while (event.kind === "decision") {
    events.push(event);
    event = (await bridge.submit(event.pid, "default")).next;
  }
  const submissions = bridge.result().submissions;
  const source: GameSource = {
    format: pool.format,
    seed: SEED,
    names: { p1: players.p1.name, p2: players.p2.name },
    packed: { p1: players.p1.team, p2: players.p2.team },
    choices: {
      p1: submissions.p1.map((row) => row.choice),
      p2: submissions.p2.map((row) => row.choice),
    },
  };
  return { pool, players, source, events, submissions, log: bridge.result().log };
}

test("a recorded game resumes at a chosen decision with the same request and its history", async () => {
  const { pool, players, source, events, submissions } = await recordedGame();
  const original = events.find(
    (event) => event.kind === "decision" && event.pid === "p1" && event.turn === 2,
  );
  assert.ok(original?.kind === "decision" && original.phase === "turn");
  const before = (pid: Pid) => submissions[pid].filter((row) => row.turn < 2).length;
  const bridge = new EvalBridge(pool.format);
  const resumed = await bridge.start({
    format: pool.format,
    seed: SEED,
    ...players,
    external: ["p1"],
    opponent: "greedy",
    script: {
      p1: source.choices.p1.slice(0, before("p1")),
      p2: source.choices.p2.slice(0, before("p2")),
    },
  });
  assert.equal(resumed.kind, "decision");
  assert.equal(resumed.decision, 1);
  assert.equal(resumed.turn, original.turn);
  assert.deepEqual(resumed.menus, original.menus);
  assert.deepEqual(resumed.request, original.request);
  assert.match(resumed.prompt, /Turn: /);
  const { choice } = await bridge.submit("p1", "default");
  assert.equal(choice, source.choices.p1[before("p1")]);
});

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
  const preview = replay.positions[0]!;
  assert.equal(valuePosition(preview, "p1"), null);
});
