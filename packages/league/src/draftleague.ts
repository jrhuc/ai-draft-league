import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { storedNotebookText } from "./battle-memory.js";

import type { DraftBoardMon } from "./draft.js";
import { loadBoard } from "./draft.js";
import { runDraftPhase } from "./draftleague-draft.js";
import {
  buildDraftLeagueSchedule,
  type DraftLeagueOptions,
  type DraftLeagueSeriesPlan,
  rankedTable,
} from "./draftleague-protocol.js";
import { runPlayoffPhase } from "./draftleague-playoffs.js";
import { preflightStoredLeague } from "./draftleague-resume.js";
import { runRoundRobinPhase } from "./draftleague-roundrobin.js";
import {
  type DraftLeagueContext,
  DraftLeagueRuntime,
  type StoredSeriesOutcome,
} from "./draftleague-state.js";
import { cloneMemory, emptyMemory } from "./franchise-memory.js";
import type { DraftView, TeamBuildView } from "./views.js";
import {
  appendStoredCoaching,
  draftOnlyPromotionEvidence,
  linkedStoredArtifact,
  loadStoredCoaching,
  loadStoredLeague,
  loadStoredLeagueRows,
  loadStoredPicks,
  loadStoredTeambuilds,
  validateStoredLeagueConfig,
} from "./league-store.js";
import { BOARDS_DIR, defaultPsDir, RESULTS_PATH } from "./paths.js";
import { validateModelExecution } from "./providers.js";
import { resolveSeed, seededRng, shuffle } from "./random.js";
import type { SeriesRecord } from "./records.js";
import { appendRow } from "./records.js";
import type { RecordedSeriesContext } from "./series.js";
import { playRecordedSeries, readCompletedSeriesEvidence } from "./series.js";
import { showdownCommit } from "./showdown.js";
import { runTeambuild, type TeamBuildSheetPolicy, type TeamBuildOptions } from "./teambuild.js";
import { validateTeam } from "./teams.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import {
  DEFAULT_SWAPS_ALLOWED,
  defaultTransactionSchedule,
  describeTransactionHistory,
  type TransactionSchedule,
  transactionArtifactPaths,
  validateSwapsAllowed,
  validateTransactionSchedule,
} from "./trade-window.js";
import type { JsonObject, Pid } from "./types.js";
import {
  type ReviewStage,
  readWeeklyReviews,
  runWeeklyReview,
  type WeeklyReview,
  type WeeklyReviewSeries,
} from "./weekly-review.js";

function builtTeamSummary(build: TeamBuildView): string {
  const sets = build.sets.map((set) => {
    const evs = Object.entries(set.evs)
      .filter(([, value]) => Number(value) > 0)
      .map(([stat, value]) => `${stat} ${value}`)
      .join("/");
    return `${set.species} @ ${set.item}; ${set.ability}; ${set.nature}; ${set.moves.join("/")}; ${evs || "0 investment"}`;
  });
  return `Plan: ${build.rationale || "(none)"} Registered sets: ${sets.join(" | ")}`;
}

function initialBattleNotebook(build: TeamBuildView): string {
  return `Matchup build carried from teambuilding. ${builtTeamSummary(build)}`;
}

function draftRosterSummary(roster: readonly DraftBoardMon[], build: TeamBuildView): string {
  const registered = new Set(build.brought);
  const names = (mons: readonly DraftBoardMon[]) =>
    mons.map((mon) => mon.name).join(", ") || "(none)";
  return (
    `registered for this series: ${names(roster.filter((mon) => registered.has(mon.id)))}; ` +
    `left behind: ${names(roster.filter((mon) => !registered.has(mon.id)))}.`
  );
}

export function draftLeaguePlayoffReview(
  summary: string,
  build: TeamBuildView,
  notebook: string,
): string {
  return `${summary}. ${builtTeamSummary(build)} Final private battle note: ${notebook || "(empty)"}`;
}

