import assert from "node:assert/strict";
import test from "node:test";
import type { WeeklyReview } from "../lib/season.ts";
import { weeklyReviewsForFranchise } from "../lib/weekly-reviews.ts";

function review(overrides: Partial<WeeklyReview> = {}): WeeklyReview {
  return {
    week: 1,
    stage: "week",
    franchiseId: "alpha",
    rosterVersion: 1,
    reasoning: "Reviewed the week.",
    memoryPages: 2,
    memoryCharacters: 120,
    fallback: false,
    ...overrides,
  };
}


test("filters one franchise and orders each week before its reconciliation", () => {
  const reviews = weeklyReviewsForFranchise(
    [
      review({ week: 2, stage: "transactions", reasoning: "Reconciled." }),
      review({ week: 1, franchiseId: "beta" }),
      review({ week: 2, stage: "week", reasoning: "Week two." }),
      review({ week: 1, reasoning: "Week one." }),
    ],
    "alpha",
  );

  assert.deepEqual(
    reviews.map(({ week, stage, reasoningText }) => [week, stage, reasoningText]),
    [
      [1, "week", "Week one."],
      [2, "week", "Week two."],
      [2, "transactions", "Reconciled."],
    ],
  );
});

test("presents weekly, reconciliation, and fallback states", () => {
  const [weekly, reconciliation] = weeklyReviewsForFranchise(
    [review(), review({ week: 2, stage: "transactions", reasoning: "  ", fallback: true })],
    "alpha",
  );

  assert.equal(weekly?.stageLabel, "Weekly review");
  assert.equal(reconciliation?.stageLabel, "Post-transaction reconciliation");
  assert.equal(reconciliation?.fallbackLabel, "Fallback review");
  assert.equal(reconciliation?.reasoningText, "No reasoning recorded.");
});


