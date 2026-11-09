import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { DraftBoardMon } from "../src/draft.js";
import { buildDraftLeagueSchedule } from "../src/draftleague-protocol.js";
import { transactionWindowResults } from "../src/draftleague-roundrobin.js";
import type { CompletedSeries } from "../src/league-coordinator.js";
import { mon } from "./draft-test-helpers.js";

test("a window's past results list each opponent's roster as it stood for that series", () => {
  const entrants = ["fake:a", "fake:b", "fake:c", "fake:d"];
  const { plans } = buildDraftLeagueSchedule(entrants.length, 7);
  const weekOne = plans.find((plan) => plan.round === 1 && plan.entrants)!;
  const [a, b] = weekOne.entrants!;
  const weekTwo = plans.find((plan) => plan.round === 2 && plan.entrants?.includes(b))!;
  const later = weekTwo.entrants!.find((entrant) => entrant !== b)!;

  const drafted: DraftBoardMon[][] = [
    [mon("garchomp")],
    [mon("incineroar")],
    [mon("sinistcha")],
    [mon("farigiraf")],
  ];
  const afterWindow = drafted.map((roster, entrant) =>
    entrant === b ? [mon("gholdengo")] : roster,
  );
  const completed = new Map<number, CompletedSeries>(
    plans
      .filter((plan) => plan.stage === "roundrobin" && plan.round <= 2)
      .map((plan) => [
        plan.index,
        {
          row: { players: { p1: entrants[plan.entrants![0]]!, p2: entrants[plan.entrants![1]]! } },
          score: { p1: 2, p2: 1 },
          winnerSide: "p1",
        },
      ]),
  );
  const line = (roster: readonly DraftBoardMon[]) =>
    roster.map((entry) => `${entry.id} (${entry.cost})`).join(", ");

  const results = transactionWindowResults(
    { entrants, plans },
    { completed, rosterStateFor: (plan) => (plan.round === 1 ? drafted : afterWindow) },
    2,
  );

  assert.deepEqual(results[a]![0], {
    entrant: a,
    opponent: b,
    week: 1,
    score: [2, 1],
    result: "won",
    opponentRoster: line(drafted[b]!),
  });
  assert.deepEqual(results[b]![0], {
    entrant: b,
    opponent: a,
    week: 1,
    score: [1, 2],
    result: "lost",
    opponentRoster: line(drafted[a]!),
  });
  assert.equal(
    results[later]!.find((result) => result.week === 2)!.opponentRoster,
    line(afterWindow[b]!),
  );
  assert.deepEqual(
    results.map((list) => list.length),
    [2, 2, 2, 2],
  );
});
