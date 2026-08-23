import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { DraftBoardMon, RunDraftOptions } from './draft.js';
import { loadBoard, runDraft } from './draft.js';
import { draftLeagueTopology, roundRobinWeeks } from './draftleague-topology.js';
import { cloneMemory, emptyMemory, type FranchiseMemory, renderMemory } from './franchise-memory.js';
import type { BracketView, DraftTableRow, DraftView, TeambuildView } from './gui/api.js';
import {
  appendStoredCoaching,
  type DraftLeagueCompletion,
  draftOnlyPromotionEvidence,
  linkedStoredArtifact,
  loadStoredCoaching,
  loadStoredLeague,
  loadStoredLeagueRows,
  loadStoredPicks,
  loadStoredTeambuilds,
  postWindowEvidence,
  promoteDraftOnlyConfig,
  requireTransactionResultPrefix,
  validateStoredLeagueConfig,
  writeDraftLeagueConfig,
  writeDraftLeagueRosters,
} from './league-store.js';
import { BOARDS_DIR, defaultPsDir, RESULTS_PATH } from './paths.js';
import { validateModelExecution } from './providers.js';
import { resolveSeed, seededRng, seriesEntropy, shuffle } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow } from './records.js';
import { presetRosters, type RosterPreset } from './roster-preset.js';
import { runSeasonReview } from './season-review.js';
import type { ExperimentOptions, RecordedSeriesContext } from './series.js';
import { mapLimit, playRecordedSeries, readCompletedSeriesEvidence } from './series.js';
import { showdownCommit } from './showdown.js';
import { runTeambuild, type TeamBuildSheetPolicy, type TeambuildOptions } from './teambuild.js';
import { validateTeam } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import { applyBracketOutcome, type BracketMatch, type TournamentEvent } from './tournament.js';
import {
  DEFAULT_SWAPS_ALLOWED,
  defaultTransactionSchedule,
  describeTransactionHistory,
  type RunTradeWindowOptions,
  readValidatedTradeWindow,
  runTradeWindow,
  type TradeWindowArtifact,
  type TradeWindowResult,
  type TransactionSchedule,
  transactionArtifactPaths,
  transactionEpochDir,
  validateLeagueRosterState,
  validateSwapsAllowed,
  validateTransactionSchedule,
} from './trade-window.js';
import type { JsonObject, Pid } from './types.js';
import { ordinal } from './value.js';
import {
  type ReviewStage,
  readWeeklyReviews,
  runWeeklyReview,
  type WeeklyReview,
  type WeeklyReviewSeries,
} from './weekly-review.js';

export type DraftLeagueEvent = TournamentEvent | { type: 'draft'; draft: DraftView };

export interface DraftLeagueOptions extends ExperimentOptions {
  boardsDir?: string;
  board?: string;
  onEvent?: (event: DraftLeagueEvent) => void;
  throughWeek?: number;
  resume?: boolean;
  sequentialWeeks?: boolean;
  transactions?: TransactionSchedule | null;
  /** Season allowance of free-agent swaps per franchise, spent across every window. */
  swapsAllowed?: number;
  draftOnly?: boolean;
  preset?: RosterPreset;
}

export interface DraftLeagueSeriesPlan {
  index: number;
  stage: 'roundrobin' | 'playoff';
  round: number;
  entrants: [number, number] | null;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
}

interface StoredSeriesOutcome {
  score: Record<Pid, number>;
  winnerSide: Pid | undefined;
}

export function buildDraftPlayoffBracket(
  plans: readonly DraftLeagueSeriesPlan[],
  seeding: readonly number[],
): BracketMatch[][] {
  return plans.length === 3
    ? [
        [
          { round: 0, seriesIndex: plans[0]!.index, slots: [seeding[0]!, seeding[3]!], winner: null },
          { round: 0, seriesIndex: plans[1]!.index, slots: [seeding[1]!, seeding[2]!], winner: null },
        ],
        [{ round: 1, seriesIndex: plans[2]!.index, slots: [null, null], winner: null }],
      ]
    : [[{ round: 0, seriesIndex: plans[0]!.index, slots: [seeding[0]!, seeding[1]!], winner: null }]];
}

function builtTeamSummary(build: TeambuildView): string {
  const sets = build.sets.map((set) => {
    const evs = Object.entries(set.evs)
      .filter(([, value]) => Number(value) > 0)
      .map(([stat, value]) => `${stat} ${value}`)
      .join('/');
    return `${set.species} @ ${set.item}; ${set.ability}; ${set.nature}; ${set.moves.join('/')}; ${evs || '0 investment'}`;
  });
  return `Plan: ${build.rationale || '(none)'} Registered sets: ${sets.join(' | ')}`;
}

function initialBattleNotebook(build: TeambuildView): string {
  return `Matchup build carried from teambuilding. ${builtTeamSummary(build)}`;
}

function draftRosterSummary(roster: readonly DraftBoardMon[], build: TeambuildView): string {
  const registered = new Set(build.brought);
  const names = (mons: readonly DraftBoardMon[]) => mons.map((mon) => mon.name).join(', ') || '(none)';
  return (
    `registered for this series: ${names(roster.filter((mon) => registered.has(mon.id)))}; ` +
    `left behind: ${names(roster.filter((mon) => !registered.has(mon.id)))}.`
  );
}

export function draftLeaguePlayoffReview(summary: string, build: TeambuildView, notebook: string): string {
  return `${summary}. ${builtTeamSummary(build)} Final private battle note: ${notebook || '(empty)'}`;
}

