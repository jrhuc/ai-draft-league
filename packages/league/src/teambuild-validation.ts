import { type Rng, shuffle } from "./random.js";
import type { ShowdownApi } from "./showdown.js";
import { loadShowdown } from "./showdown.js";
import {
  type RawSet,
  STATS,
  type StatSpread,
  type TeamBuildAction,
  type TeamBuildCandidate,
  type TeamBuildTask,
} from "./teambuild-protocol.js";
import { normalizePackedTeam, validateTeam } from "./teams.js";

export type DexLike = ReturnType<ShowdownApi["Dex"]["mod"]>;

export function legalMoves(dex: DexLike, mon: TeamBuildCandidate): string[] {
  const species = dex.species.get(mon.species);
  const pool = dex.species.getMovePool(species.id);
  const names: string[] = [];
  for (const id of pool) {
    const move = dex.moves.get(id);
    if (move?.exists && !move.isNonstandard) names.push(move.name);
  }
  return names.sort();
}

export function legalItems(dex: DexLike): string[] {
  const names: string[] = [];
  for (const item of dex.items.all()) {
    if (item.isNonstandard || item.megaStone) continue;
    names.push(item.name);
  }
  return names.sort();
}

function statSpread(value: number): StatSpread {
  return { hp: value, atk: value, def: value, spa: value, spd: value, spe: value };
}

export interface RepairedSet {
  set: RawSet;
  repairs: string[];
}

export function repairSet(
  dex: DexLike,
  mon: TeamBuildCandidate,
  set: RawSet,
  evLimit: number,
  evMax: number,
  taken: Set<string>,
  rng: Rng,
): RepairedSet {
  const repairs: string[] = [];
  const base = dex.species.get(mon.species);

  const candidate = dex.items.get(set.item);
  let itemName = candidate.exists ? candidate.name : "";
  if (mon.item) {
    const required = dex.items.get(mon.item).name;
    if (itemName !== required) {
      repairs.push(`item set to ${required}, which this Mega entry is locked to`);
      itemName = required;
    }
  } else if (!itemName && set.item) {
    repairs.push(`unknown item ${JSON.stringify(set.item)} removed`);
  } else if (candidate.megaStone) {
    repairs.push(`${itemName} removed: this entry was drafted as the base forme`);
    itemName = "";
  } else if (itemName && taken.has(itemName)) {
    repairs.push(`${itemName} removed: Item Clause, another of your six already holds it`);
    itemName = "";
  }
  if (itemName && itemName !== set.item && repairs.length === 0) {
    repairs.push(`item normalized from ${JSON.stringify(set.item)} to ${itemName}`);
  }
  if (itemName) taken.add(itemName);

  const abilities = Object.values(base.abilities ?? {}).flatMap((name) => (name ? [name] : []));
  let ability = abilities.find(
    (name) => dex.abilities.get(name).name === dex.abilities.get(set.ability).name,
  );
  if (!ability) {
    ability = abilities[0]!;
    repairs.push(`ability set to ${ability}, which ${base.name} can legally have`);
  } else if (ability !== set.ability) {
    repairs.push(`ability normalized from ${JSON.stringify(set.ability)} to ${ability}`);
  }

  let nature = dex.natures.get(set.nature);
  if (!nature?.exists) {
    nature = dex.natures.get("Serious");
    repairs.push(`unknown nature ${JSON.stringify(set.nature)} replaced with Serious`);
  } else if (nature.name !== set.nature) {
    repairs.push(`nature normalized from ${JSON.stringify(set.nature)} to ${nature.name}`);
  }

  const pool = legalMoves(dex, mon);
  const poolById = new Map(pool.map((name) => [dex.moves.get(name).id, name]));
  const moves: string[] = [];
  for (const move of set.moves) {
    const resolved = poolById.get(dex.moves.get(move).id);
    if (!resolved) {
      repairs.push(`${mon.name} cannot learn ${JSON.stringify(move)}; dropped`);
      continue;
    }
    if (moves.includes(resolved)) {
      repairs.push(`duplicate move ${resolved} dropped`);
      continue;
    }
    if (resolved !== move)
      repairs.push(`move normalized from ${JSON.stringify(move)} to ${resolved}`);
    moves.push(resolved);
  }
  if (!moves.length && pool.length) {
    const candidateMove = pool[Math.floor(rng() * pool.length)]!;
    moves.push(candidateMove);
    repairs.push(`filled an empty move slot with ${candidateMove}`);
  }

  const evs: StatSpread = { ...set.evs };
  for (const stat of STATS) {
    if (evs[stat] > evMax) {
      repairs.push(`${stat} EVs clamped from ${evs[stat]} to ${evMax}`);
      evs[stat] = evMax;
    }
  }
  let total = STATS.reduce((sum, stat) => sum + evs[stat], 0);
  if (total > evLimit) {
    const scale = evLimit / total;
    for (const stat of STATS) evs[stat] = Math.floor(evs[stat] * scale);
    total = STATS.reduce((sum, stat) => sum + evs[stat], 0);
    for (const stat of STATS) {
      if (total >= evLimit) break;
      const room = Math.min(evMax - evs[stat], evLimit - total);
      evs[stat] += room;
      total += room;
    }
    repairs.push(`EVs scaled to the ${evLimit}-point limit`);
  }

  return {
    set: {
      ...set,
      item: itemName,
      ability,
      nature: nature.name,
      moves,
      evs,
    },
    repairs,
  };
}

