import type { WeeklyReview } from "./season";

export type WeeklyReviewPresentation = WeeklyReview & {
  stageLabel: "Weekly review" | "Post-transaction reconciliation";
  memoryLabel: "Memory updated" | "Memory unchanged";
  fallbackLabel: "Fallback review" | null;
  reasoningText: string;
};

const STAGE_ORDER: Record<WeeklyReview["stage"], number> = {
  week: 0,
  transactions: 1,
};

export function presentWeeklyReview(review: WeeklyReview): WeeklyReviewPresentation {
  return {
    ...review,
    stageLabel: review.stage === "transactions" ? "Post-transaction reconciliation" : "Weekly review",
    memoryLabel: review.notebookChanged ? "Memory updated" : "Memory unchanged",
    fallbackLabel: review.fallback ? "Fallback review" : null,
    reasoningText: review.reasoning.trim() || "No reasoning recorded.",
  };
}

export function weeklyReviewsForFranchise(reviews: readonly WeeklyReview[], franchiseId: string): WeeklyReviewPresentation[] {
  return reviews
    .filter((review) => review.franchiseId === franchiseId)
    .sort((a, b) => a.week - b.week || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
    .map(presentWeeklyReview);
}
