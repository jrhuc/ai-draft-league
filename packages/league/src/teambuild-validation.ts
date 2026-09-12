import { type Rng, shuffle } from "./random.js";
import { loadShowdown, type ShowdownApi } from "./showdown.js";
import {
  type RawSet,
  STATS,
  type StatSpread,
  type TeamBuildAction,
  type TeamBuildCandidate,
  type TeamBuildConstraint,
  type TeamBuildTask,
} from "./teambuild-protocol.js";
import { normalizePackedTeam, validateTeam } from "./teams.js";

export type DexLike = ReturnType<ShowdownApi["Dex"]["mod"]>;

export function legalMoves(dex: DexLike, mon: TeamBuildCandidate): string[] {
  const pool = dex.species.getMovePool(dex.species.get(mon.species).id);
  return [...pool]
    .map((id) => dex.moves.get(id))
    .filter((move) => move.exists && !move.isNonstandard)
    .map((move) => move.name)
    .sort();
}

export function legalItems(dex: DexLike): string[] {
  return dex.items
    .all()
    .filter((item) => !item.isNonstandard && !item.megaStone)
    .map((item) => item.name)
    .sort();
}

function statSpread(value: number): StatSpread {
  return { hp: value, atk: value, def: value, spa: value, spd: value, spe: value };
}

function packCandidateTeam(
  dex: DexLike,
  entries: readonly { mon: TeamBuildCandidate; set: RawSet }[],
  psDir: string,
): string {
  const { Teams } = loadShowdown(psDir);
  const packed = Teams.pack(
    entries.map(({ mon, set }) => ({
      name: dex.species.get(mon.species).name,
      species: dex.species.get(mon.species).name,
      item: set.item,
      ability: set.ability,
      moves: set.moves,
      nature: set.nature,
      gender: "",
      evs: { ...set.evs },
      ivs: statSpread(31),
      level: 50,
    })),
  );
  if (!packed) throw new Error("Showdown produced an empty packed team");
  return packed;
}

export function actionForCandidateTeam(
  dex: DexLike,
  task: TeamBuildTask,
  sets: RawSet[],
  psDir: string,
): TeamBuildAction {
  const { teamSize, kind } = task.constraint;
  if (sets.length !== teamSize)
    throw new Error(`"sets" must hold exactly ${teamSize} entries, not ${sets.length}`);
  const owned = new Map(task.constraint.candidates.map((mon) => [mon.id, mon]));
  const selected = new Set<string>();
  const problems: string[] = [];
  const entries = sets.map((set) => {
    const mon = owned.get(set.id);
    if (!mon)
      throw new Error(
        `"${set.id}" is not ${kind === "draft-picks" ? "a board id on your roster" : "an id in the frozen candidate pool"}`,
      );
    if (selected.has(set.id))
      throw new Error(`"${set.id}" appears twice; choose ${teamSize} different Pokémon`);
    selected.add(set.id);
    const label = `${mon.name}:`;
    const item = dex.items.get(set.item);
    if (set.item && (!item.exists || item.name !== set.item))
      problems.push(`${label} item must use its canonical Showdown name`);
    if (mon.item) {
      if (!item.exists || item.name !== dex.items.get(mon.item).name)
        problems.push(
          `${label} drafted as a Mega, so it must hold ${dex.items.get(mon.item).name}`,
        );
    } else if (item.exists && item.megaStone)
      problems.push(`${label} drafted as the base forme, so it can never hold ${item.name}`);
    for (const [field, value] of [
      ["ability", dex.abilities.get(set.ability)],
      ["nature", dex.natures.get(set.nature)],
    ] as const) {
      if (!value.exists || value.name !== set[field])
        problems.push(`${label} ${field} must use its canonical Showdown name`);
    }
    for (const name of set.moves) {
      const move = dex.moves.get(name);
      if (!move.exists || move.name !== name)
        problems.push(`${label} move ${JSON.stringify(name)} must use its canonical Showdown name`);
    }
    return { mon, set };
  });
  if (problems.length) throw new Error(problems.join("\n"));
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
    })),
  };
}

export function randomTeamSets(
  dex: DexLike,
  constraint: TeamBuildConstraint,
  rng: Rng,
  evLimit: number,
  evMax: number,
): RawSet[] {
  const chosen: RawSet[] = [];
  const bases = new Set<string>();
  for (const mon of shuffle(constraint.candidates, rng)) {
    if (chosen.length >= constraint.teamSize) break;
    if (bases.has(mon.base)) continue;
    bases.add(mon.base);
    const evs = statSpread(Math.min(evMax, Math.floor(evLimit / STATS.length)));
    const moves = legalMoves(dex, mon);
    chosen.push({
      id: mon.id,
      item: mon.item ? dex.items.get(mon.item).name : "",
      ability: dex.species.get(mon.species).abilities[0],
      nature: "Hardy",
      moves: moves.length ? [moves[Math.floor(rng() * moves.length)]!] : [],
      evs,
      note: "",
    });
  }
  return chosen;
}