type ShowdownSet = NonNullable<ReturnType<ShowdownApi["Teams"]["unpack"]>>[number];

export function packCandidateTeam(
  dex: DexLike,
  entries: readonly { mon: TeamBuildCandidate; set: RawSet }[],
  psDir: string,
): string {
  const { Teams } = loadShowdown(psDir);
  const sets: ShowdownSet[] = entries.map(({ mon, set }) => {
    const base = dex.species.get(mon.species);
    return {
      name: base.name,
      species: base.name,
      item: set.item,
      ability: set.ability,
      moves: set.moves,
      nature: set.nature,
      gender: "",
      evs: { ...set.evs },
      ivs: statSpread(31),
      level: 50,
    };
  });
  const packed = Teams.pack(sets);
  if (!packed) throw new Error("Showdown produced an empty packed team");
  return packed;
}

export function actionForCandidateTeam(
  dex: DexLike,
  task: TeamBuildTask,
  entries: readonly { mon: TeamBuildCandidate; set: RawSet }[],
  psDir: string,
): TeamBuildAction {
  const packed = normalizePackedTeam(packCandidateTeam(dex, entries, psDir), psDir, task.format);
  validateTeam(packed, task.format, psDir);
  return {
    selected: entries.map((entry) => entry.mon.id),
    packed,
    sets: entries.map(({ mon, set }) => ({
      species: mon.name,
      spriteId: dex.species.get(mon.forme ?? mon.species).spriteid,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: { ...set.evs },
      note: set.note,
      repaired: false,
      repairs: [],
    })),
  };
}

export function validateCandidate(
  dex: DexLike,
  format: string,
  sets: RawSet[],
  owned: Map<string, TeamBuildCandidate>,
  psDir: string,
): string[] {
  const problems: string[] = [];
  const entries: Array<{ mon: TeamBuildCandidate; set: RawSet }> = [];
  for (const set of sets) {
    const mon = owned.get(set.id);
    if (!mon) {
      problems.push(`${set.id}: not present in the task constraint`);
      continue;
    }
    entries.push({ mon, set });
    const label = `${mon.name}:`;
    const item = dex.items.get(set.item);
    if (set.item && (!item?.exists || item.name !== set.item)) {
      problems.push(`${label} item must use its canonical Showdown name`);
    }
    if (mon.item) {
      if (!item?.exists || item.name !== dex.items.get(mon.item).name) {
        problems.push(
          `${label} drafted as a Mega, so it must hold ${dex.items.get(mon.item).name}`,
        );
      }
    } else if (item?.exists && item.megaStone) {
      problems.push(`${label} drafted as the base forme, so it can never hold ${item.name}`);
    }
    const ability = dex.abilities.get(set.ability);
    if (!ability?.exists || ability.name !== set.ability) {
      problems.push(`${label} ability must use its canonical Showdown name`);
    }
    const nature = dex.natures.get(set.nature);
    if (!nature?.exists || nature.name !== set.nature) {
      problems.push(`${label} nature must use its canonical Showdown name`);
    }
    for (const moveName of set.moves) {
      const move = dex.moves.get(moveName);
      if (!move?.exists || move.name !== moveName) {
        problems.push(
          `${label} move ${JSON.stringify(moveName)} must use its canonical Showdown name`,
        );
      }
    }
  }

  if (entries.length !== sets.length) return problems;
  const packed = packCandidateTeam(dex, entries, psDir);
  try {
    validateTeam(packed, format, psDir);
  } catch (cause) {
    problems.push(...(cause instanceof Error ? cause.message : String(cause)).split("\n"));
  }
  return problems;
}

function minimalSet(mon: TeamBuildCandidate, evLimit: number, evMax: number): RawSet {
  const evs = statSpread(0);
  let spent = 0;
  for (const stat of STATS) {
    const share = Math.min(evMax, Math.floor(evLimit / STATS.length), evLimit - spent);
    evs[stat] = share;
    spent += share;
  }
  return {
    id: mon.id,
    item: mon.item ?? "",
    ability: "",
    nature: "Hardy",
    moves: [],
    evs,
    note: "",
  };
}

export function fallbackSets(
  candidates: readonly TeamBuildCandidate[],
  teamSize: number,
  rng: Rng,
  evLimit: number,
  evMax: number,
): RawSet[] {
  const chosen: TeamBuildCandidate[] = [];
  const bases = new Set<string>();
  for (const mon of shuffle(candidates, rng)) {
    if (chosen.length >= teamSize || bases.has(mon.base)) continue;
    bases.add(mon.base);
    chosen.push(mon);
  }
  return chosen.map((mon) => minimalSet(mon, evLimit, evMax));
}
