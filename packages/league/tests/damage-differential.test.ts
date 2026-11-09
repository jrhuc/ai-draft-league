import assert from "node:assert/strict";
import type { Dex } from "pokemon-showdown";
import { test } from "vite-plus/test";

import { seededRng } from "../src/random.js";
import { type EstimateDamageArguments, ShowdownReference } from "../src/reference.js";
import { BOOST_IDS, filledStats, type PokemonSet, STAT_IDS } from "../src/reference-mechanics.js";
import { loadShowdown } from "../src/showdown.js";

const FORMAT = "gen9championsvgc2026regmcbo3";
const ITEMS = [
  "",
  "",
  "",
  "Life Orb",
  "Choice Scarf",
  "Expert Belt",
  "Muscle Band",
  "Wise Glasses",
  "Sitrus Berry",
  "Focus Sash",
  "Charcoal",
  "Mystic Water",
  "Black Glasses",
  "Silk Scarf",
  "Occa Berry",
  "Chople Berry",
  "Rocky Helmet",
  "Leftovers",
  "Scope Lens",
  "Metronome",
  "Light Ball",
  "Shell Bell",
  "Yache Berry",
  "Shuca Berry",
  "Miracle Seed",
  "Magnet",
];
/** Moves whose turn-one result depends on a condition this scripted turn cannot set up. */
const UNSCRIPTED = new Set([
  "suckerpunch",
  "thunderclap",
  "focuspunch",
  "counter",
  "mirrorcoat",
  "metalburst",
  "comeuppance",
  "upperhand",
  "lastresort",
  "belch",
  "fling",
  "naturalgift",
  "steelroller",
  "poltergeist",
  "burnup",
  "doubleshock",
  "dreameater",
  "synchronoise",
  "snore",
  "sleeptalk",
  "spitup",
  "struggle",
  "aurawheel",
  "hyperspacefury",
  "shelltrap",
  "beakblast",
  "finalgambit",
  "explosion",
  "selfdestruct",
  "mistyexplosion",
  "mindblown",
  "steelbeam",
  "chloroblast",
  "uproar",
  "rollout",
  "iceball",
  "outrage",
  "thrash",
  "petaldance",
  "ragingfury",
  "beatup",
  "endeavor",
  "painsplit",
  "superfang",
  "ruination",
  "naturesmadness",
  "psywave",
]);
const WEATHER = new Map([
  ["sunnyday", "sun"],
  ["raindance", "rain"],
  ["sandstorm", "sand"],
  ["snowscape", "snow"],
]);
const TERRAIN = new Map([
  ["electricterrain", "electric"],
  ["grassyterrain", "grassy"],
  ["mistyterrain", "misty"],
  ["psychicterrain", "psychic"],
]);

interface Mismatch {
  call: EstimateDamageArguments;
  engine: number;
  tool: string;
}

