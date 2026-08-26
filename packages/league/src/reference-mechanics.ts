import type { Battle, Dex } from "pokemon-showdown";

import type { MatchupMon } from "./reference-contracts.js";

export function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function canonicalWeather(value: string): string {
  return id(value.replace(/\s*\(\d+\s+turns?\s+left\)\s*$/i, ""));
}

export function uniqueNames(values: Array<string | null | undefined>): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const clean = value?.trim();
    if (clean) names.set(id(clean), names.get(id(clean)) ?? clean);
  }
  return [...names.values()].sort((a, b) => id(a).localeCompare(id(b)));
}

const TYPE_BLOCKING_ABILITIES = new Map(
  Object.entries({
    ground: ["levitate", "eartheater"],
    fire: ["flashfire", "wellbakedbody"],
    water: ["waterabsorb", "stormdrain", "dryskin"],
    electric: ["voltabsorb", "lightningrod", "motordrive"],
    grass: ["sapsipper"],
  }),
);

export function visibleDamageBlock(
  attacker: MatchupMon,
  defender: MatchupMon,
  move: { flags: { sound?: 1; bullet?: 1; wind?: 1 }; ignoreAbility?: boolean | undefined },
  moveType: string,
  modifier: number,
): string | undefined {
  if (
    id(defender.item ?? "") === "airballoon" &&
    !defender.itemConsumed &&
    id(moveType) === "ground"
  ) {
    return defender.item;
  }
  const attackerAbility = id(attacker.ability ?? "");
  const ignoresAbility =
    move.ignoreAbility || ["moldbreaker", "teravolt", "turboblaze"].includes(attackerAbility);
  if (ignoresAbility) return undefined;
  const ability = id(defender.ability ?? "");
  if ((TYPE_BLOCKING_ABILITIES.get(id(moveType)) ?? []).includes(ability)) return defender.ability;
  if (ability === "soundproof" && move.flags.sound) return defender.ability;
  if (ability === "bulletproof" && move.flags.bullet) return defender.ability;
  if (ability === "windrider" && move.flags.wind) return defender.ability;
  if (ability === "wonderguard" && modifier <= 1) return defender.ability;
  return undefined;
}

