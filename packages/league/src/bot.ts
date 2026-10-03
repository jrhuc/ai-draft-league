import fs from "node:fs";
import path from "node:path";

import type { DraftBoardMon, DraftState } from "./draft-protocol.js";
import { TEAMS_DIR } from "./paths.js";
import { type Rng, seededRng } from "./random.js";
import { loadShowdown } from "./showdown.js";
import type { RawSet, StatSpread } from "./teambuild-protocol.js";
import { type DexLike, legalItems, legalMoves } from "./teambuild-validation.js";
import { loadPool } from "./teams.js";

type ShowdownSet = NonNullable<
  ReturnType<ReturnType<typeof loadShowdown>["Teams"]["unpack"]>
>[number];

type GeneratorSeed = `${number},${number},${number},${number}`;

interface SetGenerator {
  randomDoublesSets: Record<string, { level: number }>;
  setSeed(seed: GeneratorSeed): void;
  randomSet(
    species: string,
    teamDetails: Record<string, number>,
    isLead: boolean,
    isDoubles: boolean,
  ): { moves: string[]; ability: string; item: string };
}

const CORE_PICKS = 6;
const CORE_FLOOR = 10;
const MAX_MEGAS = 2;
const ITEM_PREFERENCE = [
  "Sitrus Berry",
  "Lum Berry",
  "Focus Sash",
  "Life Orb",
  "Leftovers",
  "Mental Herb",
  "Safety Goggles",
  "Covert Cloak",
  "Expert Belt",
  "Shell Bell",
  "White Herb",
  "Bright Powder",
  "Scope Lens",
  "Quick Claw",
];
const UNRELIABLE_MOVE_FLAGS = ["charge", "recharge", "futuremove"] as const;

function spread(entries: Partial<StatSpread>): StatSpread {
  const { hp = 0, atk = 0, def = 0, spa = 0, spd = 0, spe = 0 } = entries;
  return { hp, atk, def, spa, spd, spe };
}

function generatorSeed(id: string): GeneratorSeed {
  const random = seededRng(`bot-set:${id}`);
  const part = () => 1 + Math.floor(random() * 0xffff);
  return `${part()},${part()},${part()},${part()}` as const;
}

function isMega(mon: { item?: string | undefined }): boolean {
  return Boolean(mon.item);
}

function spreadFor(dex: DexLike, mon: DraftBoardMon, moves: readonly string[]) {
  const species = dex.species.get(mon.forme ?? mon.species);
  const attacks = moves.map((name) => dex.moves.get(name)).filter((move) => move.basePower > 0);
  const physical = attacks.filter((move) => move.category === "Physical").length;
  const special = attacks.filter((move) => move.category === "Special").length;
  if (!physical && !special) return { nature: "Calm", evs: spread({ hp: 32, def: 2, spd: 32 }) };
  const stat = physical > special ? "atk" : "spa";
  if (moves.includes("Trick Room"))
    return {
      nature: stat === "atk" ? "Brave" : "Quiet",
      evs: spread({ hp: 32, [stat]: 32, def: 2 }),
    };
  const fast = species.baseStats.spe >= 80;
  const nature = stat === "atk" ? (fast ? "Jolly" : "Adamant") : fast ? "Timid" : "Modest";
  return { nature, evs: spread({ hp: 2, [stat]: 32, spe: 32 }) };
}