export function buildDraftLeagueSchedule(entrants: number, seed: number) {
  const weeks = roundRobinWeeks(entrants);
  const topology = draftLeagueTopology(entrants);
  const { playoffRounds } = topology;
  const plans: DraftLeagueSeriesPlan[] = [];
  for (const [week, pairs] of weeks.entries()) {
    for (const pair of pairs) {
      plans.push({
        index: plans.length,
        stage: 'roundrobin',
        round: week + 1,
        entrants: pair,
        ...seriesEntropy(seededRng(`${seed}:series:${plans.length}`)),
      });
    }
  }
  for (let series = 0; series < topology.playoffSeries; series += 1) {
    plans.push({
      index: plans.length,
      stage: 'playoff',
      round: playoffRounds === 1 || series < 2 ? 1 : 2,
      entrants: null,
      ...seriesEntropy(seededRng(`${seed}:series:${plans.length}`)),
    });
  }
  return { weeks, playoffRounds, plans };
}

function transactionPolicyLine(schedule: TransactionSchedule, swapsAllowed: number): string {
  if (!schedule.length) {
    return '- After the draft this roster is locked for the whole season: a round robin of best-of-three matches, then playoffs.';
  }
  const weeksList = schedule.map((window) => window.afterWeek).join(', ');
  const offers = [...new Set(schedule.map((window) => window.tradesAllowed))];
  const offerText =
    offers.length === 1
      ? `up to ${offers[0]} one-for-one coach-trade ${offers[0] === 1 ? 'offer' : 'offers'}`
      : `a window-specific number of one-for-one coach-trade offers (${schedule.map((window) => `${window.tradesAllowed} after week ${window.afterWeek}`).join(', ')})`;
  return (
    `- Transaction windows open after round-robin ${schedule.length === 1 ? 'week' : 'weeks'} ${weeksList}. In each window every coach may make ${offerText}, then free-agent swaps from a season allowance of ${swapsAllowed} per franchise, spent across all windows. ` +
    `Rosters lock after the ${schedule.length === 1 ? 'window' : 'last window'} for the rest of the season, including playoffs.`
  );
}