export function cleanDescription(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

export function baseStats(stats: Dex.StatsTable): string {
  return `base stats HP ${stats.hp}, Attack ${stats.atk}, Defense ${stats.def}, Special Attack ${stats.spa}, Special Defense ${stats.spd}, Speed ${stats.spe}`;
}

export const STAT_IDS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
export const BOOST_IDS = ["atk", "def", "spa", "spd", "spe", "accuracy", "evasion"] as const;
export type StatId = "hp" | "atk" | "def" | "spa" | "spd" | "spe";
type BattleStatCalculator = Pick<Battle, "dex" | "ruleTable" | "statModify">;
export type PokemonSet = Parameters<Battle["statModify"]>[1];

export function filledStats(value: number): Dex.StatsTable {
  return { hp: value, atk: value, def: value, spa: value, spd: value, spe: value };
}

function investedStats(stat: StatId, value: number): Dex.StatsTable {
  return {
    hp: stat === "hp" ? value : 0,
    atk: stat === "atk" ? value : 0,
    def: stat === "def" ? value : 0,
    spa: stat === "spa" ? value : 0,
    spd: stat === "spd" ? value : 0,
    spe: stat === "spe" ? value : 0,
  };
}

export function investmentLimits(battle: BattleStatCalculator) {
  const champions = battle.dex.currentMod.startsWith("champions");
  const total = battle.ruleTable.evLimit;
  return {
    perStat: champions ? 32 : total === 0 ? 0 : Math.min(252, total ?? 252),
    total,
    fixedIvs: champions,
  };
}

export function statSet(
  battle: BattleStatCalculator,
  nature: string,
  evs: Dex.StatsTable,
  ivs: Dex.StatsTable,
): PokemonSet {
  const level =
    battle.ruleTable.adjustLevel ??
    battle.ruleTable.adjustLevelDown ??
    battle.ruleTable.defaultLevel ??
    battle.ruleTable.maxLevel ??
    100;
  return {
    name: "",
    species: "",
    item: "",
    ability: "",
    moves: [],
    nature,
    gender: "",
    evs,
    ivs,
    level,
  };
}

export function statRange(
  battle: BattleStatCalculator,
  stats: Dex.StatsTable,
  nature: { name: string } | undefined,
  statName: Exclude<StatId, "hp">,
): [number, number] {
  const limits = investmentLimits(battle);
  const natures = battle.dex.natures.all();
  const lowNature =
    nature?.name ??
    natures.find((entry: { minus?: string; name: string }) => entry.minus === statName)?.name ??
    "Serious";
  const highNature =
    nature?.name ??
    natures.find((entry: { plus?: string; name: string }) => entry.plus === statName)?.name ??
    "Serious";
  const lowEvs = filledStats(0);
  const highEvs = investedStats(statName, limits.perStat);
  const lowIvs = filledStats(limits.fixedIvs ? 31 : 0);
  const highIvs = filledStats(31);
  return [
    battle.statModify(stats, statSet(battle, lowNature, lowEvs, lowIvs), statName),
    battle.statModify(stats, statSet(battle, highNature, highEvs, highIvs), statName),
  ];
}

export function hpRange(battle: BattleStatCalculator, stats: Dex.StatsTable): [number, number] {
  const limits = investmentLimits(battle);
  const lowEvs = filledStats(0);
  const highEvs = investedStats("hp", limits.perStat);
  const lowIvs = filledStats(limits.fixedIvs ? 31 : 0);
  const highIvs = filledStats(31);
  return [
    battle.statModify(stats, statSet(battle, "Serious", lowEvs, lowIvs), "hp"),
    battle.statModify(stats, statSet(battle, "Serious", highEvs, highIvs), "hp"),
  ];
}

export function effectivenessLabel(modifier: number): string {
  if (modifier === 0) return "immune (0x)";
  if (modifier === 1) return "neutral (1x)";
  if (modifier === 2) return "super-effective (2x)";
  if (modifier === 4) return "super-effective (4x)";
  if (modifier === 0.5) return "not very effective (0.5x)";
  if (modifier === 0.25) return "not very effective (0.25x)";
  return `${modifier}x`;
}

export function effectivenessDetail(
  dex: {
    getImmunity: (source: string, target: string[]) => boolean;
    getEffectiveness: (source: string, target: string[]) => number;
  },
  attackType: string,
  defenderTypes: string[],
): string {
  const modifier = typeModifier(dex, attackType, defenderTypes);
  const parts = defenderTypes.map((type) => `vs ${type} ${typeModifier(dex, attackType, [type])}x`);
  return `${effectivenessLabel(modifier)} = ${attackType} ${parts.join(" × ")}`;
}

export function typeModifier(
  dex: {
    getImmunity: (source: string, target: string[]) => boolean;
    getEffectiveness: (source: string, target: string[]) => number;
  },
  attackType: string,
  defenderTypes: string[],
): number {
  if (!dex.getImmunity(attackType, defenderTypes)) return 0;
  return 2 ** dex.getEffectiveness(attackType, defenderTypes);
}

const WEATHER_BALL_TYPE = new Map(
  Object.entries({
    sun: "Fire",
    sunnyday: "Fire",
    desolateland: "Fire",
    rain: "Water",
    raindance: "Water",
    primordialsea: "Water",
    sand: "Rock",
    sandstorm: "Rock",
    snow: "Ice",
    snowscape: "Ice",
    hail: "Ice",
  }),
);

export function weatherBallOverride(
  moveId: string,
  weather: string,
): { type: string; power: number } | null {
  const type = WEATHER_BALL_TYPE.get(weather);
  return moveId === "weatherball" && type ? { type, power: 100 } : null;
}

const RAGING_BULL_TYPE = new Map(
  Object.entries({
    taurospaldeacombat: "Fighting",
    taurospaldeablaze: "Fire",
    taurospaldeaaqua: "Water",
  }),
);

const ATE_ABILITY_TYPE = new Map(
  Object.entries({
    pixilate: "Fairy",
    aerilate: "Flying",
    refrigerate: "Ice",
    galvanize: "Electric",
  }),
);

export function speciesMoveType(
  moveId: string,
  defaultType: string,
  speciesName: string,
  ability = "",
  soundMove = false,
): string {
  if (moveId === "ragingbull") return RAGING_BULL_TYPE.get(id(speciesName)) ?? defaultType;
  const abilityId = id(ability);
  if (abilityId === "normalize") return "Normal";
  if (defaultType === "Normal") {
    const convertedType = ATE_ABILITY_TYPE.get(abilityId);
    if (convertedType) return convertedType;
  }
  if (abilityId === "liquidvoice" && soundMove) return "Water";
  return defaultType;
}

export const SPEED_HALVING_ITEMS = new Set([
  "ironball",
  "machobrace",
  "poweranklet",
  "powerband",
  "powerbelt",
  "powerbracer",
  "powerlens",
  "powerweight",
]);

export function modifyRange(
  range: [number, number],
  numerator: number,
  denominator = 1,
): [number, number] {
  return [
    Math.max(1, Math.floor((range[0] * numerator) / denominator)),
    Math.max(1, Math.floor((range[1] * numerator) / denominator)),
  ];
}

export const TARGET_TAGS = new Map(
  Object.entries({
    allAdjacentFoes: "spread",
    allAdjacent: "spread+ally",
    self: "self",
    adjacentAlly: "ally",
    adjacentAllyOrSelf: "ally/self",
    allySide: "ally-side",
    allyTeam: "ally-side",
    allies: "ally-side",
    foeSide: "foe-side",
    all: "field",
    any: "any-range",
    randomNormal: "random-foe",
  }),
);
