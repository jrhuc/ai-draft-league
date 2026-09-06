import type { DraftBoard, DraftBoardMon, DraftState } from "./draft.js";
import type { DraftLeagueOptions, DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { rankedTable } from "./draftleague-protocol.js";
import { emptyMemory, type FranchiseMemory } from "./franchise-memory.js";
import {
  recordLeagueTransition,
  type LeagueRunState,
  storeFranchiseRosterVersion,
} from "./league-journal.js";
import type { StoredLeague } from "./league-store.js";
import type { ModelReasoningConfig } from "./providers.js";
import type { Rng } from "./random.js";
import type { SeriesRecord } from "./records.js";
import type { TeamBuildJournalEntry, TeamBuildSheetPolicy } from "./teambuild.js";
import type { TradeWindowArtifact, TransactionSchedule } from "./trade-window.js";
import type { Pid, TimerScale } from "./types.js";
import type { DraftTableRow, DraftView, TeamBuildView } from "./views.js";

export interface DraftLeagueContext {
  models: string[];
  runDir: string;
  runId: string;
  recordsPath: string;
  options: DraftLeagueOptions;
  psDir: string;
  board: DraftBoard;
  seed: number;
  timerScale: TimerScale;
  sheetPolicy: TeamBuildSheetPolicy;
  random: Rng;
  psCommit: string;
  stored: StoredLeague | undefined;
  storedBuilds: Map<string, TeamBuildJournalEntry>;
  entrants: string[];
  weeks: Array<Array<[number, number]>>;
  playoffRounds: number;
  plans: DraftLeagueSeriesPlan[];
  schedule: TransactionSchedule;
  swapsAllowed: number;
  configuredTransactions: Array<{ after_week: number; trades_allowed: number }>;
  draftOnly: boolean;
  reviewOptions: ReviewStageOptions;
}

export interface ReviewStageOptions extends ModelReasoningConfig {
  runDir: string;
  psDir: string;
  apiKeys?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface FranchiseState {
  entrant: number;
  model: string;
  teamName: string;
  roster: DraftBoardMon[];
  budget: number;
  memory: FranchiseMemory;
  draftNote: string;
  opponentDossiers: Map<number, string>;
  seriesNotes: Map<number, string>;
  resultSummaries: Map<number, string>;
}

export interface CompletedSeries {
  row: SeriesRecord;
  score: Record<Pid, number>;
  winnerSide: Pid | undefined;
}

/** In-process season state. Every field is rebuilt from `league.sqlite` by re-running the season
 * stages, each of which adopts what the database already holds before doing new work. */
export class LeagueCoordinator {
  readonly context: DraftLeagueContext;
  progress: LeagueRunState;
  readonly completed = new Map<number, CompletedSeries>();
  readonly teambuilds: TeamBuildView[] = [];
  readonly franchises: FranchiseState[];
  readonly windowArtifacts: TradeWindowArtifact[] = [];
  readonly rosterHistory: DraftBoardMon[][][] = [];
  picks: DraftView["picks"];

  constructor(context: DraftLeagueContext, picks: DraftView["picks"]) {
    this.context = context;
    this.picks = picks;
    this.franchises = context.entrants.map((model, entrant) => ({
      entrant,
      model,
      teamName: "",
      roster: [],
      budget: context.board.budget,
      memory: emptyMemory(),
      draftNote: "",
      opponentDossiers: new Map(),
      seriesNotes: new Map(),
      resultSummaries: new Map(),
    }));
    this.progress = { phase: "draft", completedPicks: picks.length };
    this.transition(this.progress);
  }

  get memories(): FranchiseMemory[] {
    return this.franchises.map((franchise) => franchise.memory);
  }

  get rosters(): DraftBoardMon[][] {
    return this.franchises.map((franchise) => franchise.roster);
  }

  get budgets(): number[] {
    return this.franchises.map((franchise) => franchise.budget);
  }

  get teamNames(): string[] {
    return this.franchises.map((franchise) => franchise.teamName);
  }

  transition(next: LeagueRunState): void {
    recordLeagueTransition(
      this.context.runDir,
      next,
      this.context.weeks.length,
      this.context.entrants.length,
    );
    this.progress = next;
  }

  get week(): number {
    return this.progress.phase === "roundrobin" || this.progress.phase === "window"
      ? this.progress.week
      : this.progress.phase === "playoffs"
        ? this.progress.round
        : 0;
  }

  adoptDraftState(state: DraftState): void {
    for (const franchise of this.franchises) {
      franchise.roster = state.rosters[franchise.entrant]!;
      franchise.budget = state.budgets[franchise.entrant]!;
      franchise.teamName = state.teamNames[franchise.entrant]!;
    }
  }

  seedFranchises(
    entries: ReadonlyArray<{ roster: DraftBoardMon[]; teamName: string; draftNote: string }>,
  ): void {
    if (entries.length !== this.franchises.length) {
      throw new Error(`expected ${this.franchises.length} franchises, got ${entries.length}`);
    }
    for (const [entrant, entry] of entries.entries()) {
      const franchise = this.franchises[entrant]!;
      franchise.roster = entry.roster;
      franchise.budget =
        this.context.board.budget - entry.roster.reduce((sum, mon) => sum + mon.cost, 0);
      franchise.teamName = entry.teamName;
      franchise.draftNote = entry.draftNote;
      franchise.memory = emptyMemory(entry.draftNote);
    }
  }

  storeRosterVersion(version: number): void {
    this.rosterHistory[version] = this.rosters.map((roster) => [...roster]);
    storeFranchiseRosterVersion(
      this.context.runDir,
      this.franchises.map((franchise) => ({
        rosterVersion: version,
        entrant: franchise.entrant,
        teamName: franchise.teamName,
        budget: franchise.budget,
        roster: franchise.roster.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
      })),
    );
  }

  draftView(withTable: boolean): DraftView {
    const { board, entrants, weeks } = this.context;
    return {
      boardId: board.id,
      budget: board.budget,
      picksPerEntrant: board.picks,
      entrants: [...entrants],
      teamNames: this.teamNames,
      picks: [...this.picks],
      rosters: this.rosters.map((roster) => roster.map((mon) => mon.id)),
      budgets: this.budgets,
      table: withTable ? this.standings() : null,
      teambuilds: [...this.teambuilds],
      week: this.week,
      weeks: weeks.length,
      phase: this.progress.phase,
    };
  }

  results(): SeriesRecord[] {
    return [...this.completed.entries()].sort(([a], [b]) => a - b).map(([, series]) => series.row);
  }

  outcomeFor(plan: DraftLeagueSeriesPlan): CompletedSeries {
    const outcome = this.completed.get(plan.index);
    if (!outcome) throw new Error(`run ${this.context.runId} series ${plan.index} is not complete`);
    return outcome;
  }

  rosterVersionFor(plan: DraftLeagueSeriesPlan): number {
    return plan.stage === "playoff"
      ? this.context.schedule.length
      : this.context.schedule.filter((window) => window.afterWeek < plan.round).length;
  }

  rosterStateFor(plan: DraftLeagueSeriesPlan): readonly DraftBoardMon[][] {
    const version = this.rosterVersionFor(plan);
    const state = this.rosterHistory[version];
    if (!state) {
      throw new Error(
        `run ${this.context.runId} series ${plan.index} needs roster version ${version}, which has not been reached`,
      );
    }
    return state;
  }

  standings(throughWeek = Number.POSITIVE_INFINITY): DraftTableRow[] {
    const rows: DraftTableRow[] = this.context.entrants.map((_, entrant) => ({
      entrant,
      w: 0,
      l: 0,
      gw: 0,
      gl: 0,
    }));
    for (const plan of this.context.plans) {
      if (plan.stage !== "roundrobin" || plan.round > throughWeek || !plan.entrants) continue;
      const outcome = this.completed.get(plan.index);
      if (!outcome) continue;
      const [a, b] = plan.entrants;
      rows[a]!.gw += outcome.score.p1;
      rows[a]!.gl += outcome.score.p2;
      rows[b]!.gw += outcome.score.p2;
      rows[b]!.gl += outcome.score.p1;
      if (outcome.winnerSide) {
        rows[outcome.winnerSide === "p1" ? a : b]!.w += 1;
        rows[outcome.winnerSide === "p1" ? b : a]!.l += 1;
      }
    }
    return rankedTable(rows);
  }

  adoptWindow(artifact: TradeWindowArtifact): void {
    const monById = new Map(this.context.board.mons.map((mon) => [mon.id, mon] as const));
    for (const stored of artifact.rosters) {
      const franchise = this.franchises[stored.entrant];
      if (!franchise)
        throw new Error(`transaction artifact names unknown entrant ${stored.entrant}`);
      franchise.roster = stored.roster.map(({ id }) => {
        const mon = monById.get(id);
        if (!mon) throw new Error(`transaction artifact names unknown board id ${id}`);
        return mon;
      });
      franchise.budget = stored.budget_left;
    }
    this.windowArtifacts.push(artifact);
    this.storeRosterVersion(this.windowArtifacts.length);
  }

  changedSeats(index: number): number[] {
    const before = this.rosterHistory[index];
    const after = this.rosterHistory[index + 1];
    if (!before || !after)
      throw new Error(`run ${this.context.runId} lacks roster history ${index}`);
    return this.context.entrants.flatMap((_, entrant) => {
      const ids = new Set(before[entrant]!.map((mon) => mon.id));
      const same =
        after[entrant]!.length === ids.size && after[entrant]!.every((mon) => ids.has(mon.id));
      return same ? [] : [entrant];
    });
  }

  swapsUsed(): number[] {
    return this.windowArtifacts.at(-1)?.swaps_used.slice() ?? this.context.entrants.map(() => 0);
  }
}
