import type { RosterPreset } from "./roster-preset.js";
import { seededRng, seriesEntropy } from "./random.js";
import type { ExperimentOptions } from "./series.js";
import { draftLeagueTopology, roundRobinWeeks } from "./draftleague-topology.js";
import type { TransactionSchedule } from "./trade-window.js";
import type { BracketMatch, TournamentEvent } from "./tournament.js";
import type { Pid } from "./types.js";
import type { DraftTableRow, DraftView } from "./views.js";

export type DraftLeagueEvent = TournamentEvent | { type: "draft"; draft: DraftView };

export interface DraftLeagueOptions extends ExperimentOptions {
  boardsDir?: string;
  board?: string;
  onEvent?: (event: DraftLeagueEvent) => void;
  throughWeek?: number;
  resume?: boolean;
  sequentialWeeks?: boolean;
  transactions?: TransactionSchedule | null;
  swapsAllowed?: number;
  draftOnly?: boolean;
  preset?: RosterPreset;
}

export interface DraftLeagueSeriesPlan {
  index: number;
  stage: "roundrobin" | "playoff";
  round: number;
  entrants: [number, number] | null;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
}

export function buildDraftPlayoffBracket(
  plans: readonly DraftLeagueSeriesPlan[],
  seeding: readonly number[],
): BracketMatch[][] {
  return plans.length === 3
    ? [
        [
          {
            round: 0,
            seriesIndex: plans[0]!.index,
            slots: [seeding[0]!, seeding[3]!],
            winner: null,
          },
          {
            round: 0,
            seriesIndex: plans[1]!.index,
            slots: [seeding[1]!, seeding[2]!],
            winner: null,
          },
        ],
        [{ round: 1, seriesIndex: plans[2]!.index, slots: [null, null], winner: null }],
      ]
    : [
        [
          {
            round: 0,
            seriesIndex: plans[0]!.index,
            slots: [seeding[0]!, seeding[1]!],
            winner: null,
          },
        ],
      ];
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
        stage: "roundrobin",
        round: week + 1,
        entrants: pair,
        ...seriesEntropy(seededRng(`${seed}:series:${plans.length}`)),
      });
    }
  }
  for (let series = 0; series < topology.playoffSeries; series += 1) {
    plans.push({
      index: plans.length,
      stage: "playoff",
      round: playoffRounds === 1 || series < 2 ? 1 : 2,
      entrants: null,
      ...seriesEntropy(seededRng(`${seed}:series:${plans.length}`)),
    });
  }
  return { weeks, playoffRounds, plans };
}

export function rankedTable(table: DraftTableRow[]): DraftTableRow[] {
  return [...table].sort(
    (a, b) => b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || b.gw - a.gw || a.entrant - b.entrant,
  );
}
