import type { DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { rankedTable } from "./draftleague-protocol.js";
import type { DraftLeagueContext } from "./draftleague-state.js";
import { DraftLeagueRuntime, sortedSeries } from "./draftleague-state.js";
import type { SeriesRecord } from "./records.js";
import { mapLimit } from "./series.js";
import {
  describeTransactionHistory,
  type RunTradeWindowOptions,
  runTradeWindow,
  type TradeWindowResult,
  transactionEpochDir,
} from "./trade-window.js";

interface RoundRobinOperations {
  playSeries: (plan: DraftLeagueSeriesPlan, signal: AbortSignal) => Promise<SeriesRecord>;
  reviewWeek: (week: number) => Promise<void>;
  reconcileWindow: (index: number) => Promise<void>;
}

export type RoundRobinPhaseResult =
  | { status: "complete" }
  | { status: "paused"; results: SeriesRecord[] };

export async function runTransactionPhase(
  context: DraftLeagueContext,
  runtime: DraftLeagueRuntime,
  index: number,
): Promise<void> {
  const { entrants, options, plans, psDir, runDir, schedule, swapsAllowed } = context;
  const window = schedule[index];
  if (!window || runtime.windowArtifacts.length > index) return;
  runtime.progress = {
    phase: "window",
    week: window.afterWeek,
    rosterVersion: runtime.windowArtifacts.length,
  };
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
  const preWindowRosters = runtime.rosters.map((roster) => [...roster]);
  const windowResults: TradeWindowResult[][] = entrants.map(() => []);
  for (const plan of plans) {
    if (plan.stage !== "roundrobin" || plan.round > window.afterWeek || !plan.entrants) continue;
    if (!runtime.completed.has(plan.index)) continue;
    const [a, b] = plan.entrants;
    const { score, winnerSide } = runtime.outcomeFor(plan);
    for (const [entrant, opponent, side] of [
      [a, b, "p1"],
      [b, a, "p2"],
    ] as const) {
      const other = side === "p1" ? "p2" : "p1";
      windowResults[entrant]!.push({
        entrant,
        opponent,
        week: plan.round,
        score: [score[side], score[other]],
        result: winnerSide === undefined ? "drew" : winnerSide === side ? "won" : "lost",
        opponentRoster: preWindowRosters[opponent]!.map((mon) => `${mon.id} (${mon.cost})`).join(
          ", ",
        ),
      });
    }
  }
  const tradeState = {
    board: context.board,
    models: entrants,
    teamNames: runtime.teamNames,
    rosters: runtime.rosters,
    budgets: runtime.budgets,
    memories: runtime.memories,
    standings: rankedTable(runtime.table),
    results: windowResults,
    reflections: runtime.reflectionNotes.map((notes) =>
      [...notes.entries()].sort(([a], [b]) => a - b).map(([, note]) => note),
    ),
    history: describeTransactionHistory(runtime.windowArtifacts, entrants),
    swapsAllowed,
    swapsUsed: runtime.swapsUsed(),
  };
  const tradeOptions: RunTradeWindowOptions = {
    epochDir: transactionEpochDir(runDir, window.afterWeek),
    psDir,
    position: { afterWeek: window.afterWeek, index, count: schedule.length },
    tradesAllowed: window.tradesAllowed,
    reasoning: options.reasoning,
    reasoningByModel: options.reasoningByModel,
    apiKeys: options.apiKeys,
    signal: options.signal,
  };
  const artifact = await runTradeWindow(tradeState, tradeOptions);
  runtime.windowArtifacts.push(artifact);
  runtime.rosterHistory.push(runtime.rosters.map((roster) => [...roster]));
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
}

export async function runRoundRobinPhase(
  context: DraftLeagueContext,
  runtime: DraftLeagueRuntime,
  operations: RoundRobinOperations,
): Promise<RoundRobinPhaseResult> {
  const { options, plans, schedule, sequentialWeeks, weeks } = context;
  const stopWeek = options.throughWeek;
  const scheduleSeries = async (scheduled: DraftLeagueSeriesPlan[]): Promise<void> => {
    runtime.results.push(
      ...(await mapLimit(
        scheduled,
        options.concurrency ?? 4,
        options.signal,
        operations.playSeries,
      )),
    );
  };
  const paused = (): RoundRobinPhaseResult => ({
    status: "paused",
    results: sortedSeries(runtime.results),
  });
  const completeWindow = async (index: number, week: number): Promise<void> => {
    await runTransactionPhase(context, runtime, index);
    await operations.reconcileWindow(index);
    runtime.progress = {
      phase: "roundrobin",
      week,
      rosterVersion: runtime.windowArtifacts.length,
    };
  };

  if (sequentialWeeks || stopWeek !== undefined) {
    for (const index of weeks.keys()) {
      if (options.signal?.aborted) return paused();
      const currentWeek = index + 1;
      runtime.progress = {
        phase: "roundrobin",
        week: currentWeek,
        rosterVersion: runtime.windowArtifacts.length,
      };
      options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
      await scheduleSeries(
        plans.filter(
          (plan) =>
            plan.stage === "roundrobin" &&
            plan.round === currentWeek &&
            !runtime.completed.has(plan.index),
        ),
      );
      await operations.reviewWeek(currentWeek);
      const windowIndex = schedule.findIndex((window) => window.afterWeek === currentWeek);
      if (windowIndex !== -1) await completeWindow(windowIndex, currentWeek);
      if (stopWeek !== undefined && currentWeek >= stopWeek) {
        options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
        return paused();
      }
    }
  } else {
    let firstWeek = 1;
    for (const [index, window] of schedule.entries()) {
      runtime.progress = {
        phase: "roundrobin",
        week: window.afterWeek,
        rosterVersion: runtime.windowArtifacts.length,
      };
      options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
      await scheduleSeries(
        plans.filter(
          (plan) =>
            plan.stage === "roundrobin" &&
            plan.round >= firstWeek &&
            plan.round <= window.afterWeek &&
            !runtime.completed.has(plan.index),
        ),
      );
      if (options.signal?.aborted) return paused();
      await operations.reviewWeek(window.afterWeek);
      await completeWindow(index, window.afterWeek);
      firstWeek = window.afterWeek + 1;
    }
    runtime.progress = {
      phase: "roundrobin",
      week: weeks.length,
      rosterVersion: runtime.windowArtifacts.length,
    };
    options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
    await scheduleSeries(
      plans.filter(
        (plan) =>
          plan.stage === "roundrobin" &&
          plan.round >= firstWeek &&
          !runtime.completed.has(plan.index),
      ),
    );
    if (options.signal?.aborted) return paused();
    await operations.reviewWeek(weeks.length);
  }
  return options.signal?.aborted ? paused() : { status: "complete" };
}
