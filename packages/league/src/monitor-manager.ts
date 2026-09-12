import type { DraftBoard } from "./draft-protocol.js";
import type { FranchiseCheckpoint } from "./league-journal.js";
import type { RosterUsageEntry } from "./roster-usage.js";
import type { TradeWindowArtifact } from "./trade-window-protocol.js";
import type { JsonObject } from "./types.js";
import { count, text } from "./value.js";

export interface DraftHorizonStats {
  entrant: number;
  picks: number;
  withoutReason: number;
  namingAnotherCoach: number;
  namingTheSeason: number;
}

export interface RetentionRow {
  entrant: number;
  monId: string;
  ownedWeeks: number;
  registeredWeeks: number;
  broughtGames: number;
  droppedAfterWeek: number | null;
  namedInMemory: boolean;
}

export interface MemoryContinuity {
  entrant: number;
  stage: FranchiseCheckpoint["stage"];
  week: number;
  notebookChars: number;
  pages: number;
  totalChars: number;
  monsNamed: number;
  monsCarried: number;
  monsDropped: number;
}

const SEASON_WORDS =
  /\b(playoffs?|semi-?finals?|finals?|week \d|later weeks?|rest of the season|whole season|title|championship|schedule|remaining opponents?|every coach|the league)\b/i;

function coachNames(
  entrants: readonly string[],
  teamNames: readonly string[],
  own: number,
): string[] {
  const names: string[] = [];
  for (const [entrant, model] of entrants.entries()) {
    if (entrant === own || model === entrants[own]) continue;
    names.push(model, model.split(":").pop()!.split("/").pop()!);
    if (teamNames[entrant]) names.push(teamNames[entrant]!);
  }
  return names.filter((name) => name.length >= 4);
}

export function draftHorizonStats(
  picks: readonly JsonObject[],
  entrants: readonly string[],
  teamNames: readonly string[],
): DraftHorizonStats[] {
  return entrants.map((_, entrant) => {
    const own = picks.filter((pick) => count(pick.entrant) === entrant);
    const others = coachNames(entrants, teamNames, entrant).map((name) => name.toLowerCase());
    const stats: DraftHorizonStats = {
      entrant,
      picks: own.length,
      withoutReason: 0,
      namingAnotherCoach: 0,
      namingTheSeason: 0,
    };
    for (const pick of own) {
      const rationale = text(pick.rationale).trim();
      if (!rationale) {
        stats.withoutReason += 1;
        continue;
      }
      const lower = rationale.toLowerCase();
      if (others.some((name) => lower.includes(name))) stats.namingAnotherCoach += 1;
      if (SEASON_WORDS.test(rationale)) stats.namingTheSeason += 1;
    }
    return stats;
  });
}

function memoryText(memory: Readonly<Record<string, string>>): string {
  return Object.values(memory).join("\n").toLowerCase();
}

function monsNamedIn(board: DraftBoard, memory: Readonly<Record<string, string>>): Set<string> {
  const joined = memoryText(memory);
  const named = new Set<string>();
  for (const mon of board.mons) {
    const needles = [mon.name, mon.species, mon.forme ?? ""].filter((needle) => needle.length >= 4);
    if (needles.some((needle) => joined.includes(needle.toLowerCase()))) named.add(mon.id);
  }
  return named;
}

export function dropsByWindow(windows: readonly TradeWindowArtifact[]): Map<string, number> {
  const drops = new Map<string, number>();
  for (const window of windows) {
    for (const decision of window.decisions)
      for (const swap of decision.swaps)
        drops.set(`${decision.entrant}:${swap.drop}`, window.after_week);
    for (const offer of window.offers) {
      if (offer.accepted !== true || offer.to === null) continue;
      if (offer.give) drops.set(`${offer.from}:${offer.give}`, window.after_week);
      if (offer.get) drops.set(`${offer.to}:${offer.get}`, window.after_week);
    }
  }
  return drops;
}

export function retentionRows(
  usage: readonly RosterUsageEntry[],
  drops: ReadonlyMap<string, number>,
  latestMemory: ReadonlyArray<Readonly<Record<string, string>> | undefined>,
  board: DraftBoard,
): RetentionRow[] {
  const named = latestMemory.map((memory) =>
    memory ? monsNamedIn(board, memory) : new Set<string>(),
  );
  return usage
    .map((entry) => {
      const owned = entry.weeks.filter((week) => week.owned);
      return {
        entrant: entry.entrant,
        monId: entry.monId,
        ownedWeeks: owned.length,
        registeredWeeks: owned.filter((week) => week.registered).length,
        broughtGames: owned.reduce((sum, week) => sum + week.broughtGames.length, 0),
        droppedAfterWeek: drops.get(`${entry.entrant}:${entry.monId}`) ?? null,
        namedInMemory: named[entry.entrant]?.has(entry.monId) ?? false,
      };
    })
    .filter((row) => row.ownedWeeks >= 2 && row.registeredWeeks === 0);
}

export function memoryContinuity(
  checkpoints: readonly FranchiseCheckpoint[],
  board: DraftBoard,
): MemoryContinuity[] {
  const previous = new Map<number, Set<string>>();
  const ordered = [...checkpoints].sort(
    (a, b) => a.week - b.week || stageOrder(a.stage) - stageOrder(b.stage) || a.entrant - b.entrant,
  );
  return ordered.map((checkpoint) => {
    const named = monsNamedIn(board, checkpoint.memory);
    const before = previous.get(checkpoint.entrant) ?? new Set<string>();
    previous.set(checkpoint.entrant, named);
    const pages = Object.keys(checkpoint.memory);
    return {
      entrant: checkpoint.entrant,
      stage: checkpoint.stage,
      week: checkpoint.week,
      notebookChars: (checkpoint.memory.notebook ?? "").length,
      pages: pages.length,
      totalChars: pages.reduce((sum, page) => sum + checkpoint.memory[page]!.length, 0),
      monsNamed: named.size,
      monsCarried: [...before].filter((id) => named.has(id)).length,
      monsDropped: [...before].filter((id) => !named.has(id)).length,
    };
  });
}

function stageOrder(stage: FranchiseCheckpoint["stage"]): number {
  return stage === "draft" ? 0 : stage === "week" ? 1 : 2;
}