function heuristicMoves(dex: DexLike, mon: DraftBoardMon): string[] {
  const species = dex.species.get(mon.forme ?? mon.species);
  const physical = species.baseStats.atk >= species.baseStats.spa;
  const legal = legalMoves(dex, mon).map((name) => dex.moves.get(name));
  const scored = legal
    .filter(
      (move) =>
        move.basePower > 0 &&
        move.category === (physical ? "Physical" : "Special") &&
        !UNRELIABLE_MOVE_FLAGS.some((flag) => move.flags[flag]) &&
        !move.selfdestruct &&
        !move.multiaccuracy,
    )
    .map((move) => {
      const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
      const stab = species.types.includes(move.type) ? 1.5 : 1;
      return { move, score: move.basePower * accuracy * stab };
    })
    .sort((a, b) => b.score - a.score);
  const moves: string[] = [];
  const types = new Set<string>();
  for (const { move } of scored) {
    if (moves.length === 3) break;
    if (types.has(move.type)) continue;
    types.add(move.type);
    moves.push(move.name);
  }
  if (legal.some((move) => move.id === "protect")) moves.push("Protect");
  return moves.length ? moves : legal.slice(0, 4).map((move) => move.name);
}

class SetLibrary {
  private readonly dex: DexLike;
  private readonly items: Set<string>;
  private readonly pastes = new Map<string, ShowdownSet[]>();
  private readonly generators: SetGenerator[];
  private readonly validator: InstanceType<ReturnType<typeof loadShowdown>["TeamValidator"]>;
  private readonly cache = new Map<string, RawSet>();

  constructor(
    private readonly format: string,
    psDir: string,
  ) {
    const { Dex, Teams, TeamValidator } = loadShowdown(psDir);
    this.dex = Dex.forFormat(format);
    this.items = new Set(legalItems(this.dex));
    this.validator = new TeamValidator(format);
    this.generators = ["gen9championsrandomdoublesbattle", "gen9randomdoublesbattle"].map(
      (id): SetGenerator => Teams.getGenerator(id, "1,2,3,4"),
    );
    for (const pool of fs.readdirSync(TEAMS_DIR).sort()) {
      if (!fs.existsSync(path.join(TEAMS_DIR, pool, "pool.json"))) continue;
      for (const team of loadPool(pool).teams)
        for (const set of Teams.unpack(team.packed) ?? []) {
          const key = this.key(set.species, set.item);
          this.pastes.set(key, [...(this.pastes.get(key) ?? []), set]);
        }
    }
  }

  private key(species: string, item: string | undefined): string {
    const stone = item && this.dex.items.get(item).megaStone ? this.dex.items.get(item).name : "";
    return `${this.dex.species.get(species).name}|${stone}`;
  }

  private valid(mon: DraftBoardMon, set: RawSet): boolean {
    const problems = this.validator.validateSet(
      {
        name: this.dex.species.get(mon.species).name,
        species: this.dex.species.get(mon.species).name,
        item: set.item,
        ability: set.ability,
        moves: set.moves,
        nature: set.nature,
        gender: "",
        evs: set.evs,
        ivs: spread({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }),
        level: 50,
      },
      {},
    );
    return !problems?.length;
  }

  private fromPaste(mon: DraftBoardMon, paste: ShowdownSet): RawSet {
    return {
      id: mon.id,
      item: paste.item ? this.dex.items.get(paste.item).name : "",
      ability: this.dex.abilities.get(paste.ability).name,
      nature: this.dex.natures.get(paste.nature).name || "Hardy",
      moves: paste.moves.map((move) => this.dex.moves.get(move).name),
      evs: spread(paste.evs ?? {}),
      note: "",
    };
  }

  private built(mon: DraftBoardMon, moves: string[], ability: string, item: string): RawSet {
    const abilities = Object.values(this.dex.species.get(mon.species).abilities);
    const { nature, evs } = spreadFor(this.dex, mon, moves);
    return {
      id: mon.id,
      item: mon.item ? this.dex.items.get(mon.item).name : this.items.has(item) ? item : "",
      ability: abilities.includes(ability) ? ability : abilities[0]!,
      nature,
      moves,
      evs,
      note: "",
    };
  }

