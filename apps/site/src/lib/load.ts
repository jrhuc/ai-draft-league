import type { Franchise, Match, SeasonBundle, Week } from "./season";

/**
 * Pure selectors over a {@link SeasonBundle}. The bundle is the producer's
 * artifact; nothing here recalculates competitive facts, it only indexes and
 * projects what was released.
 */

export type ScheduledMatch = {
  match: Match;
  week: Week | null;
  label: string;
  href: string | null;
};

const franchiseMaps = new WeakMap<SeasonBundle, Map<string, Franchise>>();

function franchiseMap(season: SeasonBundle): Map<string, Franchise> {
  let map = franchiseMaps.get(season);
  if (!map) {
    map = new Map(season.franchises.map((franchise) => [franchise.id, franchise]));
    franchiseMaps.set(season, map);
  }
  return map;
}

export function franchise(season: SeasonBundle, id: string): Franchise {
  const found = franchiseMap(season).get(id);
  if (!found) throw new Error(`unknown franchise ${id}`);
  return found;
}

const boardMaps = new WeakMap<SeasonBundle, Map<string, string>>();

function boardMap(season: SeasonBundle): Map<string, string> {
  let map = boardMaps.get(season);
  if (!map) {
    map = new Map(season.board.map((mon) => [mon.id, mon.name]));
    boardMaps.set(season, map);
  }
  return map;
}

export function monName(season: SeasonBundle, id: string): string {
  return boardMap(season).get(id) ?? id;
}

export function franchiseName(season: SeasonBundle, id: string | null): string {
  return id === null ? "—" : (franchiseMap(season).get(id)?.name ?? id);
}

export function franchiseIndex(season: SeasonBundle, id: string): number {
  return season.franchises.findIndex((entry) => entry.id === id);
}

function scheduleMatches(season: SeasonBundle): ScheduledMatch[] {
  const rows: ScheduledMatch[] = [];
  for (const week of season.weeks) {
    for (const match of week.matches) {
      rows.push({
        match,
        week,
        label: `Week ${week.number}`,
        href: match.seriesId ? `/matches/${match.seriesId}` : null,
      });
    }
  }
  for (const round of season.playoffs?.rounds ?? []) {
    for (const slot of round) {
      if (!slot.match) continue;
      rows.push({
        match: slot.match,
        week: null,
        label: playoffRoundLabel(season, slot.round),
        href: slot.match.seriesId ? `/matches/${slot.match.seriesId}` : null,
      });
    }
  }
  return rows;
}

const matchLists = new WeakMap<SeasonBundle, ScheduledMatch[]>();

export function allMatches(season: SeasonBundle): ScheduledMatch[] {
  let rows = matchLists.get(season);
  if (!rows) {
    rows = scheduleMatches(season);
    matchLists.set(season, rows);
  }
  return rows;
}

export function playoffRoundLabel(season: SeasonBundle, round: number): string {
  if (round === season.season.playoffRounds) return "Final";
  return round === season.season.playoffRounds - 1 ? "Semifinal" : `Playoff round ${round}`;
}

export function matchBySeries(season: SeasonBundle, seriesId: string): ScheduledMatch | null {
  return allMatches(season).find((row) => row.match.seriesId === seriesId) ?? null;
}

export function matchesFor(season: SeasonBundle, franchiseId: string): ScheduledMatch[] {
  return allMatches(season).filter((row) => row.match.franchises.includes(franchiseId));
}
