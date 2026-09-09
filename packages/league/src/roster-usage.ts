import type { GameSummary } from "./game-usage.js";
import type { TeamBuildView } from "./views.js";

export interface RosterUsageWeek {
  week: number;
  opponent: number;
  owned: boolean;
  registered: boolean;
  broughtGames: number[];
}

export interface RosterUsageEntry {
  entrant: number;
  monId: string;
  weeks: RosterUsageWeek[];
}

export interface RosterUsageInput {
  rosters: ReadonlyArray<readonly string[]>;
  plans: ReadonlyArray<{ index: number; week: number; entrants: readonly [number, number] }>;
  builds: readonly TeamBuildView[];
  games: ReadonlyMap<number, readonly GameSummary[]>;
  throughWeek: number;
  owned?: (entrant: number, week: number, monId: string) => boolean;
}

export function rosterUsage(input: RosterUsageInput): RosterUsageEntry[] {
  const entries: RosterUsageEntry[] = [];
  const plans = [...input.plans]
    .filter((plan) => plan.week <= input.throughWeek && input.games.has(plan.index))
    .sort((a, b) => a.week - b.week || a.index - b.index);
  for (const [entrant, roster] of input.rosters.entries()) {
    for (const monId of roster) {
      const weeks: RosterUsageWeek[] = [];
      for (const plan of plans) {
        if (!plan.entrants.includes(entrant)) continue;
        const side = plan.entrants[0] === entrant ? 0 : 1;
        const opponent = plan.entrants[side === 0 ? 1 : 0];
        const build = input.builds.find(
          (view) => view.seriesIndex === plan.index && view.entrant === entrant,
        );
        const owned = input.owned?.(entrant, plan.week, monId) ?? true;
        weeks.push({
          week: plan.week,
          opponent,
          owned,
          registered: owned && (build?.brought.includes(monId) ?? false),
          broughtGames: (input.games.get(plan.index) ?? []).flatMap((game, index) =>
            game.brought[side].includes(monId) ? [index + 1] : [],
          ),
        });
      }
      entries.push({ entrant, monId, weeks });
    }
  }
  return entries;
}

export const ROSTER_USAGE_HEADING =
  "PUBLIC ROSTER USAGE (coach | board id | each completed week: opponent, whether it was in the registered six, games it was brought to):";

export function renderRosterUsage(
  entries: readonly RosterUsageEntry[],
  label: (entrant: number) => string,
): string[] {
  return entries.map((entry) => {
    const weeks = entry.weeks.map((week) => {
      const head = `week ${week.week} vs entrant ${week.opponent}:`;
      if (!week.owned) return `${head} not on roster`;
      if (!week.registered) return `${head} not registered`;
      const games = week.broughtGames.length
        ? `brought game${week.broughtGames.length === 1 ? "" : "s"} ${week.broughtGames.join(",")}`
        : "never brought";
      return `${head} registered, ${games}`;
    });
    return `- ${label(entry.entrant)} | ${entry.monId}: ${weeks.join("; ") || "no completed weeks"}`;
  });
}
