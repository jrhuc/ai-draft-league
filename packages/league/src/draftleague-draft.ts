import path from "node:path";

import type { RunDraftOptions } from "./draft.js";
import { runDraft } from "./draft.js";
import { rankedTable } from "./draftleague-protocol.js";
import type { DraftLeagueContext } from "./draftleague-state.js";
import { DraftLeagueRuntime } from "./draftleague-state.js";
import { emptyMemory } from "./franchise-memory.js";
import {
  type DraftLeagueCompletion,
  writeDraftLeagueConfig,
  writeDraftLeagueRosters,
} from "./league-store.js";
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

export async function runDraftPhase(
  context: DraftLeagueContext,
  runtime: DraftLeagueRuntime,
): Promise<void> {
  const {
    board,
    configuredTransactions,
    draftOnly,
    entrants,
    models,
    options,
    psCommit,
    psDir,
    random,
    runDir,
    runId,
    schedule,
    seed,
    sequentialWeeks,
    stored,
    swapsAllowed,
    timerScale,
    weeks,
  } = context;
  const draftView = (withTable: boolean) => runtime.draftView(withTable);
  const writeConfig = (outcome?: Partial<DraftLeagueCompletion>): void => {
    writeDraftLeagueConfig(
      {
        runDir,
        showdownCommit: psCommit,
        models,
        entrants,
        seed,
        concurrency: options.concurrency ?? 4,
        reasoning: options.reasoning ?? null,
        reasoningByModel: options.reasoningByModel ?? null,
        timerScale,
        board,
        sequentialWeeks,
        closedSheets: options.closedSheets === true,
        draftOnly,
        preset: stored ? stored.preset : (options.preset?.id ?? null),
        transactions: draftOnly ? null : configuredTransactions,
        swapsAllowed,
        teamNames: runtime.teamNames,
        weeks: weeks.length,
      },
      outcome,
    );
  };

  if (stored) {
    const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
    runtime.rosters = stored.rosterIds.map((ids) =>
      ids.map((id) => {
        const mon = monById.get(id);
        if (!mon) {
          throw new Error(`run ${runId} drafted ${id}, which board ${board.id} does not hold`);
        }
        return mon;
      }),
    );
    runtime.budgets = runtime.rosters.map(
      (roster) => board.budget - roster.reduce((sum, mon) => sum + mon.cost, 0),
    );
    runtime.teamNames = stored.teamNames;
    runtime.draftNotes = stored.draftNotes;
    runtime.memories = runtime.draftNotes.map((note) => emptyMemory(note));
  } else if (options.preset) {
    runtime.rosters = presetRosters(options.preset, board, entrants.length);
    runtime.budgets = runtime.rosters.map(
      (roster) => board.budget - roster.reduce((sum, mon) => sum + mon.cost, 0),
    );
    runtime.teamNames = options.preset.teams.map((team) => team.name);
    runtime.draftNotes = options.preset.teams.map((team) => team.note);
    runtime.memories = runtime.draftNotes.map((note) => emptyMemory(note));
  } else {
    writeConfig();
    const draftOptions: RunDraftOptions = {
      psDir,
      logDir: path.join(runDir, "draft"),
      rng: random,
      rosterPolicy: transactionPolicyLine(schedule, swapsAllowed),
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
      signal: options.signal,
    };
    draftOptions.onPick = (view, state) => {
      runtime.picks = [...runtime.picks, view];
      runtime.rosters = state.rosters;
      runtime.budgets = state.budgets;
      runtime.progress = { phase: "draft", completedPicks: runtime.picks.length };
      writeConfig();
      options.onEvent?.({ type: "draft", draft: draftView(false) });
    };
    draftOptions.onName = (_entrant, _teamName, state) => {
      runtime.teamNames = [...state.teamNames];
      writeConfig();
      options.onEvent?.({ type: "draft", draft: draftView(false) });
    };
    const outcome = await runDraft(entrants, board, draftOptions);
    runtime.rosters = outcome.rosters;
    runtime.budgets = outcome.budgets;
    runtime.teamNames = outcome.teamNames;
    runtime.draftNotes = outcome.notebooks;
    runtime.memories = runtime.draftNotes.map((note) => emptyMemory(note));
  }

  const initialRosters = runtime.rosters.map((roster) => [...roster]);
  if (stored || options.preset) {
    validateLeagueRosterState(
      {
        board,
        models: entrants,
        teamNames: runtime.teamNames,
        rosters: runtime.rosters,
        budgets: runtime.budgets,
        memories: runtime.memories,
        standings: rankedTable(runtime.table),
        results: entrants.map(() => []),
        reflections: entrants.map(() => []),
        history: [],
        swapsAllowed,
        swapsUsed: entrants.map(() => 0),
      },
      `${stored ? "resumed" : "preset"} initial roster for run ${runId}`,
    );
  }
  runtime.rosterHistory.push(initialRosters);

  if (!stored) {
    writeDraftLeagueRosters(
      runDir,
      board.budget,
      entrants,
      runtime.teamNames,
      runtime.budgets,
      runtime.rosters,
    );
    writeConfig({
      rosters: runtime.rosters.map((roster) => roster.map((mon) => mon.id)),
      draft_notes: runtime.draftNotes,
      contributor: options.contributor ?? null,
    });
  }
}
