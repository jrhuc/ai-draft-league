import type { Battle, Dex } from "pokemon-showdown";
import { z } from "zod";

import type { ShowdownApi } from "./showdown.js";
import {
  BOOST_IDS,
  canonicalWeather,
  effectivenessDetail,
  filledStats,
  hpRange,
  id,
  investmentLimits,
  type PokemonSet,
  STAT_IDS,
  statRange,
  statSet,
  type StatId,
  typeModifier,
} from "./reference-mechanics.js";

type FormatDataKind = "move" | "item";
type ReferenceDex = ReturnType<ShowdownApi["Dex"]["forFormat"]>;
type ResolvedFormat = ReturnType<ShowdownApi["Dex"]["formats"]["get"]>;

export interface ReferenceCalculationContext {
  format: string;
  dex: ReferenceDex;
  battle: Battle;
  showdown: ShowdownApi;
  resolvedFormat: ResolvedFormat;
  getSpecies(name: string): Dex.Species;
  formatLegalityError(kind: FormatDataKind, name: string): string | null;
}

const optionalStringSchema = z.string().optional().catch(undefined);
const optionalNumberSchema = z.number().finite().optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const optionalJsonSchema = z.json().optional();
const stageSchema = z.number().int().min(-6).max(6);
const statInputSchema = z
  .object({
    hp: optionalNumberSchema,
    atk: optionalNumberSchema,
    def: optionalNumberSchema,
    spa: optionalNumberSchema,
    spd: optionalNumberSchema,
    spe: optionalNumberSchema,
  })
  .optional()
  .catch(undefined);
const boostInputSchema = z.object({
  atk: stageSchema.optional(),
  def: stageSchema.optional(),
  spa: stageSchema.optional(),
  spd: stageSchema.optional(),
  spe: stageSchema.optional(),
});
const screenInputSchema = z.array(z.string());

export const lookupSpeciesArgumentsSchema = z.object({
  name: z.string().catch(""),
  item: optionalStringSchema,
  nature: optionalStringSchema,
});

export const matchupArgumentsSchema = z.object({
  attacker: z.string().catch(""),
  attacker_type: z.string().catch(""),
  move: z.string().catch(""),
  defender: z.string().catch(""),
});

export const calculateStatsArgumentsSchema = z.object({
  species: z.string().catch(""),
  nature: z.string().catch(""),
  evs: statInputSchema,
});

export const estimateDamageArgumentsSchema = z.object({
  attacker: z.string().catch(""),
  defender: z.string().catch(""),
  move: z.string().catch(""),
  attacker_item: optionalStringSchema,
  defender_item: optionalStringSchema,
  attacker_ability: optionalStringSchema,
  defender_ability: optionalStringSchema,
  attacker_status: optionalStringSchema,
  defender_status: optionalStringSchema,
  attacker_nature: optionalStringSchema,
  defender_nature: optionalStringSchema,
  attacker_boosts: optionalJsonSchema,
  defender_boosts: optionalJsonSchema,
  attacker_stats: statInputSchema,
  defender_stats: statInputSchema,
  defender_screens: optionalJsonSchema,
  weather: optionalStringSchema,
  terrain: optionalStringSchema,
  is_spread_hit: optionalBooleanSchema,
  is_critical_hit: optionalBooleanSchema,
  helping_hand: optionalBooleanSchema,
  attacker_hp_percent: optionalNumberSchema,
  defender_hp_percent: optionalNumberSchema,
  attacker_fainted_allies: optionalNumberSchema,
  attacker_ally: optionalStringSchema,
  defender_ally: optionalStringSchema,
  attacker_ally_ability: optionalStringSchema,
  defender_ally_ability: optionalStringSchema,
  attacker_ally_item: optionalStringSchema,
  defender_ally_item: optionalStringSchema,
});

type StatBoosts = z.infer<typeof boostInputSchema>;
export type CalculateStatsArguments = z.infer<typeof calculateStatsArgumentsSchema>;
export type MatchupArguments = z.infer<typeof matchupArgumentsSchema>;
export type EstimateDamageArguments = z.infer<typeof estimateDamageArgumentsSchema>;

interface ScratchAlly {
  name: string;
  ability?: string | undefined;
  item?: string | undefined;
}

interface ScratchDamage {
  outcome: "immune" | "none" | "damage";
  damage: number;
  moveType: string;
  basePower: number;
  hits: [number, number];
}

