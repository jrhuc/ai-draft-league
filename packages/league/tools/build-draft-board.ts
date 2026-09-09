#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { type DraftBoardMon, draftBoardSchema } from "../src/draft.js";
import { BOARDS_DIR, defaultPsDir } from "../src/paths.js";
import { loadShowdown } from "../src/showdown.js";

const SOURCE_COSTS = path.join(BOARDS_DIR, "sources", "draft-costs.json");

const REGMB_ADDITIONS: Array<{ name: string; cost: number; anchor: string }> = [
  { name: "Metagross-Mega", cost: 17, anchor: "Smogon B; BST 700 matches Mega Tyranitar (17)" },
  { name: "Swampert-Mega", cost: 15, anchor: "Smogon B; rain sweeper above Mega Gyarados (14)" },
  {
    name: "Blaziken-Mega",
    cost: 12,
    anchor: "Smogon C+; Speed Boost, between Mega Medicham (12) and Mega Lucario (15)",
  },
  { name: "Mawile-Mega", cost: 12, anchor: "Smogon C+; Huge Power mirrors Mega Medicham (12)" },
  { name: "Raichu-Mega-Y", cost: 12, anchor: "Smogon B-; fast electric above Mega Manectric (10)" },
  { name: "Staraptor-Mega", cost: 12, anchor: "Smogon B-; flying attacker above Mega Pidgeot (7)" },
  { name: "Pyroar-Mega", cost: 11, anchor: "Smogon C+; special fire above Mega Chandelure (9)" },
  {
    name: "Sceptile-Mega",
    cost: 10,
    anchor: "unranked; fast frail special, cf. Mega Alakazam (12)",
  },
  { name: "Eelektross-Mega", cost: 10, anchor: "unranked; cf. Mega Manectric (10)" },
  { name: "Raichu-Mega-X", cost: 9, anchor: "unranked, unlike its Y forme; cf. Mega Altaria (9)" },
  { name: "Barbaracle-Mega", cost: 8, anchor: "unranked; cf. Mega Crabominable (8)" },
  { name: "Dragalge-Mega", cost: 8, anchor: "unranked; cf. Mega Drampa (8)" },
  { name: "Scolipede-Mega", cost: 8, anchor: "unranked; Speed Boost, cf. Mega Sharpedo (7)" },
  { name: "Meowstic-F-Mega", cost: 8, anchor: "unranked; just under Mega Meowstic (9)" },
  { name: "Scrafty-Mega", cost: 7, anchor: "Smogon C-; cf. Mega Heracross (7)" },
  { name: "Malamar-Mega", cost: 7, anchor: "unranked; cf. Mega Victreebel (7)" },
  { name: "Falinks-Mega", cost: 7, anchor: "unranked; cf. Mega Pinsir (7)" },
  { name: "Grimmsnarl", cost: 15, anchor: "Smogon B+; Prankster screens, under Whimsicott (19)" },
  {
    name: "Gholdengo",
    cost: 14,
    anchor: "Smogon B; blocks Prankster status, cf. Corviknight (13)",
  },
  { name: "Annihilape", cost: 11, anchor: "Smogon C+; Rage Fist, above Krookodile (9)" },
  { name: "Houndstone", cost: 6, anchor: "Smogon C; cf. Spiritomb (6)" },
  {
    name: "Blaziken",
    cost: 6,
    anchor: "Smogon C-; Speed Boost carries the unmegaed forme, cf. Blastoise (9)",
  },
  { name: "Metagross", cost: 6, anchor: "base of a 17-point mega, cf. Blastoise (9)" },
  { name: "Swampert", cost: 6, anchor: "base of a 15-point mega, cf. Blastoise (9)" },
  {
    name: "Staraptor",
    cost: 4,
    anchor: "Smogon C-; Intimidate/Final Gambit utility, cf. Starmie (4)",
  },
  { name: "Vileplume", cost: 4, anchor: "Smogon C-; cf. Roserade (4)" },
  { name: "Overqwil", cost: 4, anchor: "unranked; cf. Toxicroak (4)" },
  { name: "Sceptile", cost: 3, anchor: "base of a 10-point mega, cf. Decidueye (3)" },
  { name: "Eelektross", cost: 3, anchor: "unranked; cf. Flapple (3)" },
  { name: "Barbaracle", cost: 3, anchor: "unranked; cf. Crabominable (3)" },
  { name: "Dragalge", cost: 3, anchor: "unranked; cf. Toxapex (3)" },
  { name: "Scrafty", cost: 3, anchor: "unranked base of a 7-point mega, cf. Passimian (3)" },
  { name: "Scolipede", cost: 3, anchor: "unranked base of an 8-point mega, cf. Ariados (2)" },
  { name: "Malamar", cost: 3, anchor: "unranked; cf. Trevenant (3)" },
  { name: "Musharna", cost: 3, anchor: "unranked; cf. Audino (3)" },
  { name: "Pyroar", cost: 2, anchor: "base of an 11-point mega, cf. Tauros (2)" },
  { name: "Falinks", cost: 2, anchor: "unranked base of a 7-point mega, cf. Morpeko (2)" },
  { name: "Mawile", cost: 2, anchor: "the Huge Power mega is the draw, cf. Aggron (2)" },
  { name: "Qwilfish", cost: 2, anchor: "unranked; cf. Sandaconda (2)" },
];

