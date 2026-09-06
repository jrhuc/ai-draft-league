import type { DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { playSeries } from "./draftleague-series.js";
import { cloneMemory } from "./franchise-memory.js";
import { type GameSummary, seriesGameSummaries } from "./game-usage.js";
import type { DraftLeagueContext, LeagueCoordinator } from "./league-coordinator.js";
import { type RosterUsageEntry, rosterUsage } from "./roster-usage.js";
import { mapLimit } from "./series.js";
import {
  describeTransactionHistory,
  runTradeWindow,
  type TradeWindowResult,
} from "./trade-window.js";
import {
  type ReviewStage,
  runWeeklyReview,
  type WeeklyReview,
  type WeeklyReviewSeries,
} from "./weekly-review.js";

type RoundRobinPhaseResult = { status: "complete" } | { status: "paused" };

function seasonSchedule(context: DraftLeagueContext) {
  return context.plans.flatMap((plan) =>
    plan.stage === "roundrobin" && plan.entrants
      ? [{ index: plan.index, week: plan.round, entrants: plan.entrants }]
      : [],
  );
}

function leagueRosterUsage(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  afterWeek: number,
): RosterUsageEntry[] {
  const games = new Map<number, GameSummary[]>();
  const build = (index: number, entrant: number) =>
    runtime.teambuilds.find((view) => view.seriesIndex === index && view.entrant === entrant);
  for (const plan of context.plans) {
    if (plan.stage !== "roundrobin" || plan.round > afterWeek || !plan.entrants) continue;
    const seriesId = runtime.completed.get(plan.index)?.row.series_id;
    if (!seriesId) continue;
    games.set(
      plan.index,
      seriesGameSummaries(context.runDir, seriesId, context.board.mons, [
        build(plan.index, plan.entrants[0]),
        build(plan.index, plan.entrants[1]),
      ]),
    );
  }
  const versionForWeek = (week: number) =>
    context.schedule.filter((window) => window.afterWeek < week).length;
  return rosterUsage({
    rosters: runtime.rosters.map((roster) => roster.map((mon) => mon.id)),
    plans: seasonSchedule(context),
    builds: runtime.teambuilds,
    games,
    throughWeek: afterWeek,
    owned: (entrant, week, monId) =>
      (runtime.rosterHistory[versionForWeek(week)] ?? runtime.rosters)[entrant]?.some(
        (mon) => mon.id === monId,
      ) ?? false,
  });
}

function reviewSeries(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  throughWeek: number,
): WeeklyReviewSeries[] {
  const list: WeeklyReviewSeries[] = [];
  for (const plan of context.plans) {
    if (plan.stage !== "roundrobin" || plan.round > throughWeek || !plan.entrants) continue;
    const completed = runtime.completed.get(plan.index);
    if (!completed) continue;
    const [a, b] = plan.entrants;
    const build = (entrant: number) =>
      runtime.teambuilds.find(
        (view) => view.seriesIndex === plan.index && view.entrant === entrant,
      );
    list.push({
      index: plan.index,
      week: plan.round,
      seriesId: completed.row.series_id ?? "",
      entrants: [a, b],
      score: [completed.score.p1, completed.score.p2],
      winner: completed.winnerSide === undefined ? null : completed.winnerSide === "p1" ? a : b,
      context: {
        [a]: runtime.franchises[a]!.opponentDossiers.get(plan.index) ?? "",
        [b]: runtime.franchises[b]!.opponentDossiers.get(plan.index) ?? "",
      },
      builds: { [a]: build(a), [b]: build(b) },
      rosters: { [a]: runtime.rosterStateFor(plan)[a]!, [b]: runtime.rosterStateFor(plan)[b]! },
    });
  }
  return list;
}

function adoptReviews(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  reviews: WeeklyReview[],
  week: number,
  stage: ReviewStage,
): void {
  for (const review of reviews) {
    if (
      review.roster_version !== runtime.windowArtifacts.length ||
      review.model !== context.entrants[review.entrant]
    ) {
      throw new Error(
        `run ${context.runId} week ${week} ${stage} review has invalid identity for entrant ${review.entrant} at roster version ${review.roster_version}`,
      );
    }
    runtime.franchises[review.entrant]!.memory = cloneMemory(review.memory);
  }
}

async function reviewWeek(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  week: number,
): Promise<void> {
  const { board, entrants, options, plans, schedule, weeks } = context;
  const missing = plans.find(
    (plan) =>
      plan.stage === "roundrobin" && plan.round <= week && !runtime.completed.has(plan.index),
  );
  if (missing) {
    throw new Error(
      `run ${context.runId} week ${week} review precedes scheduled series ${missing.index}`,
    );
  }
  const series = reviewSeries(context, runtime, week);
  const nextWindow = schedule.find((window) => window.afterWeek >= week);
  const reviews = await runWeeklyReview(
    {
      board,
      models: entrants,
      stage: "week",
      week,
      weeks: weeks.length,
      rosterVersion: runtime.windowArtifacts.length,
      rosters: runtime.rosters,
      memories: runtime.memories,
      standings: runtime.standings(),
      series,
      period: series.filter((entry) => entry.week === week).map((entry) => entry.index),
      schedule: seasonSchedule(context),
      transactions: describeTransactionHistory(runtime.windowArtifacts, entrants),
      nextWindowWeek: nextWindow ? nextWindow.afterWeek : null,
    },
    context.reviewOptions,
  );
  adoptReviews(context, runtime, reviews, week, "week");
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
}

async function runTransactionWindow(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  index: number,
): Promise<void> {
  const { entrants, options, plans, psDir, runDir, schedule, swapsAllowed } = context;
  const window = schedule[index]!;
  runtime.transition({ phase: "window", week: window.afterWeek, rosterVersion: index });
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
  const results: TradeWindowResult[][] = entrants.map(() => []);
  for (const plan of plans) {
    if (plan.stage !== "roundrobin" || plan.round > window.afterWeek || !plan.entrants) continue;
    const completed = runtime.completed.get(plan.index);
    if (!completed) continue;
    const [a, b] = plan.entrants;
    for (const [entrant, opponent, side] of [
      [a, b, "p1"],
      [b, a, "p2"],
    ] as const) {
      const other = side === "p1" ? "p2" : "p1";
      results[entrant]!.push({
        entrant,
        opponent,
        week: plan.round,
        score: [completed.score[side], completed.score[other]],
        result:
          completed.winnerSide === undefined
            ? "drew"
            : completed.winnerSide === side
              ? "won"
              : "lost",
        opponentRoster: runtime.franchises[opponent]!.roster.map(
          (mon) => `${mon.id} (${mon.cost})`,
        ).join(", "),
      });
    }
  }
  const artifact = await runTradeWindow(
    {
      board: context.board,
      models: entrants,
      teamNames: runtime.teamNames,
      rosters: runtime.rosters,
      budgets: runtime.budgets,
      memories: runtime.memories,
      standings: runtime.standings(),
      results,
      reflections: runtime.franchises.map(({ seriesNotes }) =>
        [...seriesNotes.entries()].sort(([a], [b]) => a - b).map(([, note]) => note),
      ),
      history: describeTransactionHistory(runtime.windowArtifacts, entrants),
      afterWeek: window.afterWeek,
      schedule: seasonSchedule(context),
      usage: leagueRosterUsage(context, runtime, window.afterWeek),
      swapsAllowed,
      swapsUsed: runtime.swapsUsed(),
    },
    {
      runDir,
      psDir,
      position: { afterWeek: window.afterWeek, index, count: schedule.length },
      tradesAllowed: window.tradesAllowed,
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
      signal: options.signal,
    },
  );
  runtime.adoptWindow(artifact);
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
  const seats = runtime.changedSeats(index);
  if (seats.length) {
    const nextWindow = schedule[index + 1];
    const reviews = await runWeeklyReview(
      {
        board: context.board,
        models: entrants,
        stage: "transactions",
        week: window.afterWeek,
        weeks: context.weeks.length,
        rosterVersion: index + 1,
        rosters: runtime.rosters,
        previousRosters: runtime.rosterHistory[index]!,
        seats,
        memories: runtime.memories,
        standings: runtime.standings(),
        series: [],
        period: [],
        schedule: seasonSchedule(context),
        transactions: describeTransactionHistory(runtime.windowArtifacts, entrants),
        nextWindowWeek: nextWindow ? nextWindow.afterWeek : null,
      },
      context.reviewOptions,
    );
    adoptReviews(context, runtime, reviews, window.afterWeek, "transactions");
  }
  runtime.transition({ phase: "roundrobin", week: window.afterWeek, rosterVersion: index + 1 });
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
}

/** Plays each week, reviews it, and runs any window scheduled after it; a paused status means the
 * run stopped at a requested week or cancellation, with every completed stage committed. */
export async function runRoundRobinPhase(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
): Promise<RoundRobinPhaseResult> {
  const { options, plans, schedule, weeks } = context;
  for (const index of weeks.keys()) {
    if (options.signal?.aborted) return { status: "paused" };
    const week = index + 1;
    runtime.transition({
      phase: "roundrobin",
      week,
      rosterVersion: runtime.windowArtifacts.length,
    });
    options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
    await mapLimit(
      plans.filter((plan) => plan.stage === "roundrobin" && plan.round === week),
      options.concurrency ?? 4,
      options.signal,
      (plan: DraftLeagueSeriesPlan, signal) => playSeries(context, runtime, plan, signal),
    );
    await reviewWeek(context, runtime, week);
    const windowIndex = schedule.findIndex((window) => window.afterWeek === week);
    if (windowIndex !== -1) await runTransactionWindow(context, runtime, windowIndex);
    if (options.throughWeek !== undefined && week >= options.throughWeek) {
      return { status: "paused" };
    }
  }
  return options.signal?.aborted ? { status: "paused" } : { status: "complete" };
}
