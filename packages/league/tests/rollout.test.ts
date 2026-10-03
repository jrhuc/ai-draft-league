import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { cloneBattle, newBattle, pendingSides } from "../src/fork.js";
import { rollOut, rolloutCommands } from "../src/rollout.js";
import { loadPool } from "../src/teams.js";

function opening(first: number, second: number, seed: number) {
  const pool = loadPool();
  const battle = newBattle({
    format: pool.format,
    seed: [seed, 2, 3, 4],
    names: { p1: "A", p2: "B" },
    packed: { p1: pool.teams[first]!.packed, p2: pool.teams[second]!.packed },
    choices: { p1: [], p2: [] },
  });
  battle.choose("p1", "team 1234");
  battle.choose("p2", "team 1234");
  return battle;
}

const played = (lines: string[]) => lines.filter((line) => !line.startsWith("|t:|"));

test("rollout choices are accepted and projecting them leaves the battle's future unchanged", () => {
  for (const [first, second, seed] of [
    [0, 1, 1],
    [3, 4, 2],
    [5, 2, 3],
  ] as const) {
    const battle = opening(first, second, seed);
    while (!battle.ended && battle.turn < 30) {
      const untouched = cloneBattle(battle);
      const commands = rolloutCommands(battle);
      for (const pid of pendingSides(battle)) {
        assert.ok(battle.choose(pid, commands[pid]!), `${pid} ${commands[pid]}`);
        assert.ok(untouched.choose(pid, commands[pid]!));
      }
      assert.deepEqual(played(battle.log), played(untouched.log));
      assert.deepEqual(battle.prng.getSeed(), untouched.prng.getSeed());
    }
    assert.ok(battle.ended);
  }
});

test("Fake Out is chosen on a mon's first turn out and never after", () => {
  const battle = opening(4, 0, 1);
  const raichu = battle.getSide("p1").active[0]!;
  const fakeOut = `move ${raichu.moveSlots.findIndex((slot) => slot.id === "fakeout") + 1}`;
  const lead = (command: string | undefined) => command?.split(", ")[0] ?? "";
  const first = rolloutCommands(battle);
  assert.ok(lead(first.p1).startsWith(`${fakeOut} `), first.p1);
  for (const pid of pendingSides(battle)) assert.ok(battle.choose(pid, first[pid]!));
  while (battle.getSide("p1").activeRequest?.wait) {
    const replacements = rolloutCommands(battle);
    for (const pid of pendingSides(battle)) assert.ok(battle.choose(pid, replacements[pid]!));
  }
  assert.equal(battle.turn, 2);
  assert.equal(battle.getSide("p1").active[0], raichu);
  const request = battle.getSide("p1").activeRequest;
  assert.ok(request && "active" in request);
  assert.ok(request.active[0]!.moves.find((move) => move.id === "fakeout")?.disabled);
  assert.ok(!lead(rolloutCommands(battle).p1).startsWith(`${fakeOut} `));
});

test("a rollout finishes the game or stops at its turn limit", () => {
  const finished = opening(1, 0, 4);
  assert.ok(rollOut(finished, 40));
  const cut = opening(1, 0, 4);
  assert.equal(rollOut(cut, 1), null);
  assert.equal(cut.turn, 2);
});
