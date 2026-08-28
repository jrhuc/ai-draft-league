import { z } from "zod";

import type { DraftBoardMon } from "./draft.js";
import type { TeamBuildView } from "./views.js";
import { readCompletedSeriesDecisionRows, readCompletedSeriesGameLogs } from "./series.js";
import { isErrnoCode } from "./value.js";

/** What a completed game proves about each side, with every species named by drafted board id.
 * This is the only place battle-log species names are joined to draft ids; consumers select
 * from it instead of re-parsing logs or fuzzy-matching names. */
export interface GameSummary {
  /** The four board ids each side picked at team preview, lead pair first. A game ending before
   * a pick could reveal every member never names the unrevealed ones in its log, so this comes
   * from the recorded preview decision and only falls back to {@link GameSummary.fielded}. */
  brought: [string[], string[]];
  /** Board ids each side actually sent out, in entry order. */
  fielded: [string[], string[]];
  /** Board id of the Pokémon each side Mega Evolved, when it did. */
  megaEvolved: [string | null, string | null];
  /** Faint counts per board id. */
  faints: [Record<string, number>, Record<string, number>];
}

type Side = 0 | 1;

/** The six each side registered, in entrant order; an absent build leaves that side unresolved. */
type RegisteredBuilds = readonly [TeamBuildView | undefined, TeamBuildView | undefined];
type DraftMon = Pick<DraftBoardMon, "id" | "species" | "forme">;

interface Entry {
  name: string;
  id: string | null;
}

const acceptedTeamPreviewRow = z.looseObject({
  kind: z.literal("decision"),
  phase: z.literal("team_preview"),
  outcome: z.literal("accepted"),
  game_number: z.number().int().positive(),
  action: z.string(),
});

function sideOf(ident: string): Side | undefined {
  return ident.startsWith("p1") ? 0 : ident.startsWith("p2") ? 1 : undefined;
}

function logSpecies(details: string): string {
  return details.split(",", 1)[0]!.trim();
}
function nickname(ident: string): string {
  return ident.replace(/^p[12][a-z]?:\s*/u, "").toLowerCase();
}

function pickedTeam(action: string | undefined, registered: readonly DraftMon[]): string[] | null {
  if (!action) return null;
  const slots = action.replace(/\D+/gu, "").split("").map(Number);
  if (!slots.length) return null;
  const ids = slots.map((slot) => registered[slot - 1]?.id);
  const picked = ids.filter((id): id is string => id !== undefined);
  if (picked.length !== slots.length || new Set(picked).size !== picked.length) return null;
  return picked;
}

/**
 * Parses each completed game of a series into a {@link GameSummary}.
 *
 * Species names resolve exactly against the registered mons' Showdown `species`/`forme` names.
 * A Mega Evolving mon logs its plain species until it transforms, so an entry whose species two
 * registered candidates share (the base forme and its Mega both drafted) stays open until a
 * `-mega` event names it, then falls back to the base forme if neither happened.
 */
function gameSummaries(
  games: readonly (readonly string[])[],
  mons: readonly Pick<DraftBoardMon, "id" | "species" | "forme">[],
  builds: RegisteredBuilds,
  teamPicks: ReadonlyArray<readonly [string | undefined, string | undefined]> = [],
): GameSummary[] {
  const byName = new Map<string, DraftMon[]>();
  const byId = new Map(mons.map((mon) => [mon.id, mon] as const));
  const registeredMons = (build: TeamBuildView | undefined): DraftMon[] =>
    (build?.brought ?? []).flatMap((id) => {
      const mon = byId.get(id);
      return mon ? [mon] : [];
    });
  const registered: [DraftMon[], DraftMon[]] = [
    registeredMons(builds[0]),
    registeredMons(builds[1]),
  ];
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

  return games.map((lines, gameIndex) => {
    const order: [Entry[], Entry[]] = [[], []];
    const entries = new Map<string, Entry>();
    const slot = new Map<string, Entry>();
    const pendingMega: [Set<string>, Set<string>] = [new Set(), new Set()];
    const megaEvolved: [string | null, string | null] = [null, null];
    const faintEvents: Array<[Side, Entry]> = [];

    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      const [, kind = "", ...args] = line.split("|");
      const ident = args[0] ?? "";
      const side = sideOf(ident);
      if (side === undefined) continue;
      if (kind === "switch" || kind === "drag" || kind === "replace") {
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
      } else if ((kind === "detailschange" || kind === "-detailschange") && args[1]) {
        const slotId = ident.slice(0, 3);
        const resolved = resolve(side, logSpecies(args[1]));
        const entry = slot.get(slotId);
        if (resolved === null || resolved === undefined) continue;
        if (pendingMega[side].delete(slotId)) megaEvolved[side] = resolved;
        if (entry) entry.id = resolved;
      } else if (kind === "-mega" && args[1]) {
        const slotId = ident.slice(0, 3);
        const resolved = resolve(side, logSpecies(args[1]));
        const entry = slot.get(slotId);
        if (resolved !== null && resolved !== undefined) {
          megaEvolved[side] = resolved;
          if (entry) entry.id = resolved;
        } else {
          pendingMega[side].add(slotId);
        }
      } else if (kind === "faint") {
        const entry = slot.get(ident.slice(0, 3));
        if (entry) faintEvents.push([side, entry]);
      }
    }

    for (const side of [0, 1] as const) {
      for (const entry of order[side]) {
        if (entry.id !== null) continue;
        const candidates = (byName.get(entry.name) ?? []).filter((mon) =>
          registered[side].includes(mon),
        );
        entry.id =
          (candidates.find((mon) => !mon.forme || mon.forme === mon.species) ?? candidates[0])
            ?.id ?? null;
      }
    }

    const faints: [Record<string, number>, Record<string, number>] = [{}, {}];
    for (const [side, entry] of faintEvents) {
      if (!entry.id) continue;
      faints[side][entry.id] = (faints[side][entry.id] ?? 0) + 1;
    }
    const fielded: [string[], string[]] = [
      [...new Set(order[0].flatMap((entry) => (entry.id ? [entry.id] : [])))],
      [...new Set(order[1].flatMap((entry) => (entry.id ? [entry.id] : [])))],
    ];
    return {
      brought: [
        pickedTeam(teamPicks[gameIndex]?.[0], registered[0]) ?? fielded[0],
        pickedTeam(teamPicks[gameIndex]?.[1], registered[1]) ?? fielded[1],
      ],
      fielded,
      megaEvolved,
      faints,
    };
  });
}

/** Reads every completed game of one recorded series, or an empty list when none exists yet. */
export function seriesGameSummaries(
  seriesDir: string,
  seriesId: string,
  mons: readonly Pick<DraftBoardMon, "id" | "species" | "forme">[],
  builds: RegisteredBuilds,
): GameSummary[] {
  try {
    const logs = readCompletedSeriesGameLogs(seriesDir, seriesId);
    const teamPicks: Array<[string | undefined, string | undefined]> = logs.map(() => [
      undefined,
      undefined,
    ]);
    for (const [side, pid] of [
      [0, "p1"],
      [1, "p2"],
    ] as const) {
      for (const row of readCompletedSeriesDecisionRows(seriesDir, seriesId, pid)) {
        const preview = acceptedTeamPreviewRow.safeParse(row);
        if (!preview.success || preview.data.game_number > teamPicks.length) continue;
        teamPicks[preview.data.game_number - 1]![side] = preview.data.action;
      }
    }
    return gameSummaries(logs, mons, builds, teamPicks);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT") && "path" in cause && cause.path === seriesDir) return [];
    throw cause;
  }
}