interface ScratchDamageConfig {
  attacker: Dex.Species;
  defender: Dex.Species;
  moveId: string;
  attackerAbility?: string | undefined;
  defenderAbility?: string | undefined;
  attackerItem?: string | undefined;
  defenderItem?: string | undefined;
  pins: {
    offFromDefender: boolean;
    offStat: Exclude<StatId, "hp">;
    offValue: number;
    defStat: Exclude<StatId, "hp">;
    defValue: number;
  };
  attackerBoosts: StatBoosts;
  defenderBoosts: StatBoosts;
  defenderMaxHp?: number | undefined;
  attackerStatus?: string | undefined;
  defenderStatus?: string | undefined;
  screens: string[];
  weather?: string | undefined;
  terrain?: string | undefined;
  helpingHand: boolean;
  faintedAllies: number;
  attackerAlly?: ScratchAlly | undefined;
  defenderAlly?: ScratchAlly | undefined;
  crit: boolean;
  spread: boolean;
  attackerHpPercent?: number | undefined;
  defenderHpPercent?: number | undefined;
  rollPercent: 85 | 100;
}

const WEATHER_IDS = new Map(
  Object.entries({
    sun: "sunnyday",
    sunnyday: "sunnyday",
    harshsunlight: "sunnyday",
    rain: "raindance",
    raindance: "raindance",
    sand: "sandstorm",
    sandstorm: "sandstorm",
    snow: "snowscape",
    snowscape: "snowscape",
    hail: "snowscape",
    desolateland: "desolateland",
    extremelyharshsunlight: "desolateland",
    primordialsea: "primordialsea",
    heavyrain: "primordialsea",
    deltastream: "deltastream",
    strongwinds: "deltastream",
  }),
);

const TERRAIN_IDS = new Map(
  Object.entries({
    electric: "electricterrain",
    electricterrain: "electricterrain",
    grassy: "grassyterrain",
    grassyterrain: "grassyterrain",
    misty: "mistyterrain",
    mistyterrain: "mistyterrain",
    psychic: "psychicterrain",
    psychicterrain: "psychicterrain",
  }),
);

const STATUS_IDS = new Map(
  Object.entries({
    brn: "brn",
    burn: "brn",
    burned: "brn",
    par: "par",
    paralysis: "par",
    paralyzed: "par",
    psn: "psn",
    poison: "psn",
    poisoned: "psn",
    tox: "tox",
    toxic: "tox",
    badlypoisoned: "tox",
    slp: "slp",
    sleep: "slp",
    asleep: "slp",
    frz: "frz",
    freeze: "frz",
    frozen: "frz",
  }),
);

const STATUS_WORDS = new Map(
  Object.entries({
    brn: "burned",
    par: "paralyzed",
    psn: "poisoned",
    tox: "badly poisoned",
    slp: "asleep",
    frz: "frozen",
  }),
);

const SCREEN_IDS = new Map(
  Object.entries({
    reflect: "reflect",
    lightscreen: "lightscreen",
    auroraveil: "auroraveil",
  }),
);

const SCREEN_WORDS = new Map(
  Object.entries({
    reflect: "Reflect",
    lightscreen: "Light Screen",
    auroraveil: "Aurora Veil",
  }),
);

const WEATHER_WORDS = new Map(
  Object.entries({
    sunnyday: "sun",
    raindance: "rain",
    sandstorm: "sand",
    snowscape: "snow",
    desolateland: "Desolate Land",
    primordialsea: "Primordial Sea",
    deltastream: "Delta Stream",
  }),
);

const TERRAIN_WORDS = new Map(
  Object.entries({
    electricterrain: "Electric Terrain",
    grassyterrain: "Grassy Terrain",
    mistyterrain: "Misty Terrain",
    psychicterrain: "Psychic Terrain",
  }),
);

function emptyBoosts(): StatBoosts {
  return {};
}