const REGMC_ADDITIONS: Array<{ name: string; cost: number; anchor: string }> = [
  {
    name: "Rillaboom",
    cost: 19,
    anchor:
      "Provisional: terrain control, Fake Out, Grassy Glide and pivoting; cf. Incineroar (18), without Assault Vest",
  },
  {
    name: "Indeedee-F",
    cost: 18,
    anchor: "Provisional: Psychic Surge and Follow Me; cf. Farigiraf (18)",
  },
  {
    name: "Salamence-Mega",
    cost: 20,
    anchor:
      "Provisional: Intimidate into Aerilate, mixed offense, bulk and Tailwind; premium flexible Mega, cf. Mega Charizard Y (20)",
  },
  {
    name: "Garchomp-Mega-Z",
    cost: 16,
    anchor:
      "Provisional: 151 Speed, special coverage and Levitate; two below Garchomp (18) for losing item flexibility and Ground STAB",
  },
  {
    name: "Baxcalibur-Mega",
    cost: 15,
    anchor:
      "Provisional: 175 Attack and increased bulk, but unchanged 87 Speed and no Clear Amulet; cf. Baxcalibur (13)",
  },
  {
    name: "Lucario-Mega-Z",
    cost: 17,
    anchor:
      "Provisional: 164 Special Attack, 151 Speed and setup; Aura Guard halves contact damage, but Ground and special Fire remain threats",
  },
  {
    name: "Baxcalibur",
    cost: 13,
    anchor:
      "Provisional: strong Ice offense and setup with Clear Amulet access; below Dragonite (14), with fixed defensive typing",
  },
  {
    name: "Absol-Mega-Z",
    cost: 15,
    anchor:
      "Provisional: 151 Speed, Sharpness dual STAB and Fake Out immunity; fragile and unable to hold Focus Sash or Clear Amulet",
  },
  {
    name: "Golisopod-Mega",
    cost: 14,
    anchor:
      "Provisional: Bug/Steel bulk, Tough Claws, priority and Wide Guard; cf. Mega Scizor (13), with Fire and Psychic Terrain limitations",
  },
  {
    name: "Indeedee",
    cost: 12,
    anchor: "Provisional: Psychic Surge and Expanding Force; cf. Farigiraf (18) without Follow Me",
  },
  {
    name: "Salamence",
    cost: 11,
    anchor: "Provisional: Intimidate and Tailwind; cf. Dragonite (14)",
  },
  {
    name: "Persian-Alola",
    cost: 11,
    anchor:
      "Provisional: fast Fake Out, Parting Shot and Fur Coat; cf. Raichu (10) and Sableye (11)",
  },
  {
    name: "Pawmot",
    cost: 11,
    anchor:
      "Provisional: Fake Out, Nuzzle, Encore, Revival Blessing and offense; cf. Raichu (10), with limited defensive staying power",
  },
  {
    name: "Cinderace",
    cost: 8,
    anchor:
      "Provisional: fast Libero offense and pivoting; situational Court Change, below Meowscarada (12)",
  },
  {
    name: "Arboliva",
    cost: 6,
    anchor:
      "Provisional: slow special offense, Strength Sap, Pollen Puff and terrain interaction; needs support, below Vileplume (8)",
  },
  {
    name: "Perrserker",
    cost: 5,
    anchor:
      "Provisional: Fake Out and Steely Spirit support for a Steel partner; limited speed and special bulk, cf. Scrafty (3)",
  },
  {
    name: "Toxtricity",
    cost: 6,
    anchor:
      "Provisional: Punk Rock spread offense and Shift Gear; awkward speed, bulk and ally positioning",
  },
  {
    name: "Toxtricity-Low-Key",
    cost: 6,
    anchor: "Provisional: Punk Rock spread offense; cf. Toxtricity (6)",
  },
  {
    name: "Golisopod",
    cost: 6,
    anchor:
      "Provisional: First Impression and Wide Guard, limited by Emergency Exit; cf. Araquanid",
  },
  {
    name: "Inteleon",
    cost: 5,
    anchor: "Provisional: fast special Water offense and Icy Wind, but fragile; cf. Greninja (7)",
  },
  {
    name: "Pincurchin",
    cost: 4,
    anchor:
      "Provisional: Electric Surge and slow terrain denial; limited independent value, cf. Arboliva (6)",
  },
  {
    name: "Sirfetch’d",
    cost: 6,
    anchor:
      "Provisional: Scrappy, Leek crit pressure and First Impression; slow, specialized Fighting offense",
  },
  {
    name: "Mabosstiff",
    cost: 4,
    anchor: "Provisional: Intimidate or Stakeout, limited speed; cf. Scrafty",
  },
  {
    name: "Persian",
    cost: 5,
    anchor:
      "Provisional: fast Fake Out and utility; cf. Persian-Alola (11) without Fur Coat or Parting Shot",
  },
  {
    name: "Mr. Mime",
    cost: 6,
    anchor:
      "Provisional: Fake Out, Wide Guard, Trick Room and coverage; useful support despite low HP",
  },
  {
    name: "Squawkabilly",
    cost: 4,
    anchor: "Provisional: Intimidate, Parting Shot and Tailwind; cf. Staraptor (10)",
  },
  {
    name: "Squawkabilly-Blue",
    cost: 4,
    anchor: "Provisional: same battle options as Squawkabilly (4)",
  },
  {
    name: "Squawkabilly-Yellow",
    cost: 4,
    anchor: "Provisional: Sheer Force replaces Guts; cf. Squawkabilly (4)",
  },
  {
    name: "Squawkabilly-White",
    cost: 4,
    anchor: "Provisional: same battle options as Squawkabilly-Yellow (4)",
  },
  {
    name: "Thievul",
    cost: 3,
    anchor: "Provisional: Stakeout or Unburden and Parting Shot; cf. Persian (5)",
  },
  {
    name: "Grapploct",
    cost: 2,
    anchor: "Provisional: slow Coaching and Octolock niche; below Passimian (3)",
  },
  {
    name: "Gogoat",
    cost: 3,
    anchor: "Provisional: Grass Pelt and ally-targeting Milk Drink; cf. Arboliva (6)",
  },
  {
    name: "Wigglytuff",
    cost: 3,
    anchor: "Provisional: Competitive and Helping Hand, limited defenses; cf. Audino",
  },
  { name: "Swalot", cost: 2, anchor: "Provisional: slow Poison support; cf. Muk" },
  {
    name: "Farfetch’d",
    cost: 1,
    anchor: "Provisional: Leek and support with low base stats; cf. Sirfetch’d (6)",
  },
];

