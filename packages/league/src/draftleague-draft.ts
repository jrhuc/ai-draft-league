import path from "node:path";

import type { RunDraftOptions } from "./draft.js";
import { runDraft } from "./draft.js";
import type { DraftLeagueContext, LeagueCoordinator } from "./league-coordinator.js";
import { storeFranchiseCheckpoint } from "./league-journal.js";
import { presetRosters } from "./roster-preset.js";
import type { TransactionSchedule } from "./trade-window.js";
import { validateLeagueRosterState } from "./trade-window.js";

function transactionPolicyLine(schedule: TransactionSchedule, swapsAllowed: number): string {
  if (!schedule.length) {
    return "- After the draft this roster is locked for the whole season: a round robin of best-of-three matches, then playoffs.";
  }
  const weeks = schedule.map((window) => window.afterWeek).join(", ");
  const offerCounts = [...new Set(schedule.map((window) => window.tradesAllowed))];
  const offers =
    offerCounts.length === 1
      ? `up to ${offerCounts[0]} one-for-one coach-trade ${offerCounts[0] === 1 ? "offer" : "offers"}`
      : `a window-specific number of one-for-one coach-trade offers (${schedule.map((window) => `${window.tradesAllowed} after week ${window.afterWeek}`).join(", ")})`;
  return (
    `- Transaction windows open after round-robin ${schedule.length === 1 ? "week" : "weeks"} ${weeks}. In each window every coach may make ${offers}, then free-agent swaps from a season allowance of ${swapsAllowed} per franchise, spent across all windows. ` +
    `Rosters lock after the ${schedule.length === 1 ? "window" : "last window"} for the rest of the season, including playoffs.`
  );
}

/** Establishes roster version 0 and the draft memory checkpoint, from the stored draft, a preset,
 * or a live draft that continues from its committed picks. */
export async function runDraftPhase(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
): Promise<void> {
  const { board, entrants, options, psDir, random, runDir, runId, schedule, stored, swapsAllowed } =
    context;
  if (stored?.draftComplete) {
    const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
    runtime.seedFranchises(
      stored.rosterIds.map((ids, entrant) => ({
        roster: ids.map((id) => {
          const mon = monById.get(id);
          if (!mon)
            throw new Error(`run ${runId} drafted ${id}, which board ${board.id} does not hold`);
          return mon;
        }),
        teamName: stored.teamNames[entrant]!,
        draftNote: stored.draftNotes[entrant]!,
      })),
    );
  } else if (options.preset) {
    const rosters = presetRosters(options.preset, board, entrants.length);
    runtime.seedFranchises(
      options.preset.teams.map((team, entrant) => ({
        roster: rosters[entrant]!,
        teamName: team.name,
        draftNote: team.note,
      })),
    );
  } else {
    const draftOptions: RunDraftOptions = {
      runDir,
      psDir,
      logDir: path.join(runDir, "draft"),
      rng: random,
      rosterPolicy: transactionPolicyLine(schedule, swapsAllowed),
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
      signal: options.signal,
      onPick: (view, state) => {
        runtime.picks = [...runtime.picks, view];
        runtime.adoptDraftState(state);
        runtime.transition({ phase: "draft", completedPicks: runtime.picks.length });
        options.onEvent?.({ type: "draft", draft: runtime.draftView(false) });
      },
      onName: (_entrant, _teamName, state) => {
        runtime.adoptDraftState(state);
        options.onEvent?.({ type: "draft", draft: runtime.draftView(false) });
      },
    };
    const outcome = await runDraft(entrants, board, draftOptions);
    runtime.seedFranchises(
      outcome.rosters.map((roster, entrant) => ({
        roster,
        teamName: outcome.teamNames[entrant]!,
        draftNote: outcome.notebooks[entrant]!,
      })),
    );
  }

  if (stored || options.preset) {
    validateLeagueRosterState(
      {
        board,
        models: entrants,
        teamNames: runtime.teamNames,
        rosters: runtime.rosters,
        budgets: runtime.budgets,
        memories: runtime.memories,
        standings: runtime.standings(),
        results: entrants.map(() => []),
        reflections: entrants.map(() => []),
        history: [],
        afterWeek: 0,
        schedule: [],
        usage: [],
        swapsAllowed,
        swapsUsed: entrants.map(() => 0),
      },
      `${stored ? "resumed" : "preset"} initial roster for run ${runId}`,
    );
  }
  for (const franchise of runtime.franchises) {
    storeFranchiseCheckpoint(runDir, {
      stage: "draft",
      week: 0,
      entrant: franchise.entrant,
      model: franchise.model,
      rosterVersion: 0,
      memory: franchise.memory,
      reasoning: "",
      fallback: false,
    });
  }
  runtime.storeRosterVersion(0);
}
