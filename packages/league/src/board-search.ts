import { z } from "zod";
import type { Dex } from "pokemon-showdown";

import type { DraftBoard, DraftBoardMon } from "./draft-protocol.js";
import { loadShowdown, type ShowdownApi } from "./showdown.js";
import type { JsonObject, ToolDefinition } from "./types.js";

const searchSchema = z.strictObject({
  types: z
    .array(z.string())
    .default([])
    .describe('Every listed type must occur on the same form. ["Fire","Flying"] requires both.'),
  max_cost: z.number().int().optional(),
  min_cost: z.number().int().optional(),
  learns: z.string().optional().describe("Move legally learned in this format."),
  ability: z.string().optional().describe("Ability in any slot of the base or Mega form."),
  min_bst: z.number().int().optional().describe("Minimum base stat total of the matching form."),
  sort: z
    .enum(["cost", "bst", "name"])
    .default("cost")
    .describe("cost: high to low; bst: highest matching form first; name: A to Z."),
  limit: z.number().int().min(1).max(100).default(40),
  include_unavailable: z
    .boolean()
    .default(false)
    .describe("During the draft, include entries that are not legal picks for you."),
});

export const BOARD_COLUMNS =
  "id | cost | name | types | HP/Atk/Def/SpA/SpD/Spe | abilities; Mega entries show base -> Mega";

export const BOARD_SEARCH_TOOL: ToolDefinition = {
  name: "search_board",
  description:
    "Filter and sort the board. During the draft, defaults to your currently legal picks; otherwise searches the full board. " +
    "Mega entries show both forms; their stone is required in either form. Type, ability, stat and move filters must match together on one form.",
  parameters: z.record(z.string(), z.json()).parse(z.toJSONSchema(searchSchema, { io: "input" })),
};

export interface BoardSearch {
  definition: ToolDefinition;
  run(args: JsonObject): string;
}

export function baseCostsBySpecies(mons: readonly DraftBoardMon[]): Map<string, number> {
  return new Map(mons.filter((mon) => !mon.item).map((mon) => [mon.species, mon.cost]));
}

function boardForms(mon: DraftBoardMon, dex: ShowdownApi["Dex"]): Dex.Species[] {
  return [mon.species, ...(mon.forme ? [mon.forme] : [])].map((name) => dex.species.get(name));
}

function formSummary(species: Dex.Species): string {
  const stats = species.baseStats;
  return (
    `${species.types.join("/")} | ` +
    `${stats.hp}/${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe} | ` +
    Object.values(species.abilities).join("/")
  );
}

export function boardRow(
  mon: DraftBoardMon,
  dex: ShowdownApi["Dex"],
  baseCosts?: ReadonlyMap<string, number>,
): string {
  const baseCost = mon.item ? baseCosts?.get(mon.species) : undefined;
  const forms = boardForms(mon, dex);
  const details = forms
    .map((species, index) =>
      mon.forme
        ? `${index === 0 ? "base" : "Mega"} ${species.name}: ${formSummary(species)}`
        : formSummary(species),
    )
    .join(" -> ");
  return (
    `- ${mon.id} | ${mon.cost} | ${mon.name} | ${details}` +
    (mon.item ? ` | locked item: ${mon.item}` : "") +
    (baseCost === undefined ? "" : ` | base ${mon.species} costs ${baseCost}`)
  );
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function createBoardSearch(
  board: DraftBoard,
  psDir: string,
  legal?: readonly DraftBoardMon[],
): BoardSearch {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(board.format).mod || "base");
  const baseCosts = baseCostsBySpecies(board.mons);
  const movePools = new Map<string, Set<string>>();
  const movePool = (species: Dex.Species): Set<string> => {
    let pool = movePools.get(species.id);
    if (!pool) {
      pool = new Set(dex.species.getMovePool(species.id));
      movePools.set(species.id, pool);
    }
    return pool;
  };

  return {
    definition: BOARD_SEARCH_TOOL,
    run(args: JsonObject): string {
      const parsed = searchSchema.safeParse(args);
      if (!parsed.success) return z.prettifyError(parsed.error);
      const {
        types,
        max_cost,
        min_cost,
        min_bst,
        learns,
        ability,
        sort,
        limit,
        include_unavailable,
      } = parsed.data;
      const pool = include_unavailable ? board.mons : (legal ?? board.mons);
      const scope = legal && !include_unavailable ? "legal picks" : "full board";

      let move = "";
      if (learns) {
        const resolved = dex.moves.get(learns);
        if (!resolved.exists)
          return `No move data for ${JSON.stringify(learns)} in ${board.format}.`;
        move = resolved.id;
      }
      let abilityName = "";
      if (ability) {
        const resolved = dex.abilities.get(ability);
        if (!resolved.exists)
          return `No ability data for ${JSON.stringify(ability)} in ${board.format}.`;
        abilityName = resolved.name;
      }

      const matched = pool.flatMap((mon) => {
        if (max_cost !== undefined && mon.cost > max_cost) return [];
        if (min_cost !== undefined && mon.cost < min_cost) return [];
        const forms = boardForms(mon, dex).filter(
          (species) =>
            types.every((type) =>
              species.types.some((own) => normalize(own) === normalize(type)),
            ) &&
            (min_bst === undefined || species.bst >= min_bst) &&
            (!abilityName || Object.values(species.abilities).includes(abilityName)) &&
            (!move || movePool(species).has(move)),
        );
        return forms.length
          ? [{ mon, forms, bst: Math.max(...forms.map((form) => form.bst)) }]
          : [];
      });

      matched.sort((a, b) => {
        if (sort === "name") return a.mon.name.localeCompare(b.mon.name);
        if (sort === "bst" && a.bst !== b.bst) return b.bst - a.bst;
        return b.mon.cost - a.mon.cost || a.mon.name.localeCompare(b.mon.name);
      });

      if (!matched.length) return `No board entries match those filters (${scope}).`;
      const shown = matched.slice(0, limit);
      const heading =
        `Board search: ${matched.length} match${matched.length === 1 ? "" : "es"}` +
        (matched.length > shown.length
          ? `, showing the first ${shown.length} by ${sort}`
          : ` sorted by ${sort}`) +
        ` (${scope}; ${BOARD_COLUMNS}):`;
      const formFilter = types.length || abilityName || min_bst !== undefined || move;
      return [
        heading,
        ...shown.map(({ mon, forms }) => {
          const row = boardRow(mon, dex, baseCosts);
          return mon.forme && formFilter
            ? `${row} | matches: ${forms.map((form) => form.name).join(", ")}`
            : row;
        }),
      ].join("\n");
    },
  };
}
