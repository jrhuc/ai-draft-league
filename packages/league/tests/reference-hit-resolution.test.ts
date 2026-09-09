import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { ShowdownReference } from "../src/reference.js";
import { filledStats, type PokemonSet } from "../src/reference-mechanics.js";
import { loadShowdown } from "../src/showdown.js";

const format = "gen9championsvgc2026regmc";
const reference = new ShowdownReference(format);

test("calculator refuses unresolved multi-target hit allocation", () => {
  const estimate = reference.lookup("estimate_damage", {
    attacker: "Dragapult",
    defender: "Pikachu",
    move: "Dragon Darts",
  });
  assert.match(estimate, /multi-target hit allocation is not supported/);
  assert.doesNotMatch(estimate, /Guaranteed|KO at/);
});

for (const scenario of [
  {
    name: "ordinary lethal hit",
    species: "Pikachu",
    ability: "Static",
    item: "",
    move: "Earthquake",
    hp: 100,
    ko: true,
  },
  {
    name: "full-health Focus Sash",
    species: "Pikachu",
    ability: "Static",
    item: "Focus Sash",
    move: "Earthquake",
    hp: 100,
    ko: false,
  },
  {
    name: "damaged Focus Sash",
    species: "Pikachu",
    ability: "Static",
    item: "Focus Sash",
    move: "Earthquake",
    hp: 50,
    ko: true,
  },
  {
    name: "full-health Sturdy",
    species: "Steelix",
    ability: "Sturdy",
    item: "",
    move: "Earthquake",
    hp: 100,
    ko: false,
  },
  {
    name: "full-health Disguise",
    species: "Mimikyu",
    ability: "Disguise",
    item: "",
    move: "Earthquake",
    hp: 100,
    ko: false,
  },
  {
    name: "second hit after Focus Sash",
    species: "Pikachu",
    ability: "Static",
    item: "Focus Sash",
    move: "Double Hit",
    hp: 100,
    ko: true,
  },
  {
    name: "second hit after Disguise",
    species: "Mimikyu",
    ability: "Disguise",
    item: "",
    move: "Bullet Seed",
    hp: 100,
    ko: true,
  },
]) {
  test(`calculator matches a complete simulator turn: ${scenario.name}`, () => {
    const set = (species: string, ability: string, item: string, move: string): PokemonSet => ({
      name: species,
      species,
      ability,
      item,
      moves: [move],
      nature: "Serious",
      gender: "",
      evs: filledStats(0),
      ivs: filledStats(31),
      level: 50,
    });
    const filler = set("Magikarp", "Honey Gather", "", "Splash");
    const battle = new (loadShowdown().Battle)({
      formatid: format,
      seed: "1,2,3,4",
      p1: { name: "Attacker", team: [set("Garchomp", "Honey Gather", "", scenario.move), filler] },
      p2: {
        name: "Defender",
        team: [set(scenario.species, scenario.ability, scenario.item, "Splash"), filler],
      },
    });
    try {
      battle.makeChoices("default", "default");
      const attacker = battle.p1.active[0]!;
      const defender = battle.p2.active[0]!;
      attacker.boosts.atk = 6;
      defender.boosts.def = -6;
      defender.hp = Math.round((defender.maxhp * scenario.hp) / 100);
      const args = {
        attacker: "Garchomp",
        defender: scenario.species,
        move: scenario.move,
        defender_ability: scenario.ability,
        defender_item: scenario.item,
        attacker_boosts: { atk: 6 },
        defender_boosts: { def: -6 },
        attacker_stats: { atk: attacker.storedStats.atk },
        defender_stats: { hp: defender.maxhp, def: defender.storedStats.def },
        defender_hp_percent: scenario.hp,
      };
      const estimate = reference.lookup("estimate_damage", args);
      battle.makeChoices(
        scenario.move === "Earthquake" ? "move 1, move 1" : "move 1 1, move 1",
        "move 1, move 1",
      );
      assert.equal(defender.hp === 0, scenario.ko, battle.log.join("\n"));
      assert.doesNotMatch(estimate, /engine error|Guaranteed|no standard damage/);
      assert.match(
        estimate,
        scenario.ko ? /at both evaluated endpoints/ : /at either evaluated endpoint/,
      );
      assert.equal(reference.lookup("estimate_damage", args), estimate);
    } finally {
      battle.destroy();
    }
  });
}
