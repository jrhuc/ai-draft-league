import { readFileSync } from "node:fs";
import { publicSeasonBundleSchema } from "league/protocol";
import { expect, test } from "vite-plus/test";
import { statusLabel } from "../src/lib/load";
import type { Match, SeasonBundle } from "../src/lib/season";

const season = publicSeasonBundleSchema.parse(
  JSON.parse(readFileSync(new URL("../public/season-bundle.json", import.meta.url), "utf8")),
);

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

function at(patch: Partial<SeasonBundle["season"]>, picks = season.draft.picks): SeasonBundle {
  return { ...season, season: { ...season.season, ...patch }, draft: { ...season.draft, picks } };
}

test("the status label follows the draft, the released weeks, and the released playoff rounds", () => {
  const total = season.franchises.length * season.season.board.picksPerFranchise;
  expect(statusLabel(at({ status: "draft" }, season.draft.picks.slice(0, 5)))).toBe(
    `Drafting · pick 6 of ${total}`,
  );
  expect(statusLabel(at({ status: "draft" }))).toBe("Draft complete");
  expect(statusLabel(at({ status: "regular-season", releasedThroughWeek: 3, totalWeeks: 7 }))).toBe(
    "Through week 3 of 7",
  );
  const playoffs = {
    status: "playoffs",
    releasedThroughWeek: 7,
    totalWeeks: 7,
    playoffRounds: 2,
  } satisfies Partial<SeasonBundle["season"]>;
  expect(statusLabel(at({ ...playoffs, releasedPlayoffRounds: 0 }))).toBe("Through week 7 of 7");
  expect(statusLabel(at({ ...playoffs, releasedPlayoffRounds: 1 }))).toBe(
    "Playoffs · round 1 of 2",
  );
  expect(statusLabel(at({ status: "complete" }))).toBe("Season complete");
});