/** Reprice prior Reg M-A entries against Reg M-B ladder usage by quantile-matching usage rank to the
 * board's cost distribution and moving halfway to the target. */
const USAGE_ADJUSTMENTS: Array<{ name: string; cost: number; usage: string }> = [
  { name: "Farigiraf", cost: 18, usage: "#7 at 20.72%" },
  { name: "Pelipper", cost: 18, usage: "#8 at 18.58%" },
  { name: "Grimmsnarl", cost: 16, usage: "#13 at 14.74%" },
  { name: "Staraptor-Mega", cost: 14, usage: "#14 at 14.65%" },
  { name: "Gholdengo", cost: 16, usage: "#18 at 11.61%" },
  { name: "Mawile-Mega", cost: 14, usage: "#19 at 10.03%" },
  { name: "Raichu-Mega-Y", cost: 14, usage: "#21 at 9.54%" },
  { name: "Sableye", cost: 14, usage: "#24 at 5.87%" },
  { name: "Annihilape", cost: 14, usage: "#28 at 4.97%" },
  { name: "Pyroar-Mega", cost: 13, usage: "#31 at 4.67%" },
  { name: "Froslass-Mega", cost: 17, usage: "#33 at 3.87%" },
  { name: "Gengar-Mega", cost: 18, usage: "#35 at 3.35%" },
  { name: "Staraptor", cost: 10, usage: "#37 at 3.07%" },
  { name: "Scrafty-Mega", cost: 11, usage: "#39 at 2.99%" },
  { name: "Ceruledge", cost: 12, usage: "#42 at 2.66%" },
  { name: "Sceptile-Mega", cost: 12, usage: "#46 at 2.46%" },
  { name: "Tyranitar-Mega", cost: 16, usage: "#47 at 2.45%" },
  { name: "Eelektross-Mega", cost: 12, usage: "#48 at 2.41%" },
  { name: "Toxapex", cost: 8, usage: "#50 at 2.25%" },
  { name: "Kangaskhan", cost: 10, usage: "#53 at 1.97%" },
  { name: "Tsareena", cost: 11, usage: "#54 at 1.97%" },
  { name: "Typhlosion-Hisui", cost: 11, usage: "#55 at 1.89%" },
  { name: "Vivillon", cost: 12, usage: "#56 at 1.82%" },
  { name: "Vileplume", cost: 8, usage: "#57 at 1.79%" },
  { name: "Raichu-Mega-X", cost: 11, usage: "#59 at 1.68%" },
  { name: "Gardevoir-Mega", cost: 16, usage: "#60 at 1.67%" },
  { name: "Dragalge-Mega", cost: 10, usage: "#65 at 1.60%" },
  { name: "Dragonite", cost: 14, usage: "#68 at 1.55%" },
  { name: "Lycanroc-Dusk", cost: 8, usage: "#69 at 1.50%" },
  { name: "Dragapult", cost: 14, usage: "#70 at 1.50%" },
  { name: "Glimmora-Mega", cost: 14, usage: "#71 at 1.48%" },
  { name: "Kangaskhan-Mega", cost: 15, usage: "#72 at 1.46%" },
  { name: "Gallade", cost: 10, usage: "#74 at 1.42%" },
  { name: "Aegislash", cost: 14, usage: "#76 at 1.36%" },
  { name: "Volcarona", cost: 14, usage: "#77 at 1.33%" },
  { name: "Arcanine-Hisui", cost: 13, usage: "#78 at 1.21%" },
  { name: "Tyranitar", cost: 14, usage: "#79 at 1.21%" },
  { name: "Meganium-Mega", cost: 12, usage: "#82 at 1.06%" },
  { name: "Scizor-Mega", cost: 13, usage: "#86 at 0.84%" },
  { name: "Lopunny-Mega", cost: 14, usage: "#87 at 0.75%" },
  { name: "Gyarados-Mega", cost: 12, usage: "#99 at 0.51%" },
  { name: "Charizard-Mega-X", cost: 12, usage: "#107 at 0.46%" },
  { name: "Gyarados", cost: 11, usage: "#109 at 0.44%" },
  { name: "Garchomp-Mega", cost: 12, usage: "#110 at 0.42%" },
  { name: "Starmie-Mega", cost: 12, usage: "#116 at 0.37%" },
  { name: "Rotom-Mow", cost: 10, usage: "#122 at 0.34%" },
  { name: "Arcanine", cost: 11, usage: "#131 at 0.27%" },
  { name: "Tauros-Paldea-Aqua", cost: 9, usage: "#140 at 0.23%" },
  { name: "Golurk-Mega", cost: 8, usage: "#144 at 0.23%" },
  { name: "Lucario-Mega", cost: 11, usage: "#147 at 0.22%" },
  { name: "Clefable-Mega", cost: 10, usage: "#154 at 0.19%" },
  { name: "Greninja-Mega", cost: 10, usage: "#155 at 0.19%" },
  { name: "Skarmory-Mega", cost: 9, usage: "#157 at 0.19%" },
  { name: "Liepard", cost: 8, usage: "#159 at 0.18%" },
  { name: "Hawlucha-Mega", cost: 8, usage: "#164 at 0.15%" },
  { name: "Manectric-Mega", cost: 8, usage: "#186 at 0.10%" },
  { name: "Excadrill-Mega", cost: 9, usage: "#188 at 0.09%" },
  { name: "Alakazam-Mega", cost: 8, usage: "#190 at 0.09%" },
  { name: "Gallade-Mega", cost: 8, usage: "#192 at 0.08%" },
  { name: "Floette-Eternal", cost: 8, usage: "#206 at 0.06%" },
  { name: "Salazzle", cost: 7, usage: "#208 at 0.06%" },
  { name: "Medicham-Mega", cost: 8, usage: "#209 at 0.06%" },
];

