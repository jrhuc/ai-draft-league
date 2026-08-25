import { expect, test } from "vite-plus/test";
import type { WeeklyReview } from "../src/lib/season";
import { weeklyReviewsForFranchise } from "../src/lib/weekly-reviews";

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

  expect(reviews.map(({ week, stage, reasoningText }) => [week, stage, reasoningText])).toEqual([
    [1, "week", "Week one."],
    [2, "week", "Week two."],
    [2, "transactions", "Reconciled."],
  ]);
});

test("presents weekly, reconciliation, and fallback states", () => {
  const [weekly, reconciliation] = weeklyReviewsForFranchise(
    [review(), review({ week: 2, stage: "transactions", reasoning: "  ", fallback: true })],
    "alpha",
  );

  expect(weekly?.stageLabel).toBe("Weekly review");
  expect(reconciliation?.stageLabel).toBe("Post-transaction reconciliation");
  expect(reconciliation?.fallbackLabel).toBe("Fallback review");
  expect(reconciliation?.reasoningText).toBe("No reasoning recorded.");
});