function differential(seed: string, iterations: number) {
  const showdown = loadShowdown();
  const format = showdown.Dex.formats.get(FORMAT);
  const dex = showdown.Dex.forFormat(format);
  const reference = new ShowdownReference(FORMAT);
  const random = seededRng(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const legal = (entry: { exists: boolean; isNonstandard: string | null }) =>
    entry.exists && !entry.isNonstandard;
  const species = dex.species
    .all()
    .filter(
      (entry) =>
        legal(entry) &&
        entry.tier !== "Illegal" &&
        (!entry.battleOnly || entry.isMega) &&
        entry.baseSpecies !== "Ditto",
    );
  const items = ITEMS.filter((name) => !name || legal(dex.items.get(name)));
  const natures = dex.natures.all().map((nature) => nature.name);
  const stoneFor = (mega: Dex.Species): string =>
    dex.items.all().find((item) => Object.values(item.megaStone ?? {}).includes(mega.name))?.name ??
    "";
  const set = (entry: Dex.Species, moves: string[]): PokemonSet => {
    const evs = filledStats(0);
    let left = 66;
    for (const stat of [...STAT_IDS].sort(() => random() - 0.5)) {
      evs[stat] = Math.min(32, Math.floor(random() * (left + 1)));
      left -= evs[stat];
    }
    return {
      name: entry.name,
      species: entry.name,
      item: entry.isMega ? stoneFor(entry) : pick(items),
      ability: pick(Object.values(entry.abilities)),
      moves,
      nature: pick(natures),
      gender: "",
      evs,
      ivs: filledStats(31),
      level: 50,
    };
  };
  const attacks = (entry: Dex.Species) =>
    [...dex.species.getMovePool(dex.species.get(entry.baseSpecies).id)]
      .map((moveId) => dex.moves.get(moveId))
      .filter(
        (move) =>
          legal(move) &&
          move.category !== "Status" &&
          Boolean(move.basePower || move.basePowerCallback || move.damage || move.damageCallback) &&
          !Array.isArray(move.multihit) &&
          !move.smartTarget &&
          !move.ohko &&
          !move.flags.charge &&
          !move.flags.futuremove &&
          !UNSCRIPTED.has(move.id),
      );

  const off: Mismatch[] = [];
  let compared = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const [attackerSpecies, defenderSpecies, attackerAllySpecies, defenderAllySpecies] = [
      pick(species),
      pick(species),
      pick(species),
      pick(species),
    ];
    if (
      attackerSpecies.baseSpecies === attackerAllySpecies.baseSpecies ||
      defenderSpecies.baseSpecies === defenderAllySpecies.baseSpecies ||
      attackerAllySpecies.isMega ||
      defenderAllySpecies.isMega
    )
      continue;
    const moves = attacks(attackerSpecies);
    if (!moves.length) continue;
    const move = pick(moves);
    const battle = new showdown.Battle({
      seed: "1,2,3,4",
      formatid: format.id,
      format,
      p1: {
        name: "A",
        team: [set(attackerSpecies, [move.id]), set(attackerAllySpecies, ["splash"])],
      },
      p2: {
        name: "B",
        team: [set(defenderSpecies, ["splash"]), set(defenderAllySpecies, ["splash"])],
      },
    });
    try {
      if (!battle.turn) battle.makeChoices("default", "default");
      const [attacker, attackerAlly] = battle.p1.active;
      const [defender, defenderAlly] = battle.p2.active;
      if (!attacker || !attackerAlly || !defender || !defenderAlly) continue;
      /** Its own Splash this turn changes a Protean defender's type before the hit; Rivalry reads genders the tool is not given. */
      if (defender.hasAbility(["protean", "libero"]) || attacker.hasAbility("rivalry")) continue;
      const boosts = (pokemon: typeof attacker): Record<string, number> =>
        Object.fromEntries(
          BOOST_IDS.flatMap((stat) => (pokemon.boosts[stat] ? [[stat, pokemon.boosts[stat]]] : [])),
        );
      const call: EstimateDamageArguments = {
        attacker: attacker.species.name,
        defender: defender.species.name,
        move: move.name,
        attacker_ability: attacker.getAbility().name,
        defender_ability: defender.getAbility().name,
        attacker_nature: attacker.set.nature,
        attacker_stats: { ...attacker.storedStats },
        defender_stats: { ...defender.storedStats, hp: defender.maxhp },
        attacker_boosts: boosts(attacker),
        defender_boosts: boosts(defender),
        attacker_hp_percent: (attacker.hp * 100) / attacker.maxhp,
        defender_hp_percent: (defender.hp * 100) / defender.maxhp,
        attacker_ally: attackerAlly.species.name,
        attacker_ally_ability: attackerAlly.getAbility().name,
        defender_ally: defenderAlly.species.name,
        defender_ally_ability: defenderAlly.getAbility().name,
        attacker_fainted_allies: 0,
        attacker_hits_taken: 0,
        weather: WEATHER.get(battle.field.weather) ?? "none",
        terrain: TERRAIN.get(battle.field.terrain) ?? "none",
        is_spread_hit: move.target === "allAdjacentFoes" || move.target === "allAdjacent",
      };
      if (attacker.item) call.attacker_item = attacker.getItem().name;
      if (defender.item) call.defender_item = defender.getItem().name;
      if (attackerAlly.item) call.attacker_ally_item = attackerAlly.getItem().name;
      if (defenderAlly.item) call.defender_ally_item = defenderAlly.getItem().name;
      const maxHp = defender.maxhp;
      const target = ["normal", "any", "adjacentFoe"].includes(move.target) ? " 1" : "";
      let dealt = 0;
      let hit = false;
      let immune = false;
      battle.randomizer = (value: number) => value;
      battle.randomChance = (numerator: number, denominator: number) => numerator >= denominator;
      const getDamage = battle.actions.getDamage.bind(battle.actions);
      battle.actions.getDamage = (source, victim, used, suppress) => {
        const value = getDamage(source, victim, used, suppress);
        if (source === attacker && victim === defender) {
          hit = true;
          if (value === false) immune = true;
          else if (value !== undefined && value !== null) dealt += value;
        }
        return value;
      };
      battle.makeChoices(`move 1${target}, move 1`, "move 1, move 1");
      if (!hit) continue;
      const tool = reference.lookup("estimate_damage", call);
      const stated = [
        ...tool.matchAll(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)% (?:of maximum HP|\(BP)/g),
      ].map((range) => Math.max(Number(range[1]), Number(range[2])));
      const maxima = stated.length ? stated : /0% damage\. Cannot KO/.test(tool) ? [0] : [];
      const engine = immune ? 0 : Math.round((dealt / maxHp) * 1000) / 10;
      compared += 1;
      if (!maxima.some((maximum) => Math.abs(maximum - engine) <= 0.11))
        off.push({ call, engine, tool });
    } finally {
      battle.destroy();
    }
  }
  return { compared, off };
}

test("estimate_damage matches the simulator's own maximum roll on random legal turns", () => {
  const { compared, off } = differential("differential", 2000);
  assert.ok(compared > 400, `only ${compared} turns produced a hit to compare`);
  assert.deepEqual(
    off.map(
      ({ call, engine, tool }) =>
        `${call.attacker} (${call.attacker_ability}, ${call.attacker_item ?? "no item"}) ${call.move} into ${call.defender} (${call.defender_ability}): engine ${engine}%; ${tool}`,
    ),
    [],
  );
});
