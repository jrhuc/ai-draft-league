import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  acceptedBattleActionEntries,
  type GameSource,
  newBattle,
  pendingSides,
  replayGame,
} from "../src/fork.js";
import { greedyCommand } from "../src/position-value.js";
import { seededRng } from "../src/random.js";
import { parseReplay } from "../src/replay-log.js";
import { ReplaySimulator } from "../src/replay-sim.js";
import { loadShowdown } from "../src/showdown.js";
import { loadPool } from "../src/teams.js";
import { text } from "../src/value.js";

/** A game with switches, status moves and Protects in it, played from a seed nobody recorded. */
function playedGame(first: number, second: number, salt: string) {
  const pool = loadPool();
  const source: GameSource = {
    format: pool.format,
    seed: [11, 12, 13, 14],
    names: { p1: "Ash", p2: "Gary" },
    packed: { p1: pool.teams[first]!.packed, p2: pool.teams[second]!.packed },
    choices: { p1: [], p2: [] },
  };
  const battle = newBattle(source);
  const rng = seededRng(salt);
  while (!battle.ended) {
    for (const pid of pendingSides(battle)) {
      if (battle.ended) break;
      let command = greedyCommand(battle, pid, rng, 0.35);
      if (!battle.choose(pid, command)) {
        command = acceptedBattleActionEntries(battle, pid)[0]!.command;
        assert.ok(battle.choose(pid, command));
      }
      source.choices[pid].push(command);
    }
  }
  const replay = replayGame(source);
  const { Teams } = loadShowdown();
  return {
    replay,
    game: parseReplay("test-1", pool.format, replay.publicLog.join("\n")),
    sets: { p1: Teams.unpack(source.packed.p1)!, p2: Teams.unpack(source.packed.p2)! },
  };
}

function shownHp(condition: string): number {
  const [current = 0, maximum = 1] = condition.split(" ", 1)[0]!.split("/").map(Number);
  return condition.endsWith("fnt") ? 0 : (100 * current) / maximum;
}

test("a public log with both spreads known is rebuilt decision for decision", () => {
  for (const [first, second, salt] of [
    [3, 4, "a"],
    [0, 5, "b"],
    [2, 1, "c"],
  ] as const) {
    const { replay, game, sets } = playedGame(first, second, salt);
    const rebuilt = new ReplaySimulator(game, sets).run();
    assert.equal(rebuilt.divergence, null);
    assert.deepEqual(rebuilt.notes, []);
    assert.equal(rebuilt.positions.length, replay.positions.length);
    for (const [index, position] of rebuilt.positions.entries()) {
      const truth = replay.positions[index]!;
      assert.equal(position.turn, truth.turn);
      assert.deepEqual(position.pending, truth.pending);
      for (const pid of ["p1", "p2"] as const) {
        const fielded = (request: (typeof truth.requests)[typeof pid]) =>
          (request.side?.pokemon ?? []).filter((pokemon) => pokemon.active);
        const wanted = fielded(truth.requests[pid]);
        const got = fielded(position.requests[pid]);
        assert.deepEqual(
          got.map((pokemon) => [pokemon.ident, pokemon.stats]),
          wanted.map((pokemon) => [pokemon.ident, pokemon.stats]),
        );
        for (const [slot, pokemon] of got.entries())
          assert.ok(
            Math.abs(shownHp(text(pokemon.condition)) - shownHp(text(wanted[slot]!.condition))) <
              1.5,
            `${pokemon.ident} on turn ${position.turn}`,
          );
      }
    }
  }
});

test("a side whose stat points are hidden is rebuilt from assumed ones", () => {
  const { replay, game, sets } = playedGame(3, 4, "a");
  const rebuilt = new ReplaySimulator(game, { p1: sets.p1 }).run();
  assert.equal(rebuilt.divergence, null);
  assert.equal(rebuilt.positions.length, replay.positions.length);
  const blind = new ReplaySimulator(game).run();
  assert.equal(blind.divergence, null);
  assert.equal(blind.positions.at(-1)!.turn, replay.positions.at(-1)!.turn);
});

test("a log the simulator cannot follow reports where the two part", () => {
  const { game, sets } = playedGame(3, 4, "a");
  const turn = game.turns.find((candidate) =>
    candidate.lines.some((line) => line.startsWith("|move|")),
  )!;
  const moved = turn.lines.findIndex((line) => line.startsWith("|move|"));
  turn.lines[moved] = turn.lines[moved]!.replace(/^\|move\|([^|]+)\|[^|]+/, "|move|$1|Splash");
  const rebuilt = new ReplaySimulator(game, sets).run();
  assert.equal(rebuilt.divergence?.turn, turn.turn);
  assert.match(rebuilt.divergence?.want ?? "", /Splash/);
  assert.ok(rebuilt.positions.length > 0);
});
