import assert from "node:assert/strict";
import test from "node:test";
import bundleJson from "../public/season-bundle.json" with { type: "json" };
import type { Match, SeasonBundle } from "../lib/season.ts";

const season = bundleJson as unknown as SeasonBundle;

function matches(): Match[] {
  return [
    ...season.weeks.flatMap((week) => week.matches),
    ...(season.playoffs?.rounds.flatMap((round) => round.flatMap((slot) => (slot.match ? [slot.match] : []))) ?? []),
  ];
}

test("released matches alone expose replays", () => {
  for (const match of matches()) {
    if (match.status === "scheduled") {
      assert.equal(match.seriesId, null);
      assert.equal(match.score, null);
      continue;
    }
    assert.ok(match.seriesId);
    assert.ok(season.replays[match.seriesId]);
  }
});

test("game summaries use exact draft board ids", () => {
  const boardIds = new Set(season.board.map((pokemon) => pokemon.id));
  for (const match of matches()) {
    for (const game of match.games) {
      for (const id of game.brought.flat()) assert.ok(boardIds.has(id), `unknown brought id ${id}`);
      for (const id of game.megaEvolved) if (id !== null) assert.ok(boardIds.has(id), `unknown Mega id ${id}`);
      for (const id of game.faints.flatMap((side) => Object.keys(side))) {
        assert.ok(boardIds.has(id), `unknown faint id ${id}`);
      }
    }
  }
});
