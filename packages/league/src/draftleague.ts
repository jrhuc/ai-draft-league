import fs from "node:fs";
import path from "node:path";

import { loadBoard } from "./draft.js";
import { runDraftPhase } from "./draftleague-draft.js";
import { buildDraftLeagueSchedule, type DraftLeagueOptions } from "./draftleague-protocol.js";
import { runPlayoffPhase } from "./draftleague-playoffs.js";
import { runRoundRobinPhase } from "./draftleague-roundrobin.js";
import { type DraftLeagueContext, LeagueCoordinator } from "./league-coordinator.js";
import {
  loadStoredBuilds,
  loadStoredLeague,
  loadStoredPicks,
  promoteDraftOnlyConfig,
  validateStoredLeagueConfig,
  writeDraftLeagueConfig,
} from "./league-store.js";
import { BOARDS_DIR, defaultPsDir, RESULTS_PATH } from "./paths.js";
import { validateModelExecution } from "./providers.js";
import { resolveSeed, seededRng, shuffle } from "./random.js";
import type { SeriesRecord } from "./records.js";
import { showdownCommit } from "./showdown.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import {
  DEFAULT_SWAPS_ALLOWED,
  defaultTransactionSchedule,
  type TransactionSchedule,
  validateSwapsAllowed,
  validateTransactionSchedule,
} from "./trade-window.js";

export { draftLeaguePlayoffReview } from "./draftleague-series.js";

/** Runs or resumes a season. Every stage adopts what `league.sqlite` already holds, so resuming
 * is re-running the season from the draft with no provider calls until the first unfinished stage. */
export async function runDraftLeague(
  models: string[],
  runDir: string,
  options: DraftLeagueOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error("a draft league needs at least two models");
  validateModelExecution(models, options);

  fs.mkdirSync(runDir, { recursive: true });
  const psDir = options.psDir ?? defaultPsDir();
  const board = loadBoard(options.board ?? "regmb-202607", options.boardsDir ?? BOARDS_DIR, psDir);
  const distinctBases = new Set(board.mons.map((mon) => mon.base)).size;
  if (models.length * board.picks > distinctBases) {
    throw new Error(
      `board ${JSON.stringify(board.id)} holds ${distinctBases} distinct species, too few for ${models.length} rosters of ${board.picks}`,
    );
  }
  const seed = resolveSeed(options.seed);
  const timerScale = options.timerScale ?? DEFAULT_TIMER_SCALE;
  const random = seededRng(seed);
  const psCommit = showdownCommit(psDir);
  const runId = path.basename(runDir);

  const stored = options.resume ? loadStoredLeague(runDir) : undefined;
  if (stored) {
    validateStoredLeagueConfig(runDir, stored, {
      models,
      seed,
      board,
      closedSheets: options.closedSheets === true,
      timerScale,
      showdownCommit: psCommit,
    });
  }
  const draftOnly = options.draftOnly === true;
  const entrants = stored ? stored.entrants : shuffle(models, random);
  const { weeks, playoffRounds, plans } = buildDraftLeagueSchedule(entrants.length, seed);
  const schedule: TransactionSchedule = draftOnly
    ? []
    : (stored?.transactions ??
      (options.transactions === undefined
        ? defaultTransactionSchedule(weeks.length)
        : (options.transactions ?? [])));
  validateTransactionSchedule(schedule, weeks.length);
  const swapsAllowed = stored?.swapsAllowed ?? options.swapsAllowed ?? DEFAULT_SWAPS_ALLOWED;
  validateSwapsAllowed(swapsAllowed, "swaps allowed");
  if (
    stored &&
    options.swapsAllowed !== undefined &&
    options.swapsAllowed !== stored.swapsAllowed
  ) {
    throw new Error(
      `run ${runId} allows ${stored.swapsAllowed} season swaps; that is frozen for the run`,
    );
  }
  const configuredTransactions = schedule.map((window) => ({
    after_week: window.afterWeek,
    trades_allowed: window.tradesAllowed,
  }));
  if (!stored) {
    writeDraftLeagueConfig({
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
      closedSheets: options.closedSheets === true,
      draftOnly,
      preset: options.preset?.id ?? null,
      transactions: draftOnly ? null : configuredTransactions,
      swapsAllowed,
      weeks: weeks.length,
      contributor: options.contributor ?? null,
    });
  }
  const context: DraftLeagueContext = {
    models,
    runDir,
    runId,
    recordsPath: options.recordsPath ?? RESULTS_PATH,
    options,
    psDir,
    board,
    seed,
    timerScale,
    sheetPolicy: options.closedSheets === true ? "closed" : "open",
    random,
    psCommit,
    stored,
    storedBuilds: stored ? loadStoredBuilds(runDir) : new Map(),
    entrants,
    weeks,
    playoffRounds,
    plans,
    schedule,
    swapsAllowed,
    configuredTransactions,
    draftOnly,
    reviewOptions: {
      runDir,
      psDir,
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
      signal: options.signal,
    },
  };
  const runtime = new LeagueCoordinator(
    context,
    stored?.draftComplete ? loadStoredPicks(runDir, entrants.length, board) : [],
  );

  options.onEvent?.({
    type: "plans",
    mode: "draft",
    plans: plans.map((plan) => ({
      index: plan.index,
      players: plan.entrants
        ? { p1: entrants[plan.entrants[0]]!, p2: entrants[plan.entrants[1]]! }
        : { p1: "TBD", p2: "TBD" },
    })),
    pool: board.id,
    seed,
  });
  options.onEvent?.({ type: "draft", draft: runtime.draftView(false) });

  await runDraftPhase(context, runtime);
  if (draftOnly) {
    options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
    return [];
  }
  if (stored && stored.transactions === undefined) {
    promoteDraftOnlyConfig(runDir, configuredTransactions);
  }
  runtime.transition({ phase: "roundrobin", week: 0, rosterVersion: 0 });
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });

  const roundRobin = await runRoundRobinPhase(context, runtime);
  if (roundRobin.status === "complete") await runPlayoffPhase(context, runtime);
  return runtime.results();
}