export async function runDraftLeague(
  models: string[],
  runDir: string,
  options: DraftLeagueOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error("a draft league needs at least two models");
  validateModelExecution(models, options);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
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
  const sheetPolicy: TeamBuildSheetPolicy = options.closedSheets === true ? "closed" : "open";
  const random = seededRng(seed);
  const psCommit = showdownCommit(psDir);

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
  const storedSchedule = stored ? stored.transactions : undefined;
  const storedTransactionArtifacts = stored ? transactionArtifactPaths(runDir) : [];
  if (storedSchedule?.length === 0 && storedTransactionArtifacts.length) {
    throw new Error(
      `run ${path.basename(runDir)} configures no transaction windows but holds transaction artifacts: ${storedTransactionArtifacts.join(", ")}`,
    );
  }
  if (storedSchedule === undefined && stored && storedTransactionArtifacts.length) {
    throw new Error(
      `draft-only run ${path.basename(runDir)} cannot be promoted while transaction artifacts exist: ${storedTransactionArtifacts.join(", ")}`,
    );
  }
  const entrants = stored ? stored.entrants : shuffle(models, random);
  const { weeks, playoffRounds, plans } = buildDraftLeagueSchedule(entrants.length, seed);
  const schedule: TransactionSchedule = draftOnly
    ? []
    : (storedSchedule ??
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
      `run ${path.basename(runDir)} allows ${stored.swapsAllowed} season swaps; that is frozen for the run`,
    );
  }
  const configuredTransactions = schedule.map((window) => ({
    after_week: window.afterWeek,
    trades_allowed: window.tradesAllowed,
  }));
  const sequentialWeeks = stored
    ? stored.sequentialWeeks
    : options.sequentialWeeks === true || options.throughWeek !== undefined;
  const reviewWeeks = sequentialWeeks
    ? weeks.map((_, index) => index + 1)
    : [...new Set([...schedule.map((window) => window.afterWeek), weeks.length])].sort(
        (a, b) => a - b,
      );
  const runId = path.basename(runDir);
  const storedRows = stored
    ? loadStoredLeagueRows(recordsPath, runId, plans, board.id, seed)
    : {
        all: [],
        roundRobin: new Map<number, SeriesRecord>(),
        playoffs: new Map<number, SeriesRecord>(),
      };
  if (stored && storedSchedule === undefined) {
    const evidence = draftOnlyPromotionEvidence(runDir, storedRows.all);
    if (evidence.length) {
      throw new Error(
        `draft-only run ${runId} cannot be promoted while season evidence exists: ${evidence.join(", ")}`,
      );
    }
  }
  const storedRoundRobinRows = storedRows.roundRobin;
  const storedCoaching = loadStoredCoaching(runDir, entrants.length);
  const context: DraftLeagueContext = {
    models,
    runDir,
    options,
    psDir,
    board,
    seed,
    timerScale,
    random,
    psCommit,
    stored,
    storedSchedule,
    entrants,
    weeks,
    playoffRounds,
    plans,
    schedule,
    swapsAllowed,
    configuredTransactions,
    sequentialWeeks,
    reviewWeeks,
    runId,
    storedRows,
    draftOnly,
  };
  const runtime = new DraftLeagueRuntime(
    context,
    entrants.map(() => emptyMemory()),
    storedCoaching.playoffContext,
    storedCoaching.reflectionNotes,
    stored ? loadStoredPicks(runDir, entrants.length, board) : [],
  );
  const {
    completed,
    playoffContext,
    reconciled,
    reflectionNotes,
    resultSummaries,
    rosterHistory,
    storedOutcomes,
    table,
    teambuilds,
    windowArtifacts,
  } = runtime;
  const draftView = (withTable: boolean): DraftView => runtime.draftView(withTable);
  const outcomeFor = (plan: DraftLeagueSeriesPlan) => runtime.outcomeFor(plan);
  const rosterVersionFor = (plan: DraftLeagueSeriesPlan) => runtime.rosterVersionFor(plan);
  const rosterStateFor = (plan: DraftLeagueSeriesPlan) => runtime.rosterStateFor(plan);

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
  options.onEvent?.({ type: "draft", draft: draftView(false) });

  await runDraftPhase(context, runtime);

  if (draftOnly) {
    options.onEvent?.({ type: "draft", draft: draftView(true) });
    return [];
  }

  runtime.progress = { phase: "roundrobin", week: 0, rosterVersion: 0 };
  options.onEvent?.({ type: "draft", draft: draftView(true) });

  const storedTeambuilds = stored
    ? loadStoredTeambuilds(path.join(runDir, "teambuild"))
    : new Map();
  const storedBuildFor = (
    plan: DraftLeagueSeriesPlan,
    entrant: number,
    opponent: number,
    rosterState: readonly DraftBoardMon[][],
  ): { packed: string; view: TeamBuildView } => {
    const rows = storedTeambuilds.get(`${plan.index}:${entrant}`) ?? [];
    const row = rows.at(-1);
    const linked = row
      ? linkedStoredArtifact(row, {
          model: entrants[entrant]!,
          opponentModel: entrants[opponent]!,
          format: board.format,
          psDir,
          sheetPolicy,
          stage: plan.stage,
          seriesIndex: plan.index,
          entrant,
          opponent,
          rosterIds: rosterState[entrant]!.map((mon) => mon.id),
          opponentRosterIds: rosterState[opponent]!.map((mon) => mon.id),
        })
      : undefined;
    if (!linked) {
      throw new Error(
        `run ${runId} completed series ${plan.index} lacks an exact current construction for entrant ${entrant}`,
      );
    }
    return linked;
  };
  const validateStoredSeriesEvidence = (
    row: SeriesRecord,
    plan: DraftLeagueSeriesPlan,
    pair: [number, number],
    builds: Record<Pid, { packed: string; view: TeamBuildView }>,
    rosterState: readonly DraftBoardMon[][],
  ): StoredSeriesOutcome => {
    const players = { p1: entrants[pair[0]]!, p2: entrants[pair[1]]! };
    const teams = {
      p1: { id: `${players.p1} wk${plan.round}`, packed: builds.p1.packed },
      p2: { id: `${players.p2} wk${plan.round}`, packed: builds.p2.packed },
    };
    const evidenceContext: RecordedSeriesContext = {
      players,
      teams,
      seriesIndex: plan.index,
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: board.format,
      psDir,
      runDir,
      initialNotebooks: {
        p1: initialBattleNotebook(builds.p1.view),
        p2: initialBattleNotebook(builds.p2.view),
      },
      draftRosters: {
        p1: draftRosterSummary(rosterState[pair[0]]!, builds.p1.view),
        p2: draftRosterSummary(rosterState[pair[1]]!, builds.p2.view),
      },
      requireWinner: plan.stage === "playoff",
      closedSheets: options.closedSheets,
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      timerScale,
    };
    const canonical = readCompletedSeriesEvidence(evidenceContext);
    const storedFields: JsonObject = {
      series_id: row.series_id,
      attempt_id: row.attempt_id,
      format: row.format,
      players: row.players,
      teams: row.teams,
      winner: row.winner,
      winner_side: row.winner_side,
      score: row.score,
      turns: row.turns,
      games: row.games,
      engine_seeds: row.engine_seeds,
      timer_scale: row.timer_scale,
      reasoning: row.reasoning,
      sampling: "provider-default",
    };
    if (row.closed_sheets !== undefined) storedFields.closed_sheets = row.closed_sheets;
    if (row.reasoning_by_player !== undefined)
      storedFields.reasoning_by_player = row.reasoning_by_player;
    if (
      row.schema_version !== 1 ||
      row.mode !== "draft" ||
      row.ps_commit !== psCommit ||
      row.series_index !== plan.index ||
      !isDeepStrictEqual(row.entrants, pair) ||
      row.roster_version !== rosterVersionFor(plan) ||
      !isDeepStrictEqual(row.transactions, configuredTransactions)
    ) {
      throw new Error(
        `run ${runId} series ${plan.index} is not bound to its current construction and policies`,
      );
    }
    if (!isDeepStrictEqual(storedFields, canonical.fields)) {
      throw new Error(
        `run ${runId} series ${plan.index} does not match its canonical completed series evidence`,
      );
    }
    return { score: canonical.fields.score, winnerSide: canonical.winnerSide };
  };

  const monName = (id: string): string => board.mons.find((mon) => mon.id === id)?.name ?? id;
  const priorContextFor = (entrant: number, opponent: number): string[] => {
    const lines: string[] = [];
    for (const plan of plans) {
      if (!plan.entrants?.includes(entrant) || !completed.has(plan.index)) continue;
      const summary = resultSummaries[entrant]!.get(plan.index);
      if (summary === undefined) continue;
      const build = teambuilds.find(
        (view) => view.seriesIndex === plan.index && view.entrant === entrant,
      );
      const registered = build ? `; registered ${build.brought.map(monName).join(", ")}` : "";
      lines.push(`${summary}${registered}`);
      const context = playoffContext[entrant]!.get(plan.index);
      if (plan.entrants.includes(opponent) && context) lines.push(`Against this coach: ${context}`);
    }
    return lines;
  };

  const teambuildFor = async (
    plan: DraftLeagueSeriesPlan,
    entrant: number,
    opponent: number,
    signal: AbortSignal,
  ) => {
    const storedRows = storedTeambuilds.get(`${plan.index}:${entrant}`) ?? [];
    let reused: { packed: string; view: TeamBuildView } | undefined;
    for (let index = storedRows.length - 1; index >= 0 && !reused; index -= 1) {
      const row = storedRows[index]!;
      reused = linkedStoredArtifact(row, {
        model: entrants[entrant]!,
        opponentModel: entrants[opponent]!,
        format: board.format,
        psDir,
        sheetPolicy,
        stage: plan.stage,
        seriesIndex: plan.index,
        entrant,
        opponent,
        rosterIds: runtime.rosters[entrant]!.map((mon) => mon.id),
        opponentRosterIds: runtime.rosters[opponent]!.map((mon) => mon.id),
      });
    }
    if (reused) {
      try {
        validateTeam(reused.packed, board.format, psDir);
        teambuilds.push(reused.view);
        options.onEvent?.({ type: "draft", draft: draftView(true) });
        return reused;
      } catch {}
    }

    const request = {
      seriesIndex: plan.index,
      entrant,
      opponent,
      stage: plan.stage,
      model: entrants[entrant]!,
      opponentModel: entrants[opponent]!,
      franchiseName: runtime.teamNames[entrant]!,
      roster: runtime.rosters[entrant]!,
      opponentRoster: runtime.rosters[opponent]!,
      memory: runtime.memories[entrant]!,
      playoffContext: priorContextFor(entrant, opponent),
      format: board.format,
      sheetPolicy,
    };
    const teambuildOptions: TeamBuildOptions = {
      psDir,
      logDir: path.join(runDir, "teambuild"),
      rng: seededRng(`${seed}:tb:${plan.index}:${entrant}`),
      signal,
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
    };
    const result = await runTeambuild(request, teambuildOptions);
    validateTeam(result.packed, board.format, psDir);
    teambuilds.push(result.view);
    options.onEvent?.({ type: "draft", draft: draftView(true) });
    return result;
  };

  const playSeries = async (
    plan: DraftLeagueSeriesPlan,
    signal: AbortSignal,
  ): Promise<SeriesRecord> => {
    const [a, b] = plan.entrants!;
    const players = { p1: entrants[a]!, p2: entrants[b]! };
    options.onEvent?.({ type: "series-players", index: plan.index, players });
    const [home, away] = await Promise.all([
      teambuildFor(plan, a, b, signal),
      teambuildFor(plan, b, a, signal),
    ]);
    options.onEvent?.({ type: "series-start", index: plan.index });
    const seriesContext: RecordedSeriesContext = {
      seriesIndex: plan.index,
      players,
      teams: {
        p1: { id: `${entrants[a]} wk${plan.round}`, packed: home.packed },
        p2: { id: `${entrants[b]} wk${plan.round}`, packed: away.packed },
      },
      initialNotebooks: {
        p1: initialBattleNotebook(home.view),
        p2: initialBattleNotebook(away.view),
      },
      draftRosters: {
        p1: draftRosterSummary(runtime.rosters[a]!, home.view),
        p2: draftRosterSummary(runtime.rosters[b]!, away.view),
      },
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: board.format,
      psDir,
      runDir,
      signal,
      requireWinner: plan.stage === "playoff",
      closedSheets: options.closedSheets,
      reasoning: options.reasoning,
      apiKeys: options.apiKeys,
      reasoningByModel: options.reasoningByModel,
      timerScale,
      onGameUpdate: (game, lines, publicLines) =>
        options.onEvent?.({ type: "game-update", index: plan.index, game, lines, publicLines }),
      onGameEnd: (game, winner, turns, score) =>
        options.onEvent?.({ type: "game-end", index: plan.index, game, winner, turns, score }),
      onDecision: (pid, row) =>
        options.onEvent?.({ type: "decision", index: plan.index, pid, row }),
    };
    const { winnerSide, fields, coachNotes } = await playRecordedSeries(seriesContext);
    const row: SeriesRecord = {
      schema_version: 1,
      mode: "draft",
      series_index: plan.index,
      entrants: [a, b],
      stage: plan.stage,
      round: plan.round,
      board: board.id,
      transactions: configuredTransactions,
      roster_version: rosterVersionFor(plan),
      run_seed: seed,
      ps_commit: showdownCommit(psDir),
      ...fields,
    };
    if (plan.stage === "playoff") {
      if (!winnerSide)
        throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
      row.advanced = entrants[winnerSide === "p1" ? a : b]!;
    }
    if (options.contributor !== undefined) row.contributor = options.contributor;
    appendRow(recordsPath, row);
    completed.set(plan.index, row);
    storedOutcomes.set(plan.index, { score: fields.score, winnerSide });
    applyOutcome(plan, {
      p1: { build: home.view, notebook: storedNotebookText(coachNotes.p1) },
      p2: { build: away.view, notebook: storedNotebookText(coachNotes.p2) },
    });
    options.onEvent?.({ type: "series-end", index: plan.index, record: row });
    return row;
  };

  const applyOutcome = (
    plan: DraftLeagueSeriesPlan,
    coaching?: Record<Pid, { build: TeamBuildView; notebook: string }>,
  ): void => {
    const [a, b] = plan.entrants!;
    const { winnerSide, score } = outcomeFor(plan);
    for (const [entrant, opponent, side] of [
      [a, b, "p1"],
      [b, a, "p2"],
    ] as const) {
      const won = winnerSide === side;
      const result = winnerSide ? (won ? "beat" : "lost to") : "drew with";
      const summary =
        `${plan.stage === "playoff" ? `Playoff round ${plan.round}` : `Round-robin week ${plan.round}`}: ${result} ` +
        `${entrants[opponent]} ${score[side]}-${score[side === "p1" ? "p2" : "p1"]}`;
      const context = coaching
        ? draftLeaguePlayoffReview(summary, coaching[side].build, coaching[side].notebook)
        : summary;
      resultSummaries[entrant]!.set(plan.index, summary);
      if (coaching || !playoffContext[entrant]!.has(plan.index)) {
        playoffContext[entrant]!.set(plan.index, context);
      }
      if (coaching) {
        reflectionNotes[entrant]!.set(plan.index, coaching[side].notebook);
        appendStoredCoaching(runDir, {
          series_index: plan.index,
          entrant,
          context,
          notebook: coaching[side].notebook,
        });
      }
    }
    if (plan.stage === "roundrobin") {
      table[a]!.gw += score.p1;
      table[a]!.gl += score.p2;
      table[b]!.gw += score.p2;
      table[b]!.gl += score.p1;
      if (winnerSide) {
        table[winnerSide === "p1" ? a : b]!.w += 1;
        table[winnerSide === "p1" ? b : a]!.l += 1;
      }
      options.onEvent?.({ type: "draft", draft: draftView(true) });
    }
  };

  const validateStoredRoundRobin = (version: number): void => {
    for (const [seriesIndex, row] of storedRoundRobinRows) {
      const plan = plans[seriesIndex]!;
      if (completed.has(plan.index) || rosterVersionFor(plan) !== version) continue;
      const pair = plan.entrants!;
      const rosterState = rosterStateFor(plan);
      const builds = {
        p1: storedBuildFor(plan, pair[0], pair[1], rosterState),
        p2: storedBuildFor(plan, pair[1], pair[0], rosterState),
      };
      const outcome = validateStoredSeriesEvidence(row, plan, pair, builds, rosterState);
      storedOutcomes.set(plan.index, outcome);
      teambuilds.push(builds.p1.view, builds.p2.view);
      completed.set(plan.index, row);
    }
  };
  const reviewSeries = (throughWeek: number): WeeklyReviewSeries[] => {
    const list: WeeklyReviewSeries[] = [];
    for (const plan of plans) {
      if (plan.stage !== "roundrobin" || plan.round > throughWeek || !plan.entrants) continue;
      const row = completed.get(plan.index);
      if (!row) continue;
      const { score, winnerSide } = outcomeFor(plan);
      const [a, b] = plan.entrants;
      list.push({
        index: plan.index,
        week: plan.round,
        seriesId: row.series_id ?? "",
        entrants: [a, b],
        score: [score.p1, score.p2],
        winner: winnerSide === undefined ? null : winnerSide === "p1" ? a : b,
        context: {
          [a]: playoffContext[a]!.get(plan.index) ?? "",
          [b]: playoffContext[b]!.get(plan.index) ?? "",
        },
        builds: {
          [a]: teambuilds.find((view) => view.seriesIndex === plan.index && view.entrant === a),
          [b]: teambuilds.find((view) => view.seriesIndex === plan.index && view.entrant === b),
        },
        rosters: { [a]: rosterStateFor(plan)[a]!, [b]: rosterStateFor(plan)[b]! },
      });
    }
    return list;
  };
  const requireWeekComplete = (week: number, context: string): void => {
    const missing = plans.find(
      (plan) => plan.stage === "roundrobin" && plan.round <= week && !completed.has(plan.index),
    );
    if (missing)
      throw new Error(
        `run ${runId} ${context} for week ${week} precedes scheduled series ${missing.index}`,
      );
  };
  const reviewOptions = {
    runDir,
    psDir,
    reasoning: options.reasoning,
    reasoningByModel: options.reasoningByModel,
    apiKeys: options.apiKeys,
    signal: options.signal,
  };
  const reviewWeekFor = async (week: number): Promise<void> => {
    if (!reviewWeeks.includes(week) || runtime.reviewedThrough >= week) return;
    requireWeekComplete(week, "weekly review");
    const series = reviewSeries(week);
    const nextWindow = schedule.find((window) => window.afterWeek >= week);
    await runWeeklyReview(
      {
        board,
        models: entrants,
        stage: "week",
        week,
        weeks: weeks.length,
        rosterVersion: windowArtifacts.length,
        rosters: runtime.rosters,
        memories: runtime.memories,
        standings: rankedTable(table),
        series,
        period: series
          .filter((entry) => entry.week > runtime.reviewedThrough)
          .map((entry) => entry.index),
        schedule: plans.flatMap((plan) =>
          plan.stage === "roundrobin" && plan.entrants
            ? [{ index: plan.index, week: plan.round, entrants: plan.entrants }]
            : [],
        ),
        transactions: describeTransactionHistory(windowArtifacts, entrants),
        nextWindowWeek: nextWindow ? nextWindow.afterWeek : null,
      },
      reviewOptions,
    );
    runtime.reviewedThrough = week;
    options.onEvent?.({ type: "draft", draft: draftView(true) });
  };
  const adoptReviewRows = (rows: WeeklyReview[], week: number, stage: ReviewStage): void => {
    for (const row of rows) {
      if (
        row.roster_version !== windowArtifacts.length ||
        row.entrant >= entrants.length ||
        row.model !== entrants[row.entrant]
      ) {
        throw new Error(
          `run ${runId} week ${week} ${stage} review has invalid identity for entrant ${row.entrant} at roster version ${row.roster_version}`,
        );
      }
      runtime.memories[row.entrant] = cloneMemory(row.memory);
    }
  };
  const adoptStoredReview = (week: number): boolean => {
    const rows = readWeeklyReviews(runDir, week);
    if (rows.length < entrants.length) {
      if (rows.length) requireWeekComplete(week, "weekly review");
      return false;
    }
    requireWeekComplete(week, "weekly review");
    adoptReviewRows(rows, week, "week");
    runtime.reviewedThrough = week;
    return true;
  };
  const changedSeats = (index: number): number[] => runtime.changedSeats(index);
  const adoptStoredReconciliation = (index: number): boolean => {
    const window = schedule[index]!;
    const seats = changedSeats(index);
    const rows = readWeeklyReviews(runDir, window.afterWeek, "transactions");
    if (seats.some((seat) => !rows.some((row) => row.entrant === seat))) return false;
    adoptReviewRows(rows, window.afterWeek, "transactions");
    reconciled.add(index);
    return true;
  };
  const reconcileWindow = async (index: number): Promise<void> => {
    const window = schedule[index];
    if (!window || reconciled.has(index) || windowArtifacts.length <= index) return;
    const seats = changedSeats(index);
    if (seats.length) {
      const nextWindow = schedule[index + 1];
      await runWeeklyReview(
        {
          board,
          models: entrants,
          stage: "transactions",
          week: window.afterWeek,
          weeks: weeks.length,
          rosterVersion: index + 1,
          rosters: runtime.rosters,
          previousRosters: rosterHistory[index]!,
          seats,
          memories: runtime.memories,
          standings: rankedTable(table),
          series: [],
          period: [],
          schedule: plans.flatMap((plan) =>
            plan.stage === "roundrobin" && plan.entrants
              ? [{ index: plan.index, week: plan.round, entrants: plan.entrants }]
              : [],
          ),
          transactions: describeTransactionHistory(windowArtifacts, entrants),
          nextWindowWeek: nextWindow ? nextWindow.afterWeek : null,
        },
        reviewOptions,
      );
    }
    reconciled.add(index);
    options.onEvent?.({ type: "draft", draft: draftView(true) });
  };

  preflightStoredLeague(context, runtime, {
    validateStoredRoundRobin,
    adoptStoredReview,
    adoptStoredReconciliation,
    storedBuildFor,
    validateStoredSeriesEvidence,
    applyOutcome,
  });

  const roundRobin = await runRoundRobinPhase(context, runtime, {
    playSeries,
    reviewWeek: reviewWeekFor,
    reconcileWindow,
  });
  if (roundRobin.status === "paused") return roundRobin.results;

  return runPlayoffPhase(context, runtime, playSeries, applyOutcome, reviewOptions);
}
