import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Franchise, Match, SeasonBundle, Week } from "./season";

export const season: SeasonBundle = JSON.parse(readFileSync(join(process.cwd(), "public/season-bundle.json"), "utf8"));

const franchiseMap = new Map(season.franchises.map((franchise) => [franchise.id, franchise]));

export function franchise(id: string): Franchise {
  const found = franchiseMap.get(id);
  if (!found) throw new Error(`unknown franchise ${id}`);
  return found;
}

const boardMap = new Map(season.board.map((mon) => [mon.id, mon.name]));

export function monName(id: string): string {
  return boardMap.get(id) ?? id;
}

export function franchiseName(id: string | null): string {
  return id === null ? "—" : (franchiseMap.get(id)?.name ?? id);
}

export function franchiseIndex(id: string): number {
  return season.franchises.findIndex((entry) => entry.id === id);
}

export type ScheduledMatch = { match: Match; week: Week | null; label: string; href: string | null };

function scheduleMatches(): ScheduledMatch[] {
  const rows: ScheduledMatch[] = [];
  for (const week of season.weeks) {
    for (const match of week.matches) {
      rows.push({ match, week, label: `Week ${week.number}`, href: match.seriesId ? `/matches/${match.seriesId}/` : null });
    }
  }
  for (const round of season.playoffs?.rounds ?? []) {
    for (const slot of round) {
      if (!slot.match) continue;
      rows.push({
        match: slot.match,
        week: null,
        label: playoffRoundLabel(slot.round),
        href: slot.match.seriesId ? `/matches/${slot.match.seriesId}/` : null,
      });
    }
  }
  return rows;
}

const MATCHES = scheduleMatches();

export function allMatches(): ScheduledMatch[] {
  return MATCHES;
}

export function playoffRoundLabel(round: number): string {
  if (round === season.season.playoffRounds) return "Final";
  return round === season.season.playoffRounds - 1 ? "Semifinal" : `Playoff round ${round}`;
}

export function matchBySeries(seriesId: string): ScheduledMatch | null {
  return allMatches().find((row) => row.match.seriesId === seriesId) ?? null;
}

export function matchesFor(franchiseId: string): ScheduledMatch[] {
  return allMatches().filter((row) => row.match.franchises.includes(franchiseId));
}

export function releasedSeriesIds(): string[] {
  return allMatches()
    .map((row) => row.match.seriesId)
    .filter((id): id is string => id !== null && season.replays[id] !== undefined);
}
