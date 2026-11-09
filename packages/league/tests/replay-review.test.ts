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
import { ReplayReview } from "../src/replay-review.js";
import { loadShowdown } from "../src/showdown.js";
import { loadPool } from "../src/teams.js";
import { text } from "../src/value.js";

function playedGame() {
  const pool = loadPool();
  const source: GameSource = {
    format: pool.format,
    seed: [5, 6, 7, 8],
    names: { p1: "Ash", p2: "Gary" },
    packed: { p1: pool.teams[3]!.packed, p2: pool.teams[4]!.packed },
    choices: { p1: [], p2: [] },
  };
  const battle = newBattle(source);
  const rng = seededRng("replay-review");
  while (!battle.ended) {
    for (const pid of pendingSides(battle)) {
      if (battle.ended) break;
      let command = greedyCommand(battle, pid, rng);
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
    source,
    replay,
    game: parseReplay("test-1", pool.format, replay.publicLog.join("\n")),
    paste: Teams.export(Teams.unpack(source.packed.p1)!),
  };
}

test("a public log splits into the decisions of the game it records", () => {
  const { source, replay, game } = playedGame();
  assert.deepEqual(game.players, source.names);
  assert.equal(game.turns.length, replay.turns);
  assert.deepEqual(
    game.turns.map((turn) => turn.turn),
    game.turns.map((_, index) => index + 1),
  );
  assert.equal(game.winner && source.names[game.winner], replay.winner);
  assert.ok(game.sheets.p1 && game.sheets.p2);
  assert.equal(game.teamSize.p1, 4);
});

test("a team file restores the exact stats a public log leaves out", () => {
  const { replay, game, paste } = playedGame();
  const review = new ReplayReview(game, { paste });
  assert.equal(review.pov, "p1");
  let megaChecked = false;
  let checked = 0;
  for (const position of replay.positions) {
    const request = position.requests.p1;
    if (!position.pending.includes("p1") || request.teamPreview || request.forceSwitch) continue;
    const state = review.stateAt(position.turn);
    for (const pokemon of request.side?.pokemon ?? []) {
      const species = text(pokemon.details).split(",", 1)[0]!;
      const mon = state.visibleMons("p1").find((entry) => entry.species === species);
      assert.ok(mon, `${species} is missing on turn ${position.turn}`);
      assert.equal(mon.brought, true);
      const [current, maximum] = text(pokemon.condition).split(" ", 1)[0]!.split("/").map(Number);
      if (!maximum) {
        assert.ok(mon.fainted);
        continue;
      }
      assert.deepEqual(mon.stats, pokemon.stats);
      const [shown, shownMaximum] = mon.hp!.split(" ", 1)[0]!.split("/").map(Number);
      assert.equal(shownMaximum, maximum);
      assert.ok(Math.abs(shown! - current!) <= Math.ceil(maximum / 100));
      megaChecked ||= mon.mega;
      checked += 1;
    }
  }
  assert.ok(checked > 8);
  assert.ok(megaChecked);
  assert.match(review.render(), /stats Max HP \d+, Attack \d+/);
});

test("without a team file both seats read the same calculation", () => {
  const { replay, game } = playedGame();
  const { Dex } = loadShowdown();
  const turn = replay.positions.find((position) => position.requests.p1.active);
  assert.ok(turn);
  const actives = (pid: "p1" | "p2") =>
    (turn.requests[pid].side?.pokemon ?? [])
      .filter((pokemon) => pokemon.active)
      .map((pokemon) => text(pokemon.details).split(",", 1)[0]!);
  const move = (turn.requests.p1.active?.[0]?.moves ?? [])
    .map((entry) => text(entry.move))
    .find((name) => Dex.moves.get(name).category !== "Status");
  assert.ok(move);
  const call = {
    turn: turn.turn,
    tool: "estimate_damage",
    args: { attacker: actives("p1")[0]!, defender: actives("p2")[0]!, move },
  };
  const fromAttacker = new ReplayReview(game, { as: "Ash" }).call(call);
  assert.match(fromAttacker, /% of maximum HP/);
  assert.equal(new ReplayReview(game, { as: "p2" }).call(call), fromAttacker);
  const preview = new ReplayReview(game, { as: "Ash" }).call({ ...call, turn: 0 });
  assert.match(preview, /% of maximum HP/);
});

test("a replay needs to know whose game it is", () => {
  const { game, paste } = playedGame();
  assert.throws(() => new ReplayReview(game), /whose game/);
  assert.throws(() => new ReplayReview(game, { as: "Misty" }), /did not play/);
  const mirrored = parseReplay(
    "test-2",
    game.formatId,
    [
      "|player|p1|Ash",
      "|player|p2|Gary",
      ...game.preview
        .filter((line) => !line.startsWith("|poke|p2|"))
        .flatMap((line) =>
          line.startsWith("|poke|p1|") ? [line, line.replace("|poke|p1|", "|poke|p2|")] : [line],
        ),
      "|start",
    ].join("\n"),
  );
  assert.throws(() => new ReplayReview(mirrored, { paste }), /both players/);
});

test("a rebuilt game opens any turn for alternatives", () => {
  const { game, paste } = playedGame();
  const review = new ReplayReview(game, { paste });
  assert.match(review.render(), /Simulator: rebuilt all \d+ turns line for line/);
  const turn = review
    .simulation()
    .positions.find((position) => position.turn > 1 && position.pending.length === 2)!.turn;
  const options = review.fork({ turn, do: "options", samples: 1 });
  const played = [...options.matchAll(/\(played: ([^)]+)\)/g)].map((match) => match[1]!);
  assert.equal(played.length, 2);
  for (const command of played) assert.ok(options.includes(`  ${command} `));
  const play = review.fork({ turn, do: "play", samples: 20 });
  assert.equal(play.match(/\(as played\)/g)?.length, 2);
  assert.match(play, /Over 20 rolls of the dice: /);
  const table = review.fork({ turn, do: "table", samples: 1 });
  assert.match(table, /Your choices by the worst reply to each:/);
  assert.match(table, /<- played/);
  assert.throws(
    () => review.fork({ turn: game.turns.length + 5, do: "options", samples: 1 }),
    /no decision of yours/,
  );
});
