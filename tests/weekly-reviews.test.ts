import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import type { WeeklyReview } from "../lib/season.ts";
import { presentWeeklyReview, weeklyReviewsForFranchise } from "../lib/weekly-reviews.ts";
import { assertSeasonBundleSchemaRoot } from "../lib/protocol.ts";

function review(overrides: Partial<WeeklyReview> = {}): WeeklyReview {
  return {
    week: 1,
    stage: "week",
    franchiseId: "alpha",
    rosterVersion: 1,
    reasoning: "Reviewed the week.",
    notebookChanged: true,
    fallback: false,
    ...overrides,
  };
}

test("keeps the TypeScript root contract synchronized with the required schema fields", () => {
  const schema = JSON.parse(
    fs.readFileSync(new URL("../public/season-bundle-v2.schema.json", import.meta.url), "utf8"),
  ) as { required: string[] };
  assert.doesNotThrow(() => assertSeasonBundleSchemaRoot(schema));
  const missingWeeklyReviews = structuredClone(schema);
  missingWeeklyReviews.required = missingWeeklyReviews.required.filter((key) => key !== "weeklyReviews");
  assert.throws(() => assertSeasonBundleSchemaRoot(missingWeeklyReviews), /TypeScript contract is out of sync/);
});

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

test("presents ordinary and reconciliation reviews distinctly", () => {
  assert.equal(presentWeeklyReview(review()).stageLabel, "Weekly review");
  assert.equal(presentWeeklyReview(review({ stage: "transactions" })).stageLabel, "Post-transaction reconciliation");
});

test("presents unchanged memory, fallback, and empty reasoning explicitly", () => {
  const presented = presentWeeklyReview(review({ reasoning: "  ", notebookChanged: false, fallback: true }));

  assert.equal(presented.memoryLabel, "Memory unchanged");
  assert.equal(presented.fallbackLabel, "Fallback review");
  assert.equal(presented.reasoningText, "No reasoning recorded.");
});
