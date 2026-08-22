import type { DraftBoardMon } from './draft.js';
import type { TeambuildView } from './gui/api.js';
import { readCompletedSeriesGameLogs } from './series.js';

/** What a completed game proves about each side, with every species named by drafted board id.
 * This is the only place battle-log species names are joined to draft ids; consumers select
 * from it instead of re-parsing logs or fuzzy-matching names. */
export interface GameSummary {
  /** Board ids each side sent out, in entry order. */
  brought: [string[], string[]];
  /** Board id of the Pokémon each side Mega Evolved, when it did. */
  megaEvolved: [string | null, string | null];
  /** Faint counts per board id. */
  faints: [Record<string, number>, Record<string, number>];
}

type Side = 0 | 1;

/** The six each side registered, in entrant order; an absent build leaves that side unresolved. */
type RegisteredBuilds = readonly [TeambuildView | undefined, TeambuildView | undefined];

interface Entry {
  name: string;
  id: string | null;
}

function sideOf(ident: string): Side | undefined {
  return ident.startsWith('p1') ? 0 : ident.startsWith('p2') ? 1 : undefined;
}

function logSpecies(details: string): string {
  return details.split(',', 1)[0]!.trim();
}
function nickname(ident: string): string {
  return ident.replace(/^p[12][a-z]?:\s*/u, '').toLowerCase();
}

/**
 * Parses each completed game of a series into a {@link GameSummary}.
 *
 * Species names resolve exactly against the registered mons' Showdown `species`/`forme` names.
 * A Mega Evolving mon logs its plain species until it transforms, so an entry whose species two
 * registered candidates share (the base forme and its Mega both drafted) stays open until a
 * `-mega` event names it, then falls back to the base forme if neither happened.
 */
export function gameSummaries(
  games: readonly (readonly string[])[],
  mons: readonly Pick<DraftBoardMon, 'id' | 'species' | 'forme'>[],
  builds: RegisteredBuilds,
): GameSummary[] {
  const byName = new Map<string, DraftBoardMon[]>();
  const byId = new Map(mons.map((mon) => [mon.id, mon] as const));
  const registered = builds.map((build) =>
    (build?.brought ?? []).flatMap((id) => {
      const mon = byId.get(id);
      return mon ? [mon] : [];
    }),
  ) as [DraftBoardMon[], DraftBoardMon[]];
  for (const sideMons of new Set([...registered[0], ...registered[1]])) {
    for (const name of sideMons.forme && sideMons.forme !== sideMons.species
      ? [sideMons.species, sideMons.forme]
      : [sideMons.species]) {
      const known = byName.get(name) ?? [];
      if (!known.some((candidate) => candidate.id === sideMons.id)) known.push(sideMons);
      byName.set(name, known);
    }
  }
  /** Null means several registered candidates share the species; undefined means none does. */
  const resolve = (side: Side, name: string): string | null | undefined => {
    const candidates = (byName.get(name) ?? []).filter((mon) => registered[side].includes(mon));
    if (!candidates.length) return undefined;
    if (candidates.length === 1) return candidates[0]!.id;
    return null;
  };

  return games.map((lines) => {
    const order: [Entry[], Entry[]] = [[], []];
    const entries = new Map<string, Entry>();
    const slot = new Map<string, Entry>();
    const pendingMega: [Set<string>, Set<string>] = [new Set(), new Set()];
    const megaEvolved: [string | null, string | null] = [null, null];
    const faintEvents: Array<[Side, Entry]> = [];

    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      const [, kind = '', ...args] = line.split('|');
      const ident = args[0] ?? '';
      const side = sideOf(ident);
      if (side === undefined) continue;
      if (kind === 'switch' || kind === 'drag' || kind === 'replace') {
        if (!args[1]) continue;
        const key = `${side}:${nickname(ident)}`;
        let entry = entries.get(key);
        if (!entry) {
          const name = logSpecies(args[1]);
          entry = { name, id: resolve(side, name) ?? null };
          entries.set(key, entry);
          order[side].push(entry);
        }
        slot.set(ident.slice(0, 3), entry);
      } else if ((kind === 'detailschange' || kind === '-detailschange') && args[1]) {
        const slotId = ident.slice(0, 3);
        const resolved = resolve(side, logSpecies(args[1]));
        const entry = slot.get(slotId);
        if (typeof resolved !== 'string') continue;
        if (pendingMega[side].delete(slotId)) megaEvolved[side] = resolved;
        if (entry) entry.id = resolved;
      } else if (kind === '-mega' && args[1]) {
        const slotId = ident.slice(0, 3);
        const resolved = resolve(side, logSpecies(args[1]));
        const entry = slot.get(slotId);
        if (typeof resolved === 'string') {
          megaEvolved[side] = resolved;
          if (entry) entry.id = resolved;
        } else {
          pendingMega[side].add(slotId);
        }
      } else if (kind === 'faint') {
        const entry = slot.get(ident.slice(0, 3));
        if (entry) faintEvents.push([side, entry]);
      }
    }

    for (const side of [0, 1] as const) {
      for (const entry of order[side]) {
        if (entry.id !== null) continue;
        const candidates = (byName.get(entry.name) ?? []).filter((mon) => registered[side].includes(mon));
        entry.id = (candidates.find((mon) => !mon.forme || mon.forme === mon.species) ?? candidates[0])?.id ?? null;
      }
    }

    const faints: [Record<string, number>, Record<string, number>] = [{}, {}];
    for (const [side, entry] of faintEvents) {
      if (!entry.id) continue;
      faints[side][entry.id] = (faints[side][entry.id] ?? 0) + 1;
    }
    return {
      brought: [
        [...new Set(order[0].flatMap((entry) => (entry.id ? [entry.id] : [])))],
        [...new Set(order[1].flatMap((entry) => (entry.id ? [entry.id] : [])))],
      ],
      megaEvolved,
      faints,
    };
  });
}

/** Reads every completed game of one recorded series, or an empty list when none exists yet. */
export function seriesGameSummaries(
  seriesDir: string,
  seriesId: string,
  mons: readonly Pick<DraftBoardMon, 'id' | 'species' | 'forme'>[],
  builds: RegisteredBuilds,
): GameSummary[] {
  try {
    return readCompletedSeriesGameLogs(seriesDir, seriesId).map((lines) => gameSummaries([lines], mons, builds)[0]!);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT' && error.path === seriesDir) return [];
    throw cause;
  }
}