const REGMC_CARRYOVER_PRICES = [
  {
    name: "Metagross",
    cost: 10,
    anchor: "Clear Body, item flexibility and bulky Steel offense; Smogon 12",
  },
  { name: "Garchomp-Mega", cost: 14, anchor: "Matchup-specific secondary Mega; Smogon 16" },
  {
    name: "Mawile-Mega",
    cost: 16,
    anchor: "Intimidate into Huge Power and useful defensive typing; Smogon 17",
  },
  {
    name: "Blaziken-Mega",
    cost: 14,
    anchor: "Speed Boost offense with draft-specific coverage; Smogon 14",
  },
  { name: "Lucario-Mega", cost: 13, anchor: "Adaptability offense as a secondary Mega; Smogon 13" },
  {
    name: "Aegislash",
    cost: 16,
    anchor: "Flexible Steel/Ghost offense, defenses and Wide Guard; Smogon 16",
  },
  { name: "Liepard", cost: 10, anchor: "Fast Fake Out and Prankster disruption; Smogon 10" },
  {
    name: "Blastoise-Mega",
    cost: 14,
    anchor: "Partial reduction from 17 for Mega-slot competition; Smogon 11",
  },
  {
    name: "Tyranitar-Mega",
    cost: 14,
    anchor: "Sand and bulk retain value despite Mega-slot competition; Smogon 12",
  },
  {
    name: "Dragalge-Mega",
    cost: 8,
    anchor: "Specialized slow attacker with limited flexibility; Smogon 6",
  },
  {
    name: "Camerupt-Mega",
    cost: 8,
    anchor: "Powerful but support-dependent Trick Room attacker; Smogon 6",
  },
  { name: "Altaria-Mega", cost: 7, anchor: "Niche Mega with limited immediate pressure; Smogon 5" },
  {
    name: "Azumarill",
    cost: 10,
    anchor: "Strong physical Water/Fairy with speed and setup constraints; Smogon 8",
  },
  {
    name: "Kangaskhan",
    cost: 7,
    anchor: "Scrappy Fake Out niche without its Mega's power; Smogon 6",
  },
  {
    name: "Sableye",
    cost: 11,
    anchor: "Prankster utility without a broad offensive role; Smogon 11",
  },
  { name: "Toxapex", cost: 5, anchor: "Narrow defensive matchup pick with low pressure; Smogon 5" },
  {
    name: "Pelipper",
    cost: 16,
    anchor: "Retains a weather-enabler premium in ten-pick rosters; Smogon 14",
  },
];

