import type { DraftBoardMon } from "./draft.js";
import type { DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { buildDraftPlayoffBracket, rankedTable } from "./draftleague-protocol.js";
import type { DraftLeagueContext, StoredSeriesOutcome } from "./draftleague-state.js";
import { DraftLeagueRuntime } from "./draftleague-state.js";
import {
  postWindowEvidence,
  promoteDraftOnlyConfig,
  requireTransactionResultPrefix,
} from "./league-store.js";
import type { SeriesRecord } from "./records.js";
import type { TeambuildView } from "./views.js";
import { applyBracketOutcome } from "./tournament.js";
import {
  describeTransactionHistory,
  readValidatedTradeWindow,
  transactionArtifactPaths,
  transactionEpochDir,
} from "./trade-window.js";
import type { Pid } from "./types.js";

interface StoredBuild {
  packed: string;
  view: TeambuildView;
}

export interface DraftLeagueResumeOperations {
  validateStoredRoundRobin: (version: number) => void;
  adoptStoredReview: (week: number) => boolean;
  adoptStoredReconciliation: (index: number) => boolean;
  storedBuildFor: (
    plan: DraftLeagueSeriesPlan,
    entrant: number,
    opponent: number,
    rosterState: readonly DraftBoardMon[][],
  ) => StoredBuild;
  validateStoredSeriesEvidence: (
    row: SeriesRecord,
    plan: DraftLeagueSeriesPlan,
    pair: [number, number],
    builds: Record<Pid, StoredBuild>,
    rosterState: readonly DraftBoardMon[][],
  ) => StoredSeriesOutcome;
  applyOutcome: (plan: DraftLeagueSeriesPlan) => void;
}

export function preflightStoredLeague(
  context: DraftLeagueContext,
  runtime: DraftLeagueRuntime,
  operations: DraftLeagueResumeOperations,
): void {
  const {
    board,
    configuredTransactions,
    entrants,
    plans,
    reviewWeeks,
    runDir,
    runId,
    schedule,
    stored,
    storedRows,
    storedSchedule,
    swapsAllowed,
  } = context;
  const { completed, results, storedOutcomes, teambuilds, windowArtifacts } = runtime;

  operations.validateStoredRoundRobin(0);
  if (stored) {
    for (const week of reviewWeeks) {
      if (!operations.adoptStoredReview(week)) {
        const epoch = schedule.find((window) => window.afterWeek === week);
        const evidence = [
          ...(epoch ? transactionArtifactPaths(transactionEpochDir(runDir, week)) : []),
          ...postWindowEvidence(runDir, storedRows.all, plans, week),
        ];
        if (evidence.length) {
          throw new Error(
            `run ${runId} has evidence past its week-${week} review barrier but lacks a complete review: ${evidence.join(", ")}`,
          );
        }
        break;
      }
      const index = schedule.findIndex((window) => window.afterWeek === week);
      if (index === -1) continue;
      const window = schedule[index]!;
      const epochDir = transactionEpochDir(runDir, window.afterWeek);
      if (transactionArtifactPaths(epochDir).length) {
        requireTransactionResultPrefix(runId, storedRows.all, plans, window.afterWeek);
      }
      const artifact = readValidatedTradeWindow(
        epochDir,
        {
          board,
          models: entrants,
          teamNames: runtime.teamNames,
          rosters: runtime.rosters,
          budgets: runtime.budgets,
          memories: runtime.memories,
          standings: runtime.standingsThrough(window.afterWeek),
          results: entrants.map(() => []),
          reflections: entrants.map(() => []),
          history: describeTransactionHistory(windowArtifacts, entrants),
          swapsAllowed,
          swapsUsed: runtime.swapsUsed(),
        },
        window,
      );
      if (!artifact) {
        const evidence = postWindowEvidence(runDir, storedRows.all, plans, window.afterWeek);
        if (evidence.length) {
          throw new Error(
            `run ${runId} has evidence past its week-${window.afterWeek} transaction barrier but lacks authoritative window artifacts: ${evidence.join(", ")}`,
          );
        }
        break;
      }
      runtime.adoptWindow(artifact);
      if (!operations.adoptStoredReconciliation(index)) {
        const evidence = postWindowEvidence(runDir, storedRows.all, plans, window.afterWeek);
        if (evidence.length) {
          throw new Error(
            `run ${runId} has evidence past its week-${window.afterWeek} transaction barrier but lacks the reconciliation review of every changed roster: ${evidence.join(", ")}`,
          );
        }
        break;
      }
      operations.validateStoredRoundRobin(index + 1);
    }
  }

  for (const plan of plans) {
    if (plan.stage !== "roundrobin") continue;
    const row = completed.get(plan.index);
    if (!row) continue;
    operations.applyOutcome(plan);
    results.push(row);
  }

  if (storedRows.playoffs.size) {
    const missingRoundRobin = plans.find(
      (plan) => plan.stage === "roundrobin" && !completed.has(plan.index),
    );
    if (missingRoundRobin) {
      throw new Error(
        `run ${runId} has a playoff result before scheduled round-robin series ${missingRoundRobin.index}; it cannot resume`,
      );
    }
    const playoffPlans = plans.filter((plan) => plan.stage === "playoff");
    runtime.playoffBracketRounds = buildDraftPlayoffBracket(
      playoffPlans,
      rankedTable(runtime.table).map((row) => row.entrant),
    );
    for (let round = 0; round < runtime.playoffBracketRounds.length; round += 1) {
      for (
        let position = 0;
        position < runtime.playoffBracketRounds[round]!.length;
        position += 1
      ) {
        const match = runtime.playoffBracketRounds[round]![position]!;
        if (
          match.seriesIndex === null ||
          match.slots[0] === null ||
          match.slots[1] === null ||
          completed.has(match.seriesIndex)
        ) {
          continue;
        }
        const row = storedRows.playoffs.get(match.seriesIndex);
        if (!row) continue;
        const plan = playoffPlans.find((candidate) => candidate.index === match.seriesIndex);
        if (!plan)
          throw new Error(`run ${runId} has no plan for playoff series ${match.seriesIndex}`);
        const pair: [number, number] = [match.slots[0], match.slots[1]];
        plan.entrants = pair;
        const builds = {
          p1: operations.storedBuildFor(plan, pair[0], pair[1], runtime.rosters),
          p2: operations.storedBuildFor(plan, pair[1], pair[0], runtime.rosters),
        };
        const outcome = operations.validateStoredSeriesEvidence(
          row,
          plan,
          pair,
          builds,
          runtime.rosters,
        );
        if (!outcome.winnerSide) {
          throw new Error(`run ${runId} playoff series ${plan.index} has no canonical winner`);
        }
        const expectedAdvanced = entrants[outcome.winnerSide === "p1" ? pair[0] : pair[1]];
        if (row.advanced !== expectedAdvanced) {
          throw new Error(
            `run ${runId} series ${plan.index} advances a player other than its canonical winner`,
          );
        }
        runtime.playoffBracketRounds = applyBracketOutcome(
          runtime.playoffBracketRounds,
          match,
          outcome.winnerSide,
        );
        teambuilds.push(builds.p1.view, builds.p2.view);
        completed.set(plan.index, row);
        storedOutcomes.set(plan.index, outcome);
      }
    }
    const unresolved = [...storedRows.playoffs.keys()].find((index) => !completed.has(index));
    if (unresolved !== undefined) {
      throw new Error(
        `run ${runId} playoff series ${unresolved} has unresolved bracket prerequisites; it cannot resume`,
      );
    }
  }

  if (stored && storedSchedule === undefined) {
    promoteDraftOnlyConfig(runDir, stored, configuredTransactions);
  }
}