export function calculateStats(
  context: ReferenceCalculationContext,
  args: CalculateStatsArguments,
): string {
  const speciesName = args.species;
  const natureName = args.nature;
  if (!speciesName.trim() || !natureName.trim() || !args.evs) {
    return "species, nature, and evs are required.";
  }
  const species = context.getSpecies(speciesName);
  if (!species.exists)
    return `No species data for ${JSON.stringify(speciesName)} in ${context.format}.`;
  const nature = context.dex.natures.get(natureName);
  if (!nature.exists)
    return `No nature data for ${JSON.stringify(natureName)} in ${context.format}.`;
  const limits = investmentLimits(context.battle);
  const evs = { ...filledStats(0), ...args.evs };
  for (const stat of STAT_IDS) {
    if (!Number.isInteger(evs[stat]) || evs[stat] < 0 || evs[stat] > limits.perStat) {
      return `${stat} investment must be an integer from 0 to ${limits.perStat}.`;
    }
  }
  const total = STAT_IDS.reduce((sum, stat) => sum + evs[stat], 0);
  if (limits.total !== null && total > limits.total) {
    return `Total investment ${total} exceeds this format's limit of ${limits.total}.`;
  }
  const stats = context.battle.spreadModify(
    species.baseStats,
    statSet(context.battle, nature.name, evs, filledStats(31)),
  );
  const label = limits.fixedIvs ? "Stat Points" : "EVs";
  return `${species.name} (${nature.name}; ${label} ${total}${limits.total === null ? "" : `/${limits.total}`}): HP ${stats.hp}, Attack ${stats.atk}, Defense ${stats.def}, Special Attack ${stats.spa}, Special Defense ${stats.spd}, Speed ${stats.spe}.`;
}

function implausibleStat(
  context: ReferenceCalculationContext,
  species: Dex.Species,
  stat: Exclude<StatId, "hp">,
  value: number,
  label: string,
): string | null {
  const [low, high] = statRange(context.battle, species.baseStats, undefined, stat);
  return value < Math.floor(low / 4) || value > high * 4
    ? `${label} ${value} is implausible for ${species.name}: legal raw ${stat} spans ${low}-${high}, and stat stages reach x0.25-x4.`
    : null;
}

