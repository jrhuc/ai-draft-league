import { displaySpecies } from "./format";
import type { Entrant, Match, TournamentBundle } from "./tournament";

/**
 * Pure selectors over a {@link TournamentBundle}. The bundle is the producer's
 * artifact; nothing here recalculates competitive facts, it only indexes and
 * projects what was released.
 */

export type ScheduledMatch = {
  match: Match;
  label: string;
  href: string;
};

const entrantMaps = new WeakMap<TournamentBundle, Map<string, Entrant>>();

function entrantMap(bundle: TournamentBundle): Map<string, Entrant> {
  let map = entrantMaps.get(bundle);
  if (!map) {
    map = new Map(bundle.entrants.map((entry) => [entry.id, entry]));
    entrantMaps.set(bundle, map);
  }
  return map;
}

export function entrant(bundle: TournamentBundle, id: string): Entrant {
  const found = entrantMap(bundle).get(id);
  if (!found) throw new Error(`unknown entrant ${id}`);
  return found;
}

export function entrantIndex(bundle: TournamentBundle, id: string): number {
  return bundle.entrants.findIndex((entry) => entry.id === id);
}

const monMaps = new WeakMap<TournamentBundle, Map<string, string>>();

function monMap(bundle: TournamentBundle): Map<string, string> {
  let map = monMaps.get(bundle);
  if (!map) {
    map = new Map(
      bundle.entrants.flatMap((entry) => entry.team.sets.map((set) => [set.id, set.species])),
    );
    monMaps.set(bundle, map);
  }
  return map;
}

export function monName(bundle: TournamentBundle, id: string): string {
  const species = monMap(bundle).get(id) ?? id;
  return displaySpecies(species);
}

export function roundLabel(bundle: TournamentBundle, roundIndex: number): string {
  const rounds = bundle.bracket.rounds.length;
  if (roundIndex === rounds - 1) return "Final";
  if (roundIndex === rounds - 2) return "Semifinal";
  if (roundIndex === rounds - 3) return "Quarterfinal";
  return `Round of ${2 ** (rounds - roundIndex)}`;
}

function scheduleMatches(bundle: TournamentBundle): ScheduledMatch[] {
  return bundle.bracket.rounds.flatMap((round, roundIndex) =>
    round.flatMap((slot) =>
      slot.match
        ? [
            {
              match: slot.match,
              label: roundLabel(bundle, roundIndex),
              href: `/matches/${slot.match.seriesId}`,
            },
          ]
        : [],
    ),
  );
}

const matchLists = new WeakMap<TournamentBundle, ScheduledMatch[]>();

export function allMatches(bundle: TournamentBundle): ScheduledMatch[] {
  let rows = matchLists.get(bundle);
  if (!rows) {
    rows = scheduleMatches(bundle);
    matchLists.set(bundle, rows);
  }
  return rows;
}

export function matchBySeries(bundle: TournamentBundle, seriesId: string): ScheduledMatch | null {
  return allMatches(bundle).find((row) => row.match.seriesId === seriesId) ?? null;
}

export type TapeStats = {
  games: number;
  decisions: number;
  reasoningTokens: number;
};

export function tapeStats(bundle: TournamentBundle): TapeStats {
  let games = 0;
  let decisions = 0;
  let reasoningTokens = 0;
  for (const replay of Object.values(bundle.replays)) {
    games += replay.games.length;
    for (const game of replay.games) {
      decisions += game.decisions.length;
      for (const decision of game.decisions) {
        reasoningTokens += decision.reasoningTokens ?? 0;
      }
    }
  }
  return { games, decisions, reasoningTokens };
}

export type EntrantStats = {
  entrantId: string;
  latencyMs: number | null;
  reasoningTokens: number | null;
  protectRate: number;
  switchRate: number;
};

export function entrantStats(bundle: TournamentBundle): EntrantStats[] {
  type StatRow = {
    lat: number[];
    tok: number[];
    turns: number;
    protects: number;
    switches: number;
  };
  const rows = new Map<string, StatRow>(
    bundle.entrants.map((entry) => [
      entry.id,
      { lat: [], tok: [], turns: 0, protects: 0, switches: 0 },
    ]),
  );
  for (const replay of Object.values(bundle.replays)) {
    for (const game of replay.games) {
      for (const decision of game.decisions) {
        const row = rows.get(decision.entrantId);
        if (!row || decision.automatic) continue;
        if (decision.latencyMs !== null) row.lat.push(decision.latencyMs);
        if (decision.reasoningTokens !== null) row.tok.push(decision.reasoningTokens);
        if (decision.phase !== "turn") continue;
        row.turns += 1;
        if (decision.selection.some((choice) => choice.startsWith("Protect"))) row.protects += 1;
        if (decision.selection.some((choice) => choice.startsWith("Switch to"))) row.switches += 1;
      }
    }
  }
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return bundle.entrants.map((entry) => {
    const row = rows.get(entry.id)!;
    return {
      entrantId: entry.id,
      latencyMs: mean(row.lat),
      reasoningTokens: mean(row.tok),
      protectRate: row.turns ? row.protects / row.turns : 0,
      switchRate: row.turns ? row.switches / row.turns : 0,
    };
  });
}