const BOARD_ALIASES = new Map([
  ["Mega Charizard X", "Charizard-Mega-X"],
  ["Mega Charizard Y", "Charizard-Mega-Y"],
  ["Basculegion-Male", "Basculegion"],
  ["Basculegion-Female", "Basculegion-F"],
  ["Meowstic-Male", "Meowstic"],
  ["Meowstic-Female", "Meowstic-F"],
  ["Paldean Tauros", "Tauros-Paldea-Combat"],
  ["Paldean Tauros Aqua", "Tauros-Paldea-Aqua"],
  ["Paldean Tauros Blaze", "Tauros-Paldea-Blaze"],
]);

function dexNameFor(boardName: string): string {
  const alias = BOARD_ALIASES.get(boardName);
  if (alias) return alias;
  const name = boardName.startsWith("Mega ") ? `${boardName.slice(5)}-Mega` : boardName;
  return name
    .replace(/^Hisuian (.+)$/, "$1-Hisui")
    .replace(/^Alolan (.+)$/, "$1-Alola")
    .replace(/^Galarian (.+)$/, "$1-Galar");
}

interface BoardEntrySource {
  name: string;
  cost: number;
  origin: DraftBoardMon["origin"];
  anchor?: string;
}

const baseCostsSchema = z.array(z.object({ name: z.string(), cost: z.number() }));

function displayName(dexName: string): string {
  const mega = /^(.+?)-Mega(?:-([XYZ]))?$/.exec(dexName);
  if (!mega) return dexName;
  return `Mega ${mega[1]}${mega[2] ? ` ${mega[2]}` : ""}`;
}