  private generated(mon: DraftBoardMon): RawSet[] {
    const learnable = new Set(legalMoves(this.dex, mon));
    const ids = [
      ...new Set(
        [mon.forme, mon.species].flatMap((name) => (name ? [this.dex.species.get(name).id] : [])),
      ),
    ];
    return this.generators.flatMap((generator) =>
      ids.flatMap((id) => {
        if (!generator.randomDoublesSets[id]) return [];
        generator.setSeed(generatorSeed(id));
        const raw = generator.randomSet(id, {}, false, true);
        const moves = raw.moves
          .map((move) => this.dex.moves.get(move).name)
          .filter((move) => learnable.has(move));
        if (moves.length < 2) return [];
        return [this.built(mon, moves, raw.ability, raw.item)];
      }),
    );
  }

  set(mon: DraftBoardMon): RawSet {
    const known = this.cache.get(mon.id);
    if (known) return known;
    const candidates = [
      ...(this.pastes.get(this.key(mon.species, mon.item)) ?? []).map((paste) =>
        this.fromPaste(mon, paste),
      ),
      ...this.generated(mon),
      this.built(mon, heuristicMoves(this.dex, mon), "", "Sitrus Berry"),
    ];
    const chosen = candidates.find((set) => this.valid(mon, set));
    if (!chosen) throw new Error(`the bot has no legal ${this.format} set for ${mon.id}`);
    this.cache.set(mon.id, chosen);
    return chosen;
  }

  spareItem(taken: ReadonlySet<string>): string {
    return ITEM_PREFERENCE.find((item) => this.items.has(item) && !taken.has(item)) ?? "";
  }
}

const libraries = new Map<string, SetLibrary>();

function library(format: string, psDir: string): SetLibrary {
  const key = `${path.resolve(psDir)}|${format}`;
  let found = libraries.get(key);
  if (!found) {
    found = new SetLibrary(format, psDir);
    libraries.set(key, found);
  }
  return found;
}

/** Board cost stands in for strength: the bot spends on its first six picks and fills the bench at
 * the board minimum. */
export function botDraftPick(state: DraftState, drafter: number, legal: DraftBoardMon[], rng: Rng) {
  const roster = state.rosters[drafter]!;
  const budget = state.budgets[drafter]!;
  const cheapest = Math.min(...state.board.mons.map((mon) => mon.cost));
  const remaining = state.board.picks - roster.length;
  const coreLeft = Math.max(0, CORE_PICKS - roster.length);
  const cap =
    coreLeft > 0
      ? budget - (remaining - coreLeft) * cheapest - (coreLeft - 1) * CORE_FLOOR
      : budget - (remaining - 1) * cheapest;
  const affordable = legal.filter((mon) => mon.cost <= cap);
  const options = affordable.length
    ? affordable
    : legal.filter((mon) => mon.cost === Math.min(...legal.map((other) => other.cost)));
  const types = new Set(roster.flatMap((mon) => mon.types));
  const megas = roster.filter(isMega).length;
  const score = (mon: DraftBoardMon) =>
    mon.cost -
    mon.types.filter((type) => types.has(type)).length -
    (isMega(mon) ? (megas >= MAX_MEGAS ? 50 : megas * 2) : 0) +
    rng() * 0.5;
  return options
    .map((mon) => ({ mon, score: score(mon) }))
    .reduce((best, entry) => (entry.score > best.score ? entry : best)).mon;
}

export function botTeamSets(
  roster: readonly DraftBoardMon[],
  teamSize: number,
  format: string,
  psDir: string,
): RawSet[] {
  const sets = library(format, psDir);
  const chosen: DraftBoardMon[] = [];
  for (const mon of [...roster].sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id))) {
    if (chosen.length === teamSize) break;
    if (isMega(mon) && chosen.filter(isMega).length >= MAX_MEGAS) continue;
    chosen.push(mon);
  }
  for (const mon of roster) {
    if (chosen.length === teamSize) break;
    if (!chosen.includes(mon)) chosen.push(mon);
  }
  const items = new Set<string>();
  return chosen.map((mon) => {
    const set = sets.set(mon);
    const item = set.item && !items.has(set.item) ? set.item : sets.spareItem(items);
    items.add(item);
    return { ...set, item };
  });
}
