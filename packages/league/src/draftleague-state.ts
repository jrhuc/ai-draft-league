import type { DraftBoard, DraftBoardMon } from "./draft.js";
import type { DraftLeagueOptions, DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { rankedTable } from "./draftleague-protocol.js";
import type { FranchiseMemory } from "./franchise-memory.js";
import type { StoredLeague, StoredLeagueRows } from "./league-store.js";
import type { Rng } from "./random.js";
import type { SeriesRecord } from "./records.js";
import type { BracketMatch } from "./tournament.js";
import type { TradeWindowArtifact, TransactionSchedule } from "./trade-window.js";
import type { Pid, TimerScale } from "./types.js";
import type { DraftTableRow, DraftView, TeambuildView } from "./views.js";

export type LeagueRunState =
  | { phase: "draft"; completedPicks: number }
  | { phase: "roundrobin"; week: number; rosterVersion: number }
  | { phase: "window"; week: number; rosterVersion: number }
  | { phase: "playoffs"; round: number }
  | { phase: "done"; champion: number };

export interface StoredSeriesOutcome {
  score: Record<Pid, number>;
  winnerSide: Pid | undefined;
}

export interface DraftLeagueContext {
  models: string[];
  runDir: string;
  options: DraftLeagueOptions;
  psDir: string;
  board: DraftBoard;
  seed: number;
  timerScale: TimerScale;
  random: Rng;
  psCommit: string;
  stored: StoredLeague | undefined;
  storedSchedule: TransactionSchedule | undefined;
  entrants: string[];
  weeks: Array<Array<[number, number]>>;
  playoffRounds: number;
  plans: DraftLeagueSeriesPlan[];
  schedule: TransactionSchedule;
  swapsAllowed: number;
  configuredTransactions: Array<{ after_week: number; trades_allowed: number }>;
  sequentialWeeks: boolean;
  reviewWeeks: number[];
  runId: string;
  storedRows: StoredLeagueRows;
  draftOnly: boolean;
}

function emptyTable(entrants: number): DraftTableRow[] {
  return Array.from({ length: entrants }, (_, entrant) => ({
    entrant,
    w: 0,
    l: 0,
    gw: 0,
    gl: 0,
  }));
}

export class DraftLeagueRuntime {
  readonly context: DraftLeagueContext;
  progress: LeagueRunState;
  readonly completed = new Map<number, SeriesRecord>();
  readonly storedOutcomes = new Map<number, StoredSeriesOutcome>();
  readonly table: DraftTableRow[];
  readonly teambuilds: TeambuildView[] = [];
  readonly resultSummaries: Array<Map<number, string>>;
  readonly windowArtifacts: TradeWindowArtifact[] = [];
  readonly rosterHistory: DraftBoardMon[][][] = [];
  readonly reconciled = new Set<number>();
  readonly results: SeriesRecord[] = [];
  memories: FranchiseMemory[];
  draftNotes: string[];
  rosters: DraftBoardMon[][];
  budgets: number[];
  teamNames: string[];
  picks: DraftView["picks"];
  readonly playoffContext: Array<Map<number, string>>;
  readonly reflectionNotes: Array<Map<number, string>>;
  reviewedThrough = 0;
  playoffBracketRounds: BracketMatch[][] | undefined;

  constructor(
    context: DraftLeagueContext,
    memories: FranchiseMemory[],
    playoffContext: Array<Map<number, string>>,
    reflectionNotes: Array<Map<number, string>>,
    picks: DraftView["picks"],
  ) {
    const entrants = context.entrants.length;
    this.context = context;
    this.progress = { phase: "draft", completedPicks: picks.length };
    this.table = emptyTable(entrants);
    this.resultSummaries = Array.from({ length: entrants }, () => new Map());
    this.memories = memories;
    this.draftNotes = Array.from({ length: entrants }, () => "");
    this.rosters = Array.from({ length: entrants }, () => []);
    this.budgets = Array.from({ length: entrants }, () => context.board.budget);
    this.teamNames = Array.from({ length: entrants }, () => "");
    this.picks = picks;
    this.playoffContext = playoffContext;
    this.reflectionNotes = reflectionNotes;
  }

  get week(): number {
    return this.progress.phase === "roundrobin" || this.progress.phase === "window"
      ? this.progress.week
      : this.progress.phase === "playoffs"
        ? this.progress.round
        : 0;
  }

  draftView(withTable: boolean): DraftView {
    const { board, entrants, weeks } = this.context;
    return {
      boardId: board.id,
      budget: board.budget,
      picksPerEntrant: board.picks,
      entrants: [...entrants],
      teamNames: [...this.teamNames],
      picks: [...this.picks],
      rosters: this.rosters.map((roster) => roster.map((mon) => mon.id)),
      budgets: [...this.budgets],
      table: withTable ? rankedTable(this.table) : null,
      teambuilds: [...this.teambuilds],
      week: this.week,
      weeks: weeks.length,
      phase: this.progress.phase,
    };
  }

  outcomeFor(plan: DraftLeagueSeriesPlan): StoredSeriesOutcome {
    const outcome = this.storedOutcomes.get(plan.index);
    if (!outcome) {
      throw new Error(`run ${this.context.runId} series ${plan.index} lacks a validated outcome`);
    }
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

  standingsThrough(afterWeek: number): DraftTableRow[] {
    const rows = emptyTable(this.context.entrants.length);
    for (const plan of this.context.plans) {
      if (plan.stage !== "roundrobin" || plan.round > afterWeek || !plan.entrants) continue;
      if (!this.completed.has(plan.index)) continue;
      const { score, winnerSide } = this.outcomeFor(plan);
      const [a, b] = plan.entrants;
      rows[a]!.gw += score.p1;
      rows[a]!.gl += score.p2;
      rows[b]!.gw += score.p2;
      rows[b]!.gl += score.p1;
      if (winnerSide) {
        rows[winnerSide === "p1" ? a : b]!.w += 1;
        rows[winnerSide === "p1" ? b : a]!.l += 1;
      }
    }
    return rankedTable(rows);
  }

  adoptWindow(artifact: TradeWindowArtifact): void {
    const monById = new Map(this.context.board.mons.map((mon) => [mon.id, mon] as const));
    this.rosters = artifact.rosters.map(({ roster }) =>
      roster.map(({ id }) => {
        const mon = monById.get(id);
        if (!mon) throw new Error(`transaction artifact names unknown board id ${id}`);
        return mon;
      }),
    );
    this.budgets = artifact.rosters.map(({ budget_left }) => budget_left);
    this.windowArtifacts.push(artifact);
    this.rosterHistory.push(this.rosters.map((roster) => [...roster]));
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
    return this.windowArtifacts.at(-1)?.swaps_used?.slice() ?? this.context.entrants.map(() => 0);
  }
}

export function sortedSeries(rows: SeriesRecord[]): SeriesRecord[] {
  return [...rows].sort((a, b) => Number(a.series_index) - Number(b.series_index));
}