export async function runDraftLeague(
  models: string[],
  runDir: string,
  options: DraftLeagueOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error('a draft league needs at least two models');
  validateModelExecution(models, options);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
  const psDir = options.psDir ?? defaultPsDir();
  const board = loadBoard(options.board ?? 'regmb-202607', options.boardsDir ?? BOARDS_DIR, psDir);
  const distinctBases = new Set(board.mons.map((mon) => mon.base)).size;
  if (models.length * board.picks > distinctBases) {
    throw new Error(
      `board ${JSON.stringify(board.id)} holds ${distinctBases} distinct species, too few for ${models.length} rosters of ${board.picks}`,
    );
  }
  const seed = resolveSeed(options.seed);
  const timerScale = options.timerScale ?? DEFAULT_TIMER_SCALE;
  const sheetPolicy: TeamBuildSheetPolicy = options.closedSheets === true ? 'closed' : 'open';
  const random = seededRng(seed);
  /** The one simulator identity a reader needs: format legality and results come from this pin. */
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
      `run ${path.basename(runDir)} configures no transaction windows but holds transaction artifacts: ${storedTransactionArtifacts.join(', ')}`,
    );
  }
  if (storedSchedule === undefined && stored && storedTransactionArtifacts.length) {
    throw new Error(
      `draft-only run ${path.basename(runDir)} cannot be promoted while transaction artifacts exist: ${storedTransactionArtifacts.join(', ')}`,
    );
  }
  const entrants = stored ? stored.entrants : shuffle(models, random);
  const { weeks, playoffRounds, plans } = buildDraftLeagueSchedule(entrants.length, seed);
  const schedule: TransactionSchedule = draftOnly
    ? []
    : (storedSchedule ??
      (options.transactions === undefined ? defaultTransactionSchedule(weeks.length) : (options.transactions ?? [])));
  validateTransactionSchedule(schedule, weeks.length);
  const swapsAllowed = stored?.swapsAllowed ?? options.swapsAllowed ?? DEFAULT_SWAPS_ALLOWED;
  validateSwapsAllowed(swapsAllowed, 'swaps allowed');
  if (stored && options.swapsAllowed !== undefined && options.swapsAllowed !== stored.swapsAllowed) {
    throw new Error(
      `run ${path.basename(runDir)} allows ${stored.swapsAllowed} season swaps; that is frozen for the run`,
    );
  }
  const configuredTransactions = schedule.map((window) => ({
    after_week: window.afterWeek,
    trades_allowed: window.tradesAllowed,
  }));
  const rosterVersionFor = (plan: DraftLeagueSeriesPlan): number =>
    plan.stage === 'playoff' ? schedule.length : schedule.filter((window) => window.afterWeek < plan.round).length;
  const sequentialWeeks = stored
    ? stored.sequentialWeeks
    : options.sequentialWeeks === true || options.throughWeek !== undefined;
  const reviewWeeks = sequentialWeeks
    ? weeks.map((_, index) => index + 1)
    : [...new Set([...schedule.map((window) => window.afterWeek), weeks.length])].sort((a, b) => a - b);
  const runId = path.basename(runDir);
  const storedRows = stored
    ? loadStoredLeagueRows(recordsPath, runId, plans, board.id, seed)
    : { all: [], roundRobin: new Map<number, SeriesRecord>(), playoffs: new Map<number, SeriesRecord>() };
  if (stored && storedSchedule === undefined) {
    const evidence = draftOnlyPromotionEvidence(runDir, storedRows.all);
    if (evidence.length) {
      throw new Error(
        `draft-only run ${runId} cannot be promoted while season evidence exists: ${evidence.join(', ')}`,
      );
    }
  }
  const completed = new Map<number, SeriesRecord>();
  const storedOutcomes = new Map<number, StoredSeriesOutcome>();
  const outcomeFor = (plan: DraftLeagueSeriesPlan): StoredSeriesOutcome => {
    const outcome = storedOutcomes.get(plan.index);
    if (!outcome) throw new Error(`run ${runId} series ${plan.index} lacks a validated outcome`);
    return outcome;
  };
  const storedRoundRobinRows = storedRows.roundRobin;
  const storedPlayoffRows = storedRows.playoffs;
  const storedRunRows = storedRows.all;
  const table: DraftTableRow[] = entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 }));
  const teambuilds: TeambuildView[] = [];
  const { playoffContext, reflectionNotes } = loadStoredCoaching(runDir, entrants.length);
  const resultSummaries = entrants.map(() => new Map<number, string>());
  let memories: FranchiseMemory[] = entrants.map(() => emptyMemory());
  let draftNotes: string[] = entrants.map(() => '');
  let phase: DraftView['phase'] = 'draft';
  let week = 0;
  let rosters: DraftBoardMon[][] = entrants.map(() => []);
  let budgets: number[] = entrants.map(() => board.budget);
  let teamNames: string[] = entrants.map(() => '');
  let picks: DraftView['picks'] = stored ? loadStoredPicks(runDir, entrants.length, board) : [];
  const draftView = (withTable: boolean): DraftView => ({
    boardId: board.id,
    budget: board.budget,
    picksPerEntrant: board.picks,
    entrants: [...entrants],
    teamNames: [...teamNames],
    picks: [...picks],
    rosters: rosters.map((roster) => roster.map((mon) => mon.id)),
    budgets: [...budgets],
    table: withTable ? rankedTable(table) : null,
    teambuilds: [...teambuilds],
    week,
    weeks: weeks.length,
    phase,
  });

  options.onEvent?.({
    type: 'plans',
    mode: 'draft',
    plans: plans.map((plan) => ({
      index: plan.index,
      players: plan.entrants
        ? { p1: entrants[plan.entrants[0]]!, p2: entrants[plan.entrants[1]]! }
        : { p1: 'TBD', p2: 'TBD' },
    })),
    pool: board.id,
    seed,
  });
  options.onEvent?.({ type: 'draft', draft: draftView(false) });

  const writeConfig = (outcome?: Partial<DraftLeagueCompletion>): void => {
    writeDraftLeagueConfig(
      {
        runDir,
        showdownCommit: psCommit,
        models,
        entrants,
        seed,
        concurrency: options.concurrency ?? 2,
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
        teamNames,
        weeks: weeks.length,
      },
      outcome,
    );
  };

  if (stored) {
    const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
    rosters = stored.rosterIds.map((ids) =>
      ids.map((id) => {
        const mon = monById.get(id);
        if (!mon) throw new Error(`run ${runId} drafted ${id}, which board ${board.id} does not hold`);
        return mon;
      }),
    );
    budgets = rosters.map((roster) => board.budget - roster.reduce((sum, mon) => sum + mon.cost, 0));
    teamNames = stored.teamNames;
    draftNotes = stored.draftNotes;
    memories = draftNotes.map((note) => emptyMemory(note));
  } else if (options.preset) {
    rosters = presetRosters(options.preset, board, entrants.length);
    budgets = rosters.map((roster) => board.budget - roster.reduce((sum, mon) => sum + mon.cost, 0));
    teamNames = options.preset.teams.map((team) => team.name);
    draftNotes = options.preset.teams.map((team) => team.note);
    memories = draftNotes.map((note) => emptyMemory(note));
  } else {
    writeConfig();
    const draftOptions: RunDraftOptions = {
      psDir,
      logDir: path.join(runDir, 'draft'),
      rng: random,
      rosterPolicy: transactionPolicyLine(schedule, swapsAllowed),
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
      signal: options.signal,
    };
    draftOptions.onPick = (view, state) => {
      picks = [...picks, view];
      rosters = state.rosters;
      budgets = state.budgets;
      writeConfig();
      options.onEvent?.({ type: 'draft', draft: draftView(false) });
    };
    draftOptions.onName = (_entrant, _teamName, state) => {
      teamNames = [...state.teamNames];
      writeConfig();
      options.onEvent?.({ type: 'draft', draft: draftView(false) });
    };
    const outcome = await runDraft(entrants, board, draftOptions);
    rosters = outcome.rosters;
    budgets = outcome.budgets;
    teamNames = outcome.teamNames;
    draftNotes = outcome.notebooks;
    memories = draftNotes.map((note) => emptyMemory(note));
  }
  const initialRosters = rosters.map((roster) => [...roster]);
  if (stored || options.preset) {
    validateLeagueRosterState(
      {
        board,
        models: entrants,
        teamNames,
        rosters,
        budgets,
        memories,
        standings: rankedTable(table),
        results: entrants.map(() => []),
        reflections: entrants.map(() => []),
        history: [],
        swapsAllowed,
        swapsUsed: entrants.map(() => 0),
      },
      `${stored ? 'resumed' : 'preset'} initial roster for run ${runId}`,
    );
  }
  const windowArtifacts: TradeWindowArtifact[] = [];
  const swapsUsed = (): number[] => windowArtifacts.at(-1)?.swaps_used?.slice() ?? entrants.map(() => 0);
  const rosterHistory: DraftBoardMon[][][] = [initialRosters];
  const rosterStateFor = (plan: DraftLeagueSeriesPlan): readonly DraftBoardMon[][] => {
    const state = rosterHistory[rosterVersionFor(plan)];
    if (!state) {
      throw new Error(
        `run ${runId} series ${plan.index} needs roster version ${rosterVersionFor(plan)}, which has not been reached`,
      );
    }
    return state;
  };

  if (!stored) {
    writeDraftLeagueRosters(runDir, board.budget, entrants, teamNames, budgets, rosters);
    writeConfig({
      rosters: rosters.map((roster) => roster.map((mon) => mon.id)),
      draft_notes: draftNotes,
      contributor: options.contributor ?? null,
    });
  }

  if (draftOnly) {
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    return [];
  }

  phase = 'roundrobin';
  options.onEvent?.({ type: 'draft', draft: draftView(true) });

  const storedTeambuilds = stored ? loadStoredTeambuilds(path.join(runDir, 'teambuild')) : new Map();
  const storedBuildFor = (
    plan: DraftLeagueSeriesPlan,
    entrant: number,
    opponent: number,
    rosterState: readonly DraftBoardMon[][],
  ): { packed: string; view: TeambuildView } => {
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
    builds: Record<Pid, { packed: string; view: TeambuildView }>,
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
      requireWinner: plan.stage === 'playoff',
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
      sampling: 'provider-default',
    };
    if (row.closed_sheets !== undefined) storedFields.closed_sheets = row.closed_sheets;
    if (row.reasoning_by_player !== undefined) storedFields.reasoning_by_player = row.reasoning_by_player;
    if (
      row.schema_version !== 1 ||
      row.mode !== 'draft' ||
      row.ps_commit !== psCommit ||
      row.series_index !== plan.index ||
      !isDeepStrictEqual(row.entrants, pair) ||
      row.roster_version !== rosterVersionFor(plan) ||
      !isDeepStrictEqual(row.transactions, configuredTransactions)
    ) {
      throw new Error(`run ${runId} series ${plan.index} is not bound to its current construction and policies`);
    }
    if (!isDeepStrictEqual(storedFields, canonical.fields)) {
      throw new Error(`run ${runId} series ${plan.index} does not match its canonical completed series evidence`);
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
      const build = teambuilds.find((view) => view.seriesIndex === plan.index && view.entrant === entrant);
      const registered = build ? `; registered ${build.brought.map(monName).join(', ')}` : '';
      lines.push(`${summary}${registered}`);
      const context = playoffContext[entrant]!.get(plan.index);
      if (plan.entrants.includes(opponent) && context) lines.push(`Against this coach: ${context}`);
    }
    return lines;
  };

  const teambuildFor = async (plan: DraftLeagueSeriesPlan, entrant: number, opponent: number, signal: AbortSignal) => {
    const storedRows = storedTeambuilds.get(`${plan.index}:${entrant}`) ?? [];
    let reused: { packed: string; view: TeambuildView } | undefined;
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
        rosterIds: rosters[entrant]!.map((mon) => mon.id),
        opponentRosterIds: rosters[opponent]!.map((mon) => mon.id),
      });
    }
    if (reused) {
      try {
        validateTeam(reused.packed, board.format, psDir);
        teambuilds.push(reused.view);
        options.onEvent?.({ type: 'draft', draft: draftView(true) });
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
      franchiseName: teamNames[entrant]!,
      roster: rosters[entrant]!,
      opponentRoster: rosters[opponent]!,
      memory: memories[entrant]!,
      playoffContext: priorContextFor(entrant, opponent),
      format: board.format,
      sheetPolicy,
    };
    const teambuildOptions: TeambuildOptions = {
      psDir,
      logDir: path.join(runDir, 'teambuild'),
      rng: seededRng(`${seed}:tb:${plan.index}:${entrant}`),
      signal,
      reasoning: options.reasoning,
      reasoningByModel: options.reasoningByModel,
      apiKeys: options.apiKeys,
    };
    const result = await runTeambuild(request, teambuildOptions);
    validateTeam(result.packed, board.format, psDir);
    teambuilds.push(result.view);
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    return result;
  };

  const results: SeriesRecord[] = [];
  let seeding: number[] = [];
  let playoffBracketRounds: BracketMatch[][] | undefined;
  const playSeries = async (plan: DraftLeagueSeriesPlan, signal: AbortSignal): Promise<SeriesRecord> => {
    const [a, b] = plan.entrants!;
    const players = { p1: entrants[a]!, p2: entrants[b]! };
    options.onEvent?.({ type: 'series-players', index: plan.index, players });
    const [home, away] = await Promise.all([teambuildFor(plan, a, b, signal), teambuildFor(plan, b, a, signal)]);
    options.onEvent?.({ type: 'series-start', index: plan.index });
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
        p1: draftRosterSummary(rosters[a]!, home.view),
        p2: draftRosterSummary(rosters[b]!, away.view),
      },
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: board.format,
      psDir,
      runDir,
      signal,
      requireWinner: plan.stage === 'playoff',
      closedSheets: options.closedSheets,
      reasoning: options.reasoning,
      apiKeys: options.apiKeys,
      reasoningByModel: options.reasoningByModel,
      timerScale,
      onGameUpdate: (game, lines, publicLines) =>
        options.onEvent?.({ type: 'game-update', index: plan.index, game, lines, publicLines }),
      onGameEnd: (game, winner, turns, score) =>
        options.onEvent?.({ type: 'game-end', index: plan.index, game, winner, turns, score }),
      onDecision: (pid, row) => options.onEvent?.({ type: 'decision', index: plan.index, pid, row }),
    };
    const { winnerSide, fields, coachNotes } = await playRecordedSeries(seriesContext);
    const row: SeriesRecord = {
      schema_version: 1,
      mode: 'draft',
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
    if (plan.stage === 'playoff') {
      if (!winnerSide) throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
      row.advanced = entrants[winnerSide === 'p1' ? a : b]!;
    }
    if (options.contributor !== undefined) row.contributor = options.contributor;
    appendRow(recordsPath, row);
    completed.set(plan.index, row);
    storedOutcomes.set(plan.index, { score: fields.score, winnerSide });
    applyOutcome(plan, {
      p1: { build: home.view, notebook: coachNotes.p1 },
      p2: { build: away.view, notebook: coachNotes.p2 },
    });
    options.onEvent?.({ type: 'series-end', index: plan.index, record: row });
    return row;
  };

  const applyOutcome = (
    plan: DraftLeagueSeriesPlan,
    coaching?: Record<Pid, { build: TeambuildView; notebook: string }>,
  ): void => {
    const [a, b] = plan.entrants!;
    const { winnerSide, score } = outcomeFor(plan);
    for (const [entrant, opponent, side] of [
      [a, b, 'p1'],
      [b, a, 'p2'],
    ] as const) {
      const won = winnerSide === side;
      const result = winnerSide ? (won ? 'beat' : 'lost to') : 'drew with';
      const summary =
        `${plan.stage === 'playoff' ? `Playoff round ${plan.round}` : `Round-robin week ${plan.round}`}: ${result} ` +
        `${entrants[opponent]} ${score[side]}-${score[side === 'p1' ? 'p2' : 'p1']}`;
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
    if (plan.stage === 'roundrobin') {
      table[a]!.gw += score.p1;
      table[a]!.gl += score.p2;
      table[b]!.gw += score.p2;
      table[b]!.gl += score.p1;
      if (winnerSide) {
        table[winnerSide === 'p1' ? a : b]!.w += 1;
        table[winnerSide === 'p1' ? b : a]!.l += 1;
      }
      options.onEvent?.({ type: 'draft', draft: draftView(true) });
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
  const standingsThrough = (afterWeek: number): DraftTableRow[] => {
    const rows: DraftTableRow[] = entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 }));
    for (const plan of plans) {
      if (plan.stage !== 'roundrobin' || plan.round > afterWeek || !plan.entrants) continue;
      const row = completed.get(plan.index);
      if (!row) continue;
      const { score, winnerSide: winner } = outcomeFor(plan);
      const [a, b] = plan.entrants;
      rows[a]!.gw += score.p1;
      rows[a]!.gl += score.p2;
      rows[b]!.gw += score.p2;
      rows[b]!.gl += score.p1;
      if (winner) {
        rows[winner === 'p1' ? a : b]!.w += 1;
        rows[winner === 'p1' ? b : a]!.l += 1;
      }
    }
    return rankedTable(rows);
  };
  const adoptWindow = (artifact: TradeWindowArtifact): void => {
    const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
    rosters = artifact.rosters.map(({ roster }) => roster.map(({ id }) => monById.get(id)!));
    budgets = artifact.rosters.map(({ budget_left }) => budget_left);
    windowArtifacts.push(artifact);
    rosterHistory.push(rosters.map((roster) => [...roster]));
  };

  let reviewedThrough = 0;
  const reviewSeries = (throughWeek: number): WeeklyReviewSeries[] => {
    const list: WeeklyReviewSeries[] = [];
    for (const plan of plans) {
      if (plan.stage !== 'roundrobin' || plan.round > throughWeek || !plan.entrants) continue;
      const row = completed.get(plan.index);
      if (!row) continue;
      const { score, winnerSide } = outcomeFor(plan);
      const [a, b] = plan.entrants;
      list.push({
        index: plan.index,
        week: plan.round,
        seriesId: String(row.series_id),
        entrants: [a, b],
        score: [score.p1, score.p2],
        winner: winnerSide === undefined ? null : winnerSide === 'p1' ? a : b,
        context: {
          [a]: playoffContext[a]!.get(plan.index) ?? '',
          [b]: playoffContext[b]!.get(plan.index) ?? '',
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
      (plan) => plan.stage === 'roundrobin' && plan.round <= week && !completed.has(plan.index),
    );
    if (missing) throw new Error(`run ${runId} ${context} for week ${week} precedes scheduled series ${missing.index}`);
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
    if (!reviewWeeks.includes(week) || reviewedThrough >= week) return;
    requireWeekComplete(week, 'weekly review');
    const series = reviewSeries(week);
    const nextWindow = schedule.find((window) => window.afterWeek >= week);
    await runWeeklyReview(
      {
        board,
        models: entrants,
        stage: 'week',
        week,
        weeks: weeks.length,
        rosterVersion: windowArtifacts.length,
        rosters,
        memories,
        standings: rankedTable(table),
        series,
        period: series.filter((entry) => entry.week > reviewedThrough).map((entry) => entry.index),
        schedule: plans.flatMap((plan) =>
          plan.stage === 'roundrobin' && plan.entrants
            ? [{ index: plan.index, week: plan.round, entrants: plan.entrants }]
            : [],
        ),
        transactions: describeTransactionHistory(windowArtifacts, entrants),
        nextWindowWeek: nextWindow ? nextWindow.afterWeek : null,
      },
      reviewOptions,
    );
    reviewedThrough = week;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
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
      memories[row.entrant] = cloneMemory(row.memory);
    }
  };
  const adoptStoredReview = (week: number): boolean => {
    const rows = readWeeklyReviews(runDir, week);
    if (rows.length < entrants.length) {
      if (rows.length) requireWeekComplete(week, 'weekly review');
      return false;
    }
    requireWeekComplete(week, 'weekly review');
    adoptReviewRows(rows, week, 'week');
    reviewedThrough = week;
    return true;
  };
  const changedSeats = (index: number): number[] => {
    const before = rosterHistory[index]!;
    const after = rosterHistory[index + 1]!;
    return entrants.flatMap((_, entrant) => {
      const ids = new Set(before[entrant]!.map((mon) => mon.id));
      const same = after[entrant]!.length === ids.size && after[entrant]!.every((mon) => ids.has(mon.id));
      return same ? [] : [entrant];
    });
  };
  const reconciled = new Set<number>();
  const adoptStoredReconciliation = (index: number): boolean => {
    const window = schedule[index]!;
    const seats = changedSeats(index);
    const rows = readWeeklyReviews(runDir, window.afterWeek, 'transactions');
    if (seats.some((seat) => !rows.some((row) => row.entrant === seat))) return false;
    adoptReviewRows(rows, window.afterWeek, 'transactions');
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
          stage: 'transactions',
          week: window.afterWeek,
          weeks: weeks.length,
          rosterVersion: index + 1,
          rosters,
          previousRosters: rosterHistory[index]!,
          seats,
          memories,
          standings: rankedTable(table),
          series: [],
          period: [],
          schedule: plans.flatMap((plan) =>
            plan.stage === 'roundrobin' && plan.entrants
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
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
  };

  validateStoredRoundRobin(0);
  if (stored) {
    for (const week of reviewWeeks) {
      if (!adoptStoredReview(week)) {
        const epoch = schedule.find((window) => window.afterWeek === week);
        const evidence = [
          ...(epoch ? transactionArtifactPaths(transactionEpochDir(runDir, week)) : []),
          ...postWindowEvidence(runDir, storedRunRows, plans, week),
        ];
        if (evidence.length) {
          throw new Error(
            `run ${runId} has evidence past its week-${week} review barrier but lacks a complete review: ${evidence.join(', ')}`,
          );
        }
        break;
      }
      const index = schedule.findIndex((window) => window.afterWeek === week);
      if (index === -1) continue;
      const window = schedule[index]!;
      const epochDir = transactionEpochDir(runDir, window.afterWeek);
      if (transactionArtifactPaths(epochDir).length) {
        requireTransactionResultPrefix(runId, storedRunRows, plans, window.afterWeek);
      }
      const artifact = readValidatedTradeWindow(
        epochDir,
        {
          board,
          models: entrants,
          teamNames,
          rosters,
          budgets,
          memories,
          standings: standingsThrough(window.afterWeek),
          results: entrants.map(() => []),
          reflections: entrants.map(() => []),
          history: describeTransactionHistory(windowArtifacts, entrants),
          swapsAllowed,
          swapsUsed: swapsUsed(),
        },
        window,
      );
      if (!artifact) {
        const evidence = postWindowEvidence(runDir, storedRunRows, plans, window.afterWeek);
        if (evidence.length) {
          throw new Error(
            `run ${runId} has evidence past its week-${window.afterWeek} transaction barrier but lacks authoritative window artifacts: ${evidence.join(', ')}`,
          );
        }
        break;
      }
      adoptWindow(artifact);
      if (!adoptStoredReconciliation(index)) {
        const evidence = postWindowEvidence(runDir, storedRunRows, plans, window.afterWeek);
        if (evidence.length) {
          throw new Error(
            `run ${runId} has evidence past its week-${window.afterWeek} transaction barrier but lacks the reconciliation review of every changed roster: ${evidence.join(', ')}`,
          );
        }
        break;
      }
      validateStoredRoundRobin(index + 1);
    }
  }

  for (const plan of plans) {
    if (plan.stage !== 'roundrobin') continue;
    const row = completed.get(plan.index);
    if (row) {
      applyOutcome(plan);
      results.push(row);
    }
  }

  if (storedPlayoffRows.size) {
    const missingRoundRobin = plans.find((plan) => plan.stage === 'roundrobin' && !completed.has(plan.index));
    if (missingRoundRobin) {
      throw new Error(
        `run ${runId} has a playoff result before scheduled round-robin series ${missingRoundRobin.index}; it cannot resume`,
      );
    }
    const playoffPlans = plans.filter((plan) => plan.stage === 'playoff');
    playoffBracketRounds = buildDraftPlayoffBracket(
      playoffPlans,
      rankedTable(table).map((row) => row.entrant),
    );
    for (let round = 0; round < playoffBracketRounds.length; round += 1) {
      for (let position = 0; position < playoffBracketRounds[round]!.length; position += 1) {
        const match = playoffBracketRounds[round]![position]!;
        if (
          match.seriesIndex === null ||
          match.slots[0] === null ||
          match.slots[1] === null ||
          completed.has(match.seriesIndex)
        ) {
          continue;
        }
        const row = storedPlayoffRows.get(match.seriesIndex);
        if (!row) continue;
        const plan = playoffPlans.find((candidate) => candidate.index === match.seriesIndex)!;
        const pair: [number, number] = [match.slots[0], match.slots[1]];
        plan.entrants = pair;
        const builds = {
          p1: storedBuildFor(plan, pair[0], pair[1], rosters),
          p2: storedBuildFor(plan, pair[1], pair[0], rosters),
        };
        const outcome = validateStoredSeriesEvidence(row, plan, pair, builds, rosters);
        if (!outcome.winnerSide) throw new Error(`run ${runId} playoff series ${plan.index} has no canonical winner`);
        const expectedAdvanced = entrants[outcome.winnerSide === 'p1' ? pair[0] : pair[1]];
        if (row.advanced !== expectedAdvanced) {
          throw new Error(`run ${runId} series ${plan.index} advances a player other than its canonical winner`);
        }
        playoffBracketRounds = applyBracketOutcome(playoffBracketRounds, match, outcome.winnerSide);
        teambuilds.push(builds.p1.view, builds.p2.view);
        completed.set(plan.index, row);
        storedOutcomes.set(plan.index, outcome);
      }
    }
    const unresolved = [...storedPlayoffRows.keys()].find((index) => !completed.has(index));
    if (unresolved !== undefined) {
      throw new Error(
        `run ${runId} playoff series ${unresolved} has unresolved bracket prerequisites; it cannot resume`,
      );
    }
  }

  if (stored && storedSchedule === undefined) promoteDraftOnlyConfig(runDir, stored, configuredTransactions);

  const stopWeek = options.throughWeek;
  const openTradeWindow = async (index: number): Promise<void> => {
    const window = schedule[index];
    if (!window || windowArtifacts.length > index) return;
    phase = 'window';
    week = window.afterWeek;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    const preWindowRosters = rosters.map((roster) => [...roster]);
    const windowResults: TradeWindowResult[][] = entrants.map(() => []);
    for (const plan of plans) {
      if (plan.stage !== 'roundrobin' || plan.round > window.afterWeek || !plan.entrants) continue;
      const row = completed.get(plan.index);
      if (!row) continue;
      const [a, b] = plan.entrants;
      const { score, winnerSide: winner } = outcomeFor(plan);
      for (const [entrant, opponent, side] of [
        [a, b, 'p1'],
        [b, a, 'p2'],
      ] as const) {
        const other = side === 'p1' ? 'p2' : 'p1';
        windowResults[entrant]!.push({
          entrant,
          opponent,
          week: plan.round,
          score: [score[side], score[other]],
          result: winner === undefined ? 'drew' : winner === side ? 'won' : 'lost',
          opponentRoster: preWindowRosters[opponent]!.map((mon) => `${mon.id} (${mon.cost})`).join(', '),
        });
      }
    }
    const tradeState = {
      board,
      models: entrants,
      teamNames,
      rosters,
      budgets,
      memories,
      standings: rankedTable(table),
      results: windowResults,
      reflections: reflectionNotes.map((notes) =>
        [...notes.entries()].sort(([a], [b]) => a - b).map(([, note]) => note),
      ),
      history: describeTransactionHistory(windowArtifacts, entrants),
      swapsAllowed,
      swapsUsed: swapsUsed(),
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
    windowArtifacts.push(artifact);
    rosterHistory.push(rosters.map((roster) => [...roster]));
    phase = 'roundrobin';
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
  };
  /** A coach reviews its season at the moment that season ends, so a team knocked out in the round robin
   * judges its draft without seeing playoff results it was never part of. */
  const closeSeason = async (finished: Array<{ entrant: number; outcome: string }>): Promise<void> => {
    if (!finished.length || options.signal?.aborted) return;
    const seasonState = {
      board,
      models: entrants,
      picks,
      rosters,
      windows: windowArtifacts,
      standings: rankedTable(table),
      series: playoffContext.map((context) =>
        [...context.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry),
      ),
      notebooks: memories.map((memory) => renderMemory(memory, 'full').join('\n')),
    };
    await runSeasonReview(finished, seasonState, reviewOptions);
  };
  /** A retrospective buys nothing later games depend on, so an eliminated coach writes its review while the
   * bracket plays on; the run joins the outstanding reviews, and surfaces their failures, before it returns. */
  const seasonJobs: Promise<void>[] = [];
  let seasonFailure: unknown;
  const startSeasonClose = (finished: Array<{ entrant: number; outcome: string }>): void => {
    seasonJobs.push(
      closeSeason(finished).catch((error) => {
        seasonFailure ??= error;
      }),
    );
  };
  const finish = async (): Promise<SeriesRecord[]> => {
    await Promise.all(seasonJobs);
    if (seasonFailure !== undefined && !options.signal?.aborted) throw seasonFailure;
    return sorted(results);
  };
  const scheduleRoundRobin = async (scheduled: DraftLeagueSeriesPlan[]): Promise<void> => {
    results.push(
      ...(await mapLimit(scheduled, options.concurrency ?? 2, options.signal, (plan, signal) =>
        playSeries(plan, signal),
      )),
    );
  };
  if (sequentialWeeks || stopWeek !== undefined) {
    for (const index of weeks.keys()) {
      if (options.signal?.aborted) return sorted(results);
      week = index + 1;
      options.onEvent?.({ type: 'draft', draft: draftView(true) });
      await scheduleRoundRobin(
        plans.filter((plan) => plan.stage === 'roundrobin' && plan.round === week && !completed.has(plan.index)),
      );
      if (stopWeek !== undefined && week >= stopWeek) {
        options.onEvent?.({ type: 'draft', draft: draftView(true) });
        return sorted(results);
      }
      await reviewWeekFor(week);
      const windowIndex = schedule.findIndex((window) => window.afterWeek === week);
      if (windowIndex !== -1) {
        await openTradeWindow(windowIndex);
        await reconcileWindow(windowIndex);
      }
    }
  } else {
    let firstWeek = 1;
    for (const [index, window] of schedule.entries()) {
      week = window.afterWeek;
      options.onEvent?.({ type: 'draft', draft: draftView(true) });
      await scheduleRoundRobin(
        plans.filter(
          (plan) =>
            plan.stage === 'roundrobin' &&
            plan.round >= firstWeek &&
            plan.round <= window.afterWeek &&
            !completed.has(plan.index),
        ),
      );
      if (options.signal?.aborted) return sorted(results);
      await reviewWeekFor(window.afterWeek);
      await openTradeWindow(index);
      await reconcileWindow(index);
      firstWeek = window.afterWeek + 1;
    }
    week = weeks.length;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    await scheduleRoundRobin(
      plans.filter((plan) => plan.stage === 'roundrobin' && plan.round >= firstWeek && !completed.has(plan.index)),
    );
    if (options.signal?.aborted) return sorted(results);
    await reviewWeekFor(weeks.length);
  }
  if (options.signal?.aborted) return sorted(results);

  seeding = rankedTable(table).map((row) => row.entrant);
  phase = 'playoffs';
  week = 0;
  options.onEvent?.({ type: 'draft', draft: draftView(true) });

  startSeasonClose(
    seeding.slice(playoffRounds === 2 ? 4 : 2).map((entrant, index) => ({
      entrant,
      outcome: `You finished ${ordinal((playoffRounds === 2 ? 4 : 2) + index + 1)} of ${entrants.length} in the round robin and missed the playoffs. Your season is over.`,
    })),
  );
  if (options.signal?.aborted) return finish();

  const playoffs = plans.filter((plan) => plan.stage === 'playoff');
  let bracketRounds = playoffBracketRounds ?? buildDraftPlayoffBracket(playoffs, seeding);
  const bracketView = (): BracketView => {
    const championship = bracketRounds.at(-1)?.[0];
    if (!championship) throw new Error(`run ${runId} has no championship bracket match`);
    return {
      entrants: entrants.map((model, index) => ({
        model,
        team: teamNames[index] || `seed ${seeding.indexOf(index) + 1}`,
      })),
      rounds: bracketRounds.map((round) =>
        round.map((match) => ({
          seriesIndex: match.seriesIndex,
          slots: [...match.slots],
          winner: match.winner,
        })),
      ),
      champion: championship.winner,
    };
  };
  options.onEvent?.({ type: 'bracket', bracket: bracketView() });

  const resolve = (scheduled: BracketMatch, winnerSide: Pid): number => {
    const winner = scheduled.slots[winnerSide === 'p1' ? 0 : 1];
    if (winner === null) throw new Error(`run ${runId} cannot resolve an empty playoff slot`);
    bracketRounds = applyBracketOutcome(bracketRounds, scheduled, winnerSide);
    options.onEvent?.({ type: 'bracket', bracket: bracketView() });
    return winner;
  };

  if (playoffRounds === 2) {
    const semis = await mapLimit(
      [0, 1],
      Math.min(options.concurrency ?? 2, 2),
      options.signal,
      async (matchIndex, signal) => {
        const plan = playoffs[matchIndex]!;
        const scheduled = bracketRounds[0]![matchIndex]!;
        const [first, second] = scheduled.slots;
        if (first === null || second === null) {
          throw new Error(`run ${runId} semifinal ${matchIndex + 1} has unresolved bracket slots`);
        }
        plan.entrants = [first, second];
        const existing = completed.get(plan.index);
        if (existing) {
          applyOutcome(plan);
          return existing;
        }
        const row = await playSeries(plan, signal);
        const winnerSide = outcomeFor(plan).winnerSide;
        if (!winnerSide) throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
        resolve(scheduled, winnerSide);
        return row;
      },
    );
    results.push(...semis);
    if (options.signal?.aborted) return finish();
    startSeasonClose(
      bracketRounds[0]!.flatMap((match) => {
        const loser = match.slots.find((slot) => slot !== null && slot !== match.winner);
        return loser === null || loser === undefined
          ? []
          : [
              {
                entrant: loser,
                outcome: `You reached the playoffs as the ${ordinal(seeding.indexOf(loser) + 1)} seed and were eliminated in the semifinals. Your season is over.`,
              },
            ];
      }),
    );
    if (options.signal?.aborted) return finish();
  }
  const finalPlan = playoffs[playoffs.length - 1]!;
  const finalRound = playoffRounds - 1;
  const scheduledFinal = bracketRounds[finalRound]![0]!;
  const [finalFirst, finalSecond] = scheduledFinal.slots;
  if (finalFirst === null || finalSecond === null) return finish();
  finalPlan.entrants = [finalFirst, finalSecond];
  const storedFinal = completed.get(finalPlan.index);
  const finalRow = storedFinal
    ? [storedFinal]
    : await mapLimit([finalPlan], 1, options.signal, (plan, signal) => playSeries(plan, signal));
  if (finalRow[0]) {
    if (storedFinal) applyOutcome(finalPlan);
    const finalWinnerSide = outcomeFor(finalPlan).winnerSide;
    if (!finalWinnerSide) throw new Error(`draft playoff series ${finalPlan.index + 1} ended without a winner`);
    const champion = storedFinal
      ? finalWinnerSide === 'p1'
        ? finalFirst
        : finalSecond
      : resolve(scheduledFinal, finalWinnerSide);
    results.push(finalRow[0]);
    const runnerUp = finalPlan.entrants.find((entrant) => entrant !== champion);
    await closeSeason([
      ...(runnerUp === undefined || runnerUp === null
        ? []
        : [
            {
              entrant: runnerUp,
              outcome: 'You reached the final and lost it. You are the league runner-up and your season is over.',
            },
          ]),
      { entrant: champion, outcome: 'You won the final. You are the league champion and the season is over.' },
    ]);
    phase = 'done';
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
  }
  return finish();
}

function sorted(rows: SeriesRecord[]): SeriesRecord[] {
  return [...rows].sort((a, b) => Number(a.series_index) - Number(b.series_index));
}

export function rankedTable(table: DraftTableRow[]): DraftTableRow[] {
  return [...table].sort((a, b) => b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || b.gw - a.gw || a.entrant - b.entrant);
}
