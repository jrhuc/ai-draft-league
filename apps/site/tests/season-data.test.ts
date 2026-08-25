import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import type { Match, SeasonBundle } from "../src/lib/season";

// SAFETY: season-bundle.json is the producer's exported artifact; SeasonBundle declares its
// shape, and these assertions are exactly what verify that declaration holds.
const season = JSON.parse(
  readFileSync(new URL("../public/season-bundle.json", import.meta.url), "utf8"),
) as SeasonBundle;

function matches(): Match[] {
  return [
    ...season.weeks.flatMap((week) => week.matches),
    ...(season.playoffs?.rounds.flatMap((round) =>
      round.flatMap((slot) => (slot.match ? [slot.match] : [])),
    ) ?? []),
  ];
}

test("released matches alone expose replays", () => {
  for (const match of matches()) {
    if (match.status === "scheduled") {
      expect(match.seriesId).toBeNull();
      expect(match.score).toBeNull();
      continue;
    }
    const { seriesId } = match;
    expect(seriesId).toBeTruthy();
    if (!seriesId) continue;
    expect(season.replays[seriesId]).toBeTruthy();
  }
});

test("game summaries use exact draft board ids", () => {
  const boardIds = new Set(season.board.map((pokemon) => pokemon.id));
  for (const match of matches()) {
    for (const game of match.games) {
      for (const id of game.brought.flat())
        expect(boardIds.has(id), `unknown brought id ${id}`).toBe(true);
      for (const id of game.megaEvolved)
        if (id !== null) expect(boardIds.has(id), `unknown Mega id ${id}`).toBe(true);
      for (const id of game.faints.flatMap((side) => Object.keys(side))) {
        expect(boardIds.has(id), `unknown faint id ${id}`).toBe(true);
      }
    }
  }
});