function buildBoard(boardId = "regmc-202609", format = "gen9championsvgc2026regmcbo3"): string {
  const psDir = defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const resolvedFormat = Dex.formats.get(format);
  if (!resolvedFormat.exists) throw new Error(`unknown format ${format}`);
  const dex = Dex.mod(resolvedFormat.mod || "base");

  const stoneFor = new Map<string, { item: string; from: string }>();
  for (const item of dex.items.all()) {
    if (item.isNonstandard) continue;
    const map = item.megaStone;
    if (!map) continue;
    for (const [from, to] of Object.entries(map)) stoneFor.set(to, { item: item.name, from });
  }

  const baseCosts = baseCostsSchema.parse(JSON.parse(fs.readFileSync(SOURCE_COSTS, "utf8")));
  const sources: BoardEntrySource[] = [
    ...baseCosts.map((entry): BoardEntrySource => ({
      name: entry.name,
      cost: entry.cost,
      origin: "base",
    })),
    ...REGMB_ADDITIONS.map((entry): BoardEntrySource => ({ ...entry, origin: "regmb" })),
    ...REGMC_ADDITIONS.map((entry): BoardEntrySource => ({ ...entry, origin: "regmc" })),
  ];

  const adjustments = new Map<string, { cost: number; usage: string }>();
  for (const entry of USAGE_ADJUSTMENTS) {
    if (!dex.species.get(entry.name).exists)
      throw new Error(`usage adjustment ${entry.name} is not in the dex`);
    adjustments.set(entry.name, { cost: entry.cost, usage: entry.usage });
  }

  const seen = new Set<string>();
  const mons: DraftBoardMon[] = [];
  for (const source of sources) {
    const species = dex.species.get(dexNameFor(source.name));
    if (!species.exists)
      throw new Error(`board entry ${JSON.stringify(source.name)} is not in the format dex`);
    if (species.isNonstandard)
      throw new Error(`board entry ${JSON.stringify(source.name)} is not standard`);
    if (seen.has(species.name)) throw new Error(`duplicate board entry for ${species.name}`);
    seen.add(species.name);

    const stone = stoneFor.get(species.name);
    const registered = stone ? dex.species.get(stone.from) : species;
    const adjusted = adjustments.get(species.name);
    if (adjusted) adjustments.delete(species.name);
    const mon: DraftBoardMon = {
      id: species.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: source.origin === "base" ? source.name : displayName(species.name),
      species: registered.name,
      base: registered.baseSpecies,
      types: species.types,
      cost: adjusted ? adjusted.cost : source.cost,
      origin: source.origin,
    };
    if (stone) {
      mon.forme = species.name;
      mon.item = stone.item;
    }
    if (source.anchor) mon.anchor = source.anchor;
    if (adjusted) {
      mon.listed = source.cost;
      mon.usage = adjusted.usage;
    }
    mons.push(mon);
  }
  if (adjustments.size)
    throw new Error(`unused usage adjustments: ${[...adjustments.keys()].join(", ")}`);
  for (const entry of REGMC_CARRYOVER_PRICES) {
    const mon = mons.find((mon) => (mon.forme || mon.species) === entry.name);
    if (!mon) throw new Error(`carryover price ${entry.name} is not on the board`);
    mon.cost = entry.cost;
    mon.anchor = `M-C draft correction: ${entry.anchor}`;
  }
  mons.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));

  const board = {
    id: boardId,
    format,
    budget: 100,
    picks: 10,
    source:
      "Reg M-C launch board. Earlier costs and historical M-B usage inform the baseline, with draft-specific carryover corrections and provisional M-C additions recorded in pricing anchors. Smogon comparisons use the July 25 VGC council review informed by the M-B Kickoff (90 points, eight picks, closed sheets), not post-finals prices: https://docs.google.com/spreadsheets/d/1q29XzWsljFjyuCcfbSeursvKi42joojilATgkaGwuMw/edit?gid=1183070207. Retained usage figures are M-B history, not M-C rankings.",
    mons,
  };
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const file = path.join(BOARDS_DIR, `${boardId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = buildBoard();
  const board = draftBoardSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const added = board.mons.filter((mon) => mon.origin === "regmc").length;
  const megas = board.mons.filter((mon) => mon.item).length;
  console.log(
    `${file}: ${board.mons.length} entries (${added} new in Reg M-C), ${megas} megas, costs ${Math.min(...board.mons.map((mon) => mon.cost))}-${Math.max(...board.mons.map((mon) => mon.cost))}`,
  );
}
