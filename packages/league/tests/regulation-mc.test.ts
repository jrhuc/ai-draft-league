import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { loadBoard } from "../src/draft.js";
import { ShowdownReference } from "../src/reference.js";
import { filledStats, type PokemonSet } from "../src/reference-mechanics.js";
import { loadShowdown } from "../src/showdown.js";
import { legalItems } from "../src/teambuild-validation.js";
import { validateTeam } from "../src/teams.js";
import { activeRequest, requestActionCandidates } from "./fixtures/fork.js";

const FORMAT = "gen9championsvgc2026regmcbo3";
const { Dex, Battle, Teams } = loadShowdown();
const dex = Dex.forFormat(FORMAT);
const reference = new ShowdownReference(FORMAT);

test("the M-C board includes every newly legal species and forme", () => {
  const board = loadBoard("regmc-202609");
  const previous = Dex.forFormat("gen9championsvgc2026regmbbo3");
  const additions = dex.species
    .all()
    .filter((species) => !species.isNonstandard && previous.species.get(species.id).isNonstandard);
  assert.equal(additions.length, 35);
  assert.deepEqual(
    board.mons
      .filter((mon) => mon.origin === "regmc")
      .map((mon) => mon.forme ?? mon.species)
      .sort(),
    additions.map((species) => species.name).sort(),
  );
  assert.equal(board.mons.filter((mon) => mon.origin === "regmc" && mon.item).length, 6);
  assert.ok(
    board.mons
      .filter((mon) => mon.origin === "regmc")
      .every((mon) => mon.anchor?.startsWith("Provisional:")),
  );
});

test("M-C item discovery and descriptions include the newly released items", () => {
  const freeItems = legalItems(dex);
  for (const name of [
    "Air Balloon",
    "Binding Band",
    "Eject Button",
    "Electric Seed",
    "Grassy Seed",
    "Leek",
    "Misty Seed",
    "Normal Gem",
    "Psychic Seed",
    "Red Card",
    "Rocky Helmet",
    "Terrain Extender",
  ]) {
    assert.ok(freeItems.includes(name), name);
    assert.match(reference.lookup("lookup_item", { name }), /^- Item .+: .+/);
  }
  for (const name of [
    "Absolite Z",
    "Baxcalibrite",
    "Garchompite Z",
    "Golisopite",
    "Lucarionite Z",
    "Salamencite",
  ]) {
    assert.ok(!freeItems.includes(name), "Mega Stones belong to locked board entries");
    assert.match(reference.lookup("lookup_item", { name }), /^- Item .+: .+/);
  }
  for (const name of ["Assault Vest", "Eviolite", "Safety Goggles", "Booster Energy"]) {
    assert.ok(!freeItems.includes(name), name);
    assert.match(reference.lookup("lookup_item", { name }), /is not legal/);
  }
});

test("M-C reference text resolves Champions overrides and Z Mega names", () => {
  assert.match(reference.lookup("lookup_ability", { name: "Aura Guard" }), /contact/);
  assert.match(
    reference.lookup("lookup_move", { name: "Milk Drink" }),
    /target adjacentAllyOrSelf/,
  );
  assert.match(reference.lookup("lookup_move", { name: "Slash" }), /BP 80/);
  assert.match(reference.lookup("lookup_learnset", { name: "Rillaboom" }), /Grassy Glide/);
  assert.match(reference.lookup("lookup_learnset", { name: "Pawmot" }), /Revival Blessing/);
  assert.match(
    reference.lookup("lookup_species", { name: "Mega Garchomp Z" }),
    /Garchomp-Mega-Z: Dragon;.*Levitate/,
  );
  assert.match(
    reference.lookup("lookup_species", { name: "Mega Absol Z" }),
    /Absol-Mega-Z: Dark\/Ghost;.*Sharpness/,
  );
  assert.match(
    reference.lookup("lookup_species", { name: "Mega Lucario Z" }),
    /Lucario-Mega-Z: Fighting\/Steel;.*Aura Guard/,
  );
});

function set(species: string, item = ""): PokemonSet {
  return {
    name: species,
    species,
    item,
    ability: dex.species.get(species).abilities[0],
    nature: "Serious",
    gender: "",
    moves: ["Protect"],
    level: 50,
    evs: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
    ivs: filledStats(31),
  };
}

for (const stone of [
  "Absolite Z",
  "Baxcalibrite",
  "Garchompite Z",
  "Golisopite",
  "Lucarionite Z",
  "Salamencite",
]) {
  test(`${stone} validates, appears in action menus, and consumes the single Mega Evolution`, () => {
    const mapping = Object.entries(dex.items.get(stone).megaStone ?? {})[0];
    assert.ok(mapping);
    const [base, forme] = mapping;
    const team = [
      set(base, stone),
      set("Charizard", "Charizardite Y"),
      set("Rillaboom", "Grassy Seed"),
      set("Indeedee-F", "Psychic Seed"),
      set("Incineroar", "Rocky Helmet"),
      set("Pelipper", "Eject Button"),
    ];
    const packed = Teams.pack(team);
    validateTeam(packed, FORMAT);
    const battle = new Battle({
      formatid: FORMAT,
      seed: "1,2,3,4",
      p1: { name: "One", team: packed },
      p2: { name: "Two", team: packed },
    });
    try {
      battle.makeChoices("team 1234", "team 1234");
      const request = activeRequest(battle, "p1");
      assert.ok(request.active?.every((mon) => !mon?.canTerastallize));
      assert.ok(requestActionCandidates(request).includes("move 1 mega, move 1"));
      battle.makeChoices("move 1 mega, move 1", "move 1, move 1");
      assert.equal(battle.p1.active[0]?.species.name, forme);
      assert.equal(battle.p1.active[0]?.getAbility().name, dex.species.get(forme).abilities[0]);
      assert.ok(!activeRequest(battle, "p1").active?.[1]?.canMegaEvo);
    } finally {
      battle.destroy();
    }
  });
}

test("M-C damage estimates execute Levitate, Aura Guard and Sharpness", () => {
  assert.match(
    reference.lookup("estimate_damage", {
      attacker: "Rillaboom",
      defender: "Garchomp-Mega-Z",
      move: "High Horsepower",
      defender_ability: "Levitate",
    }),
    /0% damage\. Cannot KO/,
  );

  const damageHigh = (result: string): number => {
    const match = result.match(/([\d.]+)-([\d.]+)% of maximum HP/);
    assert.ok(match, result);
    return Number(match[2]);
  };
  const contact = { attacker: "Rillaboom", defender: "Lucario-Mega-Z", move: "Wood Hammer" };
  const ordinary = damageHigh(reference.lookup("estimate_damage", contact));
  const guarded = damageHigh(
    reference.lookup("estimate_damage", { ...contact, defender_ability: "Aura Guard" }),
  );
  assert.ok(guarded > ordinary * 0.45 && guarded < ordinary * 0.55);
  const slicing = { attacker: "Absol-Mega-Z", defender: "Rillaboom", move: "Night Slash" };
  const unboosted = damageHigh(reference.lookup("estimate_damage", slicing));
  const sharp = damageHigh(
    reference.lookup("estimate_damage", { ...slicing, attacker_ability: "Sharpness" }),
  );
  assert.ok(sharp > unboosted * 1.4 && sharp < unboosted * 1.6);
});