export function estimateDamage(
  context: ReferenceCalculationContext,
  args: EstimateDamageArguments,
): string {
  const attackerName = args.attacker;
  const defenderName = args.defender;
  const moveName = args.move;
  if (!attackerName.trim() || !defenderName.trim() || !moveName.trim())
    return "attacker, defender, and move are required.";
  const attacker = context.getSpecies(attackerName);
  const defender = context.getSpecies(defenderName);
  const move = context.dex.moves.get(moveName);
  if (!attacker.exists) return `No species data for ${JSON.stringify(attackerName)}.`;
  if (!defender.exists) return `No species data for ${JSON.stringify(defenderName)}.`;
  if (!move.exists) return `No move data for ${JSON.stringify(moveName)}.`;
  const moveError = context.formatLegalityError("move", moveName);
  if (moveError) return moveError;
  if (move.category === "Status") return `${move.name} is a status move; no damage estimate.`;
  if (
    !move.basePower &&
    !move.basePowerCallback &&
    !move.damage &&
    !move.damageCallback &&
    !move.ohko
  )
    return `${move.name} has no standard damage output to estimate.`;

  const notes: string[] = [];
  const items: Partial<Record<"attacker" | "defender", string>> = {};
  const abilities: Partial<Record<"attacker" | "defender", string>> = {};
  const statuses: Partial<Record<"attacker" | "defender", string>> = {};
  const natures: Partial<Record<"attacker" | "defender", { name: string }>> = {};
  const boosts = { attacker: emptyBoosts(), defender: emptyBoosts() };
  for (const side of ["attacker", "defender"] as const) {
    const itemRaw = args[`${side}_item`];
    if (itemRaw?.trim()) {
      const item = context.dex.items.get(itemRaw);
      if (!item.exists) return `No item data for ${JSON.stringify(itemRaw)}.`;
      const itemError = context.formatLegalityError("item", itemRaw);
      if (itemError) return itemError;
      items[side] = item.name;
    }
    const abilityRaw = args[`${side}_ability`];
    if (abilityRaw?.trim()) {
      const ability = context.dex.abilities.get(abilityRaw);
      if (!ability.exists) return `No ability data for ${JSON.stringify(abilityRaw)}.`;
      abilities[side] = ability.name;
      const species = side === "attacker" ? attacker : defender;
      if (!Object.values(species.abilities).some((name) => id(String(name)) === ability.id))
        notes.push(`${ability.name} is not a listed ${species.name} ability`);
    }
    const statusRaw = args[`${side}_status`];
    if (statusRaw?.trim()) {
      const status = STATUS_IDS.get(id(statusRaw));
      if (!status)
        return `Unknown ${side}_status ${JSON.stringify(statusRaw)}; accepted: brn, par, psn, tox, slp, frz.`;
      statuses[side] = status;
    }
    const natureRaw = args[`${side}_nature`];
    if (natureRaw?.trim()) {
      const nature = context.dex.natures.get(natureRaw);
      if (!nature.exists) return `No nature data for ${JSON.stringify(natureRaw)}.`;
      natures[side] = nature;
    }
    const boostsRaw = args[`${side}_boosts`];
    if (boostsRaw !== undefined && boostsRaw !== null) {
      const parsedBoosts = boostInputSchema.safeParse(boostsRaw);
      if (!parsedBoosts.success)
        return `${side}_boosts must be an object of integer stat stages from -6 to 6.`;
      boosts[side] = parsedBoosts.data;
    }
  }
  const screens: string[] = [];
  if (args.defender_screens !== undefined && args.defender_screens !== null) {
    const parsedScreens = screenInputSchema.safeParse(args.defender_screens);
    if (!parsedScreens.success) return "defender_screens must be an array of screen names.";
    for (const raw of parsedScreens.data) {
      const screen = SCREEN_IDS.get(id(raw));
      if (!screen)
        return `Unknown screen ${JSON.stringify(raw)}; accepted: reflect, lightscreen, auroraveil.`;
      if (!screens.includes(screen)) screens.push(screen);
    }
  }
  let weatherId: string | undefined;
  if (args.weather?.trim()) {
    weatherId = WEATHER_IDS.get(canonicalWeather(args.weather));
    if (!weatherId)
      return `Unknown weather ${JSON.stringify(args.weather)}; accepted: sun, rain, sand, snow, desolateland, primordialsea, deltastream.`;
  }
  let terrainId: string | undefined;
  if (args.terrain?.trim()) {
    terrainId = TERRAIN_IDS.get(id(args.terrain.replace(/\s*terrain\s*$/i, "")));
    if (!terrainId)
      return `Unknown terrain ${JSON.stringify(args.terrain)}; accepted: electric, grassy, misty, psychic.`;
  }

  const offFromDefender = move.overrideOffensivePokemon === "target";
  const offStat = move.overrideOffensiveStat ?? (move.category === "Physical" ? "atk" : "spa");
  const defStat = move.overrideDefensiveStat ?? (move.category === "Special" ? "spd" : "def");
  const offSide = offFromDefender ? "defender" : "attacker";
  const offSpecies = offFromDefender ? defender : attacker;

  const exactStat = (
    side: "attacker" | "defender",
    stat: StatId,
    species: Dex.Species,
  ): number | undefined => {
    const source = args[`${side}_stats`];
    if (!source) return undefined;
    const value = source[stat];
    if (value === undefined || value <= 0) return undefined;
    if (stat === "hp") {
      const [legalLow, legalHigh] = hpRange(context.battle, species.baseStats);
      if (value < legalLow || value > legalHigh) {
        notes.push(
          `${side}_stats.hp ${value} is outside ${species.name}'s legal HP range ${legalLow}-${legalHigh}, so the legal range was used instead`,
        );
        return undefined;
      }
      return value;
    }
    if (implausibleStat(context, species, stat, value, `${side}_stats.${stat}`)) {
      notes.push(
        `${side}_stats.${stat} ${value} is implausible for ${species.name}, so the legal range was used instead`,
      );
      return undefined;
    }
    return value;
  };
  const exactOff = exactStat(offSide, offStat, offSpecies);
  const exactDef = exactStat("defender", defStat, defender);
  const exactHp = exactStat("defender", "hp", defender);
  const [offLow, offHigh] =
    exactOff !== undefined
      ? [exactOff, exactOff]
      : statRange(context.battle, offSpecies.baseStats, natures[offSide], offStat);
  const [defLow, defHigh] =
    exactDef !== undefined
      ? [exactDef, exactDef]
      : statRange(context.battle, defender.baseStats, natures.defender, defStat);
  const [hpLow, hpHigh] =
    exactHp !== undefined ? [exactHp, exactHp] : hpRange(context.battle, defender.baseStats);

  const suppliedAttackerHp = args.attacker_hp_percent;
  const attackerHpPercent =
    suppliedAttackerHp === undefined ? undefined : Math.max(0, Math.min(100, suppliedAttackerHp));
  const suppliedHpPercent = args.defender_hp_percent;
  const hpPercent =
    suppliedHpPercent === undefined ? undefined : Math.max(0, Math.min(100, suppliedHpPercent));

  const isSpread = args.is_spread_hit === true;
  const crit = args.is_critical_hit === true;
  const helpingHand = args.helping_hand === true;
  const faintedAllies = Math.max(0, Math.trunc(args.attacker_fainted_allies ?? 0));
  const allies: Partial<Record<"attacker" | "defender", ScratchAlly>> = {};
  for (const side of ["attacker", "defender"] as const) {
    const raw = args[`${side}_ally`];
    if (!raw?.trim()) continue;
    const species = context.dex.species.get(raw);
    if (!species.exists) return `No species data for ${JSON.stringify(raw)}.`;
    const abilityRaw = args[`${side}_ally_ability`];
    const itemRaw = args[`${side}_ally_item`];
    allies[side] = {
      name: species.name,
      ability: abilityRaw?.trim() ? context.dex.abilities.get(abilityRaw).name : undefined,
      item: itemRaw?.trim() ? context.dex.items.get(itemRaw).name : undefined,
    };
  }

  const run = (offValue: number, defValue: number, rollPercent: 85 | 100) =>
    scratchDamage(context, {
      attacker,
      defender,
      moveId: move.id,
      attackerAbility: abilities.attacker,
      defenderAbility: abilities.defender,
      attackerItem: items.attacker,
      defenderItem: items.defender,
      pins: { offFromDefender, offStat, offValue, defStat, defValue },
      attackerBoosts: boosts.attacker,
      defenderBoosts: boosts.defender,
      attackerStatus: statuses.attacker,
      defenderStatus: statuses.defender,
      defenderMaxHp: exactHp,
      screens,
      weather: weatherId,
      terrain: terrainId,
      helpingHand,
      faintedAllies,
      attackerAlly: allies.attacker,
      defenderAlly: allies.defender,
      crit,
      spread: isSpread,
      attackerHpPercent,
      defenderHpPercent: hpPercent,
      rollPercent,
    });
  let low: ScratchDamage;
  let high: ScratchDamage;
  try {
    low = run(offLow, defHigh, 85);
    high = run(offHigh, defLow, 100);
  } catch (error) {
    return `Damage engine error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const moveType = high.moveType;
  if (weatherId === "desolateland" && moveType === "Water")
    return `${attacker.name} ${move.name} into ${defender.name}: fails in Desolate Land; 0% damage. Cannot KO.`;
  if (weatherId === "primordialsea" && moveType === "Fire")
    return `${attacker.name} ${move.name} into ${defender.name}: fails in Primordial Sea; 0% damage. Cannot KO.`;
  if (low.outcome === "immune" || high.outcome === "immune") {
    const chartDetail = effectivenessDetail(context.dex, moveType, defender.types);
    const reason =
      typeModifier(context.dex, moveType, defender.types) === 0
        ? chartDetail
        : `immune or absorbed${abilities.defender ? ` by ${abilities.defender}` : ""}; type chart alone says ${chartDetail}`;
    return `${attacker.name} ${move.name} into ${defender.name}: ${reason}; 0% damage. Cannot KO.`;
  }
  if (low.outcome === "none" || high.outcome === "none")
    return `${move.name} has no standard damage output to estimate.`;

  const minTotal = low.damage * low.hits[0];
  const maxTotal = high.damage * high.hits[1];
  const pct = (damage: number, hp: number) => Math.round((damage / hp) * 1000) / 10;
  const minimumPercent = pct(minTotal, hpHigh);
  const maximumPercent = pct(maxTotal, hpLow);
  const targetPercent = hpPercent ?? 100;
  const fullHealth = targetPercent === 100;
  const guaranteed = 100 * minTotal >= targetPercent * hpHigh;
  const possible = 100 * maxTotal >= targetPercent * hpLow;
  const outcome =
    targetPercent <= 0
      ? "Target is already at 0%."
      : guaranteed
        ? `Guaranteed ${fullHealth ? "OHKO" : `KO from the shown ${Math.round(targetPercent)}%`} across the full legal range.`
        : possible
          ? `Possible ${fullHealth ? "OHKO" : `KO from the shown ${Math.round(targetPercent)}%`}, not guaranteed across the legal range.`
          : `Cannot ${fullHealth ? "OHKO" : `KO from the shown ${Math.round(targetPercent)}%`} in this estimate.`;
  const shownHp = hpPercent === undefined ? "" : ` Target HP shown: ${Math.round(hpPercent)}%.`;
  const attackBasis =
    exactOff !== undefined
      ? `${offFromDefender ? `defender ${offStat}` : "attack"} exact from request`
      : offFromDefender
        ? `legal defender ${offStat} range (this move uses the target's stat)`
        : "legal attack range";
  const defenseBasis =
    exactDef !== undefined && exactHp !== undefined
      ? "defense/HP exact from request"
      : exactDef !== undefined
        ? "defense exact from request, legal HP range"
        : exactHp !== undefined
          ? "HP exact from request, legal defense range"
          : "legal defense/HP range";

  const applied: string[] = [];
  if (abilities.attacker) applied.push(`attacker ability ${abilities.attacker}`);
  if (abilities.defender) applied.push(`defender ability ${abilities.defender}`);
  if (items.attacker) applied.push(`attacker item ${items.attacker}`);
  if (items.defender) applied.push(`defender item ${items.defender}`);
  for (const side of ["attacker", "defender"] as const) {
    for (const [stat, stage] of Object.entries(boosts[side]))
      if (stage) applied.push(`${side} ${stage > 0 ? "+" : ""}${stage} ${stat}`);
    const status = statuses[side];
    if (status) applied.push(`${side} ${STATUS_WORDS.get(status)}`);
  }
  for (const screen of screens) {
    const screenName = SCREEN_WORDS.get(screen);
    if (screenName) applied.push(screenName);
  }
  if (weatherId) applied.push(WEATHER_WORDS.get(weatherId) ?? weatherId);
  if (terrainId) applied.push(TERRAIN_WORDS.get(terrainId) ?? terrainId);
  if (helpingHand) applied.push("Helping Hand");
  if (crit) applied.push("critical hit");
  if (isSpread) applied.push("spread (0.75x)");
  for (const side of ["attacker", "defender"] as const) {
    const ally = allies[side];
    if (ally) applied.push(`${side} ally ${ally.name}${ally.ability ? ` (${ally.ability})` : ""}`);
  }
  const appliedText = applied.length
    ? `applied ${applied.join(", ")}`
    : "no abilities, items, status, or field effects applied";

  const hits = [low.hits[0], high.hits[1]] as const;
  const hitsText =
    hits[1] > 1 ? ` x${hits[0] === hits[1] ? hits[0] : `${hits[0]}-${hits[1]}`} hits` : "";
  const bpText = high.basePower > 0 ? `BP ${high.basePower}` : "fixed damage";
  const notesText = notes.length ? ` Notes: ${notes.join("; ")}.` : "";
  return `${attacker.name} ${move.name} (${moveType} ${move.category} ${bpText}${hitsText}) into ${defender.name}: ${minimumPercent}-${maximumPercent}% of maximum HP.${shownHp} ${outcome} ${effectivenessDetail(context.dex, moveType, defender.types)}; ${appliedText}; ${attackBasis}, ${defenseBasis}.${notesText}`;
}

function scratchDamage(
  context: ReferenceCalculationContext,
  cfg: ScratchDamageConfig,
): ScratchDamage {
  const scratchSet = (
    species: string,
    ability: string,
    item: string,
    moves: string[],
  ): PokemonSet => ({
    name: species,
    species,
    item,
    ability,
    moves,
    nature: "Serious",
    gender: "",
    evs: filledStats(0),
    ivs: filledStats(31),
    level: 50,
  });
  const filler = () => scratchSet("Magikarp", "Honey Gather", "", ["Splash"]);
  const allySlot = (ally: ScratchAlly | undefined) =>
    ally
      ? scratchSet(ally.name, ally.ability ?? "Honey Gather", ally.item ?? "", ["Splash"])
      : filler();
  const battle = new context.showdown.Battle({
    formatid: context.resolvedFormat.id,
    format: context.resolvedFormat,
    p1: {
      name: "Attacker",
      team: [
        scratchSet(
          cfg.attacker.name,
          cfg.attackerAbility ?? "Honey Gather",
          cfg.attackerItem ?? "",
          [cfg.moveId],
        ),
        allySlot(cfg.attackerAlly),
      ],
    },
    p2: {
      name: "Defender",
      team: [
        scratchSet(
          cfg.defender.name,
          cfg.defenderAbility ?? "Honey Gather",
          cfg.defenderItem ?? "",
          ["Splash"],
        ),
        allySlot(cfg.defenderAlly),
      ],
    },
  });
  try {
    if (!battle.turn) battle.makeChoices("default", "default");
    const att = battle.p1.active[0];
    const def = battle.p2.active[0];
    if (!att || !def) throw new Error("scratch battle failed to field both sides");
    const offHolder = cfg.pins.offFromDefender ? def : att;
    offHolder.storedStats[cfg.pins.offStat] = cfg.pins.offValue;
    def.storedStats[cfg.pins.defStat] = cfg.pins.defValue;
    const fromAlly = (state: Battle["field"]["weatherState"]): boolean => {
      const source = state.source;
      return Boolean(source) && source !== att && source !== def;
    };
    if (cfg.weather) battle.field.setWeather(cfg.weather, "debug");
    else if (fromAlly(battle.field.weatherState)) battle.field.clearWeather();
    if (cfg.terrain) battle.field.setTerrain(cfg.terrain, "debug");
    else if (fromAlly(battle.field.terrainState)) battle.field.clearTerrain();
    for (const stat of BOOST_IDS) att.boosts[stat] = 0;
    for (const stat of BOOST_IDS) def.boosts[stat] = 0;
    Object.assign(att.boosts, cfg.attackerBoosts);
    Object.assign(def.boosts, cfg.defenderBoosts);
    if (cfg.defenderMaxHp !== undefined) {
      def.maxhp = cfg.defenderMaxHp;
      def.hp = cfg.defenderMaxHp;
    }
    for (const screen of cfg.screens) def.side.addSideCondition(screen, "debug");
    if (cfg.attackerStatus) att.status = battle.dex.toID(cfg.attackerStatus);
    if (cfg.defenderStatus) def.status = battle.dex.toID(cfg.defenderStatus);
    if (cfg.helpingHand) att.addVolatile("helpinghand");
    att.side.totalFainted = cfg.faintedAllies;
    if (cfg.attackerHpPercent !== undefined)
      att.hp = Math.max(1, Math.round((att.maxhp * cfg.attackerHpPercent) / 100));
    if (cfg.defenderHpPercent !== undefined)
      def.hp = Math.max(1, Math.round((def.maxhp * cfg.defenderHpPercent) / 100));

    let active = battle.dex.getActiveMove(cfg.moveId);
    active.willCrit = cfg.crit;
    battle.activePokemon = att;
    battle.activeTarget = def;
    battle.activeMove = active;
    battle.singleEvent("ModifyType", active, null, att, def, active, active);
    battle.singleEvent("ModifyMove", active, null, att, def, active, active);
    active = battle.runEvent("ModifyType", att, def, active, active);
    active = battle.runEvent("ModifyMove", att, def, active, active);
    if (cfg.spread) active.spreadHit = true;

    const hits = (
      Array.isArray(active.multihit)
        ? [active.multihit[0] ?? 1, active.multihit[active.multihit.length - 1] ?? 1]
        : [active.multihit ?? 1, active.multihit ?? 1]
    ) satisfies [number, number];
    let basePower = active.basePower;
    if (active.basePowerCallback) {
      const computed = active.basePowerCallback.call(battle, att, def, active);
      if (computed !== false && computed !== null && computed !== undefined) basePower = computed;
    }
    const tryHit = battle.runEvent("TryHit", def, att, active);
    if (!tryHit && tryHit !== 0)
      return { outcome: "immune", damage: 0, moveType: active.type, basePower, hits };

    battle.randomizer = (value: number) => battle.trunc((value * cfg.rollPercent) / 100);
    const damage = battle.actions.getDamage(att, def, active, true);
    if (damage === false)
      return { outcome: "immune", damage: 0, moveType: active.type, basePower, hits };
    if (damage === undefined || damage === null)
      return { outcome: "none", damage: 0, moveType: active.type, basePower, hits };
    return { outcome: "damage", damage, moveType: active.type, basePower, hits };
  } finally {
    battle.destroy();
  }
}
