import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Battle, Dex } from 'pokemon-showdown';
import { z } from 'zod';
import { defaultPsDir } from './paths.js';
import { loadShowdown, type ShowdownApi, showdownCommit } from './showdown.js';
import type { JsonObject, ToolDefinition } from './types.js';

const REFERENCE_RENDER_DIGEST_PROTOCOL = 'showdown-reference-render-v1';

type FormatDataKind = 'move' | 'item';

type SchemaType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';

interface ToolProperties extends JsonObject {
  [name: string]: ToolPropertySchema;
}

interface ToolPropertySchema extends JsonObject {
  type: SchemaType | SchemaType[];
  description?: string;
  properties?: ToolProperties;
  items?: ToolPropertySchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  additionalProperties?: false;
}

function tool(name: string, description: string, properties: ToolProperties, required: string[]): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const DEX_TOOLS: ToolDefinition[] = [
  tool(
    'lookup_species',
    'Look up a species: typing, abilities, base stats, forme, Mega Stone outcomes, and optional nature-based raw Speed range.',
    {
      name: { type: 'string' },
      item: { type: ['string', 'null'] },
      nature: { type: ['string', 'null'] },
    },
    ['name'],
  ),
  tool(
    'lookup_move',
    'Look up a move: type, category, power, accuracy, priority, target, and effect text.',
    { name: { type: 'string' } },
    ['name'],
  ),
  tool('lookup_item', "Look up an item's effect text and mega-stone behaviour.", { name: { type: 'string' } }, [
    'name',
  ]),
  tool(
    'lookup_learnset',
    "List every move a species can legally learn in this format's ruleset.",
    { name: { type: 'string' } },
    ['name'],
  ),
  tool('lookup_ability', "Look up an ability's effect text.", { name: { type: 'string' } }, ['name']),
  tool(
    'calculate_stats',
    'Calculate exact raw stats for a proposed spread using this format simulator. Champions Stat Points cap at 32 per stat and 66 total; classic EV formats cap at 252 per stat and 510 total.',
    {
      species: { type: 'string' },
      nature: { type: 'string' },
      evs: {
        type: 'object',
        description: 'Format investment values: Stat Points in Champions, EVs elsewhere. Omitted stats are 0.',
        properties: {
          hp: { type: 'integer', minimum: 0 },
          atk: { type: 'integer', minimum: 0 },
          def: { type: 'integer', minimum: 0 },
          spa: { type: 'integer', minimum: 0 },
          spd: { type: 'integer', minimum: 0 },
          spe: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    ['species', 'nature', 'evs'],
  ),
  tool(
    'lookup_matchup',
    'Look up type-chart effectiveness for an attacking move or type into a defending species. Returns immunity/SE/NVE multipliers only, not damage. With only attacker and defender species, reports each of the attacker types into the defender.',
    {
      attacker: {
        type: 'string',
        description: 'Attacking species, required for form-dependent moves such as Raging Bull.',
      },
      attacker_type: { type: 'string', description: 'Attacking type, or omit when move is provided.' },
      move: { type: 'string', description: 'Move name; its contextual type is used when provided.' },
      defender: { type: 'string', description: 'Defending species name.' },
    },
    ['defender'],
  ),
  tool(
    'estimate_damage',
    "Damage estimate computed by this format's real battle engine at level 50 in doubles, as a percentage range across legal investment. Abilities, any items (including berries), stat stages, status, screens, weather, terrain, Helping Hand, spread reduction, and variable-power moves are all applied exactly when supplied; anything you leave out is neutral. During a battle the harness supplies all of them from the live board and any open team sheet, along with both active allies and their abilities (Friend Guard, Power Spot, Ruin auras) and the fainted count that scales Last Respects, and what it reads there overrides anything you pass. The result names every factor it applied. It assumes no critical hit unless you ask for one, and it never models hazard chip or pre-existing activation state such as a Flash Fire charge, a Metronome count, or Rage Fist's hit tally. Supply your own Pokémon's exact battle stats on whichever side is yours to narrow the range; opposing stats use format-legal investment ranges, narrowed by the opposing nature only when a team sheet or the battle has revealed it. Only the stats this move actually uses are read; an implausible value falls back to the legal range with a note instead of failing the call.",
    {
      attacker: { type: 'string' },
      defender: { type: 'string' },
      move: { type: 'string' },
      attacker_ability: {
        type: 'string',
        description: 'Applied exactly by the engine. Omit for a neutral, no-effect ability.',
      },
      defender_ability: {
        type: 'string',
        description:
          'Applied exactly by the engine, including immunities and absorb abilities. Omit for a neutral, no-effect ability.',
      },
      attacker_stats: {
        type: 'object',
        description:
          'Optional exact raw stats from your own build. Only the stat this move attacks with is read; other keys are ignored, so never pad unknown stats with placeholder values.',
        properties: {
          atk: { type: 'number', exclusiveMinimum: 0 },
          def: { type: 'number', exclusiveMinimum: 0 },
          spa: { type: 'number', exclusiveMinimum: 0 },
          spd: { type: 'number', exclusiveMinimum: 0 },
          spe: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      defender_stats: {
        type: 'object',
        description:
          'Optional exact raw stats when the defender is your own Pokémon. HP also drives fixed and HP-scaled damage; other keys beyond hp and the stat this move targets are ignored.',
        properties: {
          hp: { type: 'number', exclusiveMinimum: 0 },
          atk: { type: 'number', exclusiveMinimum: 0 },
          def: { type: 'number', exclusiveMinimum: 0 },
          spa: { type: 'number', exclusiveMinimum: 0 },
          spd: { type: 'number', exclusiveMinimum: 0 },
          spe: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      attacker_boosts: {
        type: 'object',
        description: 'Current stat stages on the attacker, -6 to +6.',
        properties: {
          atk: { type: 'integer', minimum: -6, maximum: 6 },
          def: { type: 'integer', minimum: -6, maximum: 6 },
          spa: { type: 'integer', minimum: -6, maximum: 6 },
          spd: { type: 'integer', minimum: -6, maximum: 6 },
          spe: { type: 'integer', minimum: -6, maximum: 6 },
        },
        additionalProperties: false,
      },
      defender_boosts: {
        type: 'object',
        description: 'Current stat stages on the defender, -6 to +6.',
        properties: {
          atk: { type: 'integer', minimum: -6, maximum: 6 },
          def: { type: 'integer', minimum: -6, maximum: 6 },
          spa: { type: 'integer', minimum: -6, maximum: 6 },
          spd: { type: 'integer', minimum: -6, maximum: 6 },
          spe: { type: 'integer', minimum: -6, maximum: 6 },
        },
        additionalProperties: false,
      },
      attacker_status: {
        type: 'string',
        enum: ['brn', 'par', 'psn', 'tox', 'slp', 'frz'],
        description: 'Status on the attacker; burn, Guts, Facade, and similar interactions are engine-computed.',
      },
      defender_status: {
        type: 'string',
        enum: ['brn', 'par', 'psn', 'tox', 'slp', 'frz'],
        description: 'Status on the defender, for moves like Hex.',
      },
      defender_screens: {
        type: 'array',
        items: { type: 'string', enum: ['reflect', 'lightscreen', 'auroraveil'] },
        description: "Screens up on the defender's side.",
      },
      terrain: {
        type: 'string',
        description: 'electric | grassy | misty | psychic',
      },
      weather: { type: 'string', description: 'sun | rain | sand | snow | desolateland | primordialsea' },
      helping_hand: {
        type: 'boolean',
        description: 'An ally used Helping Hand on the attacker this turn (1.5x).',
      },
      is_critical_hit: {
        type: 'boolean',
        description: "Compute as a critical hit: 1.5x, ignoring the defender's positive stages and screens.",
      },
      attacker_hp_percent: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Current attacker HP percentage, for HP-scaling moves and pinch abilities.',
      },
      defender_hp_percent: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Current defender HP percentage shown in battle; also gates HP-dependent defensive abilities.',
      },
      attacker_item: { type: 'string', description: 'Any item; the engine applies its real effect.' },
      defender_item: { type: 'string', description: 'Any item; the engine applies its real effect.' },
      attacker_nature: { type: 'string' },
      defender_nature: { type: 'string' },
      is_spread_hit: {
        type: 'boolean',
        description:
          'True when the move hits more than one Pokémon (0.75x in doubles). Defaults false outside a live battle because no second target is known; the live harness derives this from the board.',
      },
    },
    ['attacker', 'defender', 'move'],
  ),
];

type SpeciesSet = [name: string, item?: string | null, nature?: string | null];

export interface ReferenceQuery {
  speciesSets?: SpeciesSet[];
  moves?: string[];
  items?: string[];
  abilities?: string[];
  natures?: string[];
}

export interface CompactMon {
  species: string;
  item?: string | null;
  nature?: string | null;
  moves?: string[];
  active?: boolean;
}

export interface CompactMonReference {
  types: string;
  speed: string;
  moves: Readonly<Record<string, string>>;
  mega?: string;
}

export interface SpeedProfileInput {
  species: string;
  nature?: string | null;
  exact?: number;
  item?: string | null;
  itemConsumed?: boolean;
  ability?: string | null;
  status?: string | null;
  boost?: number;
  tailwind?: boolean;
  weather?: string | null;
  terrain?: string | null;
}

export interface SpeedProfile {
  raw: [number, number];
  effective: [number, number];
  modifiers: string[];
}

export interface MatchupMon {
  species: string;
  moves: string[];
  ally?: boolean;
  ability?: string;
  item?: string;
  itemConsumed?: boolean;
}

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalWeather(value: string): string {
  return id(value.replace(/\s*\(\d+\s+turns?\s+left\)\s*$/i, ''));
}

function uniqueNames(values: Array<string | null | undefined>): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const clean = value?.trim();
    if (clean) names.set(id(clean), names.get(id(clean)) ?? clean);
  }
  return [...names.values()].sort((a, b) => id(a).localeCompare(id(b)));
}

const TYPE_BLOCKING_ABILITIES = new Map(
  Object.entries({
    ground: ['levitate', 'eartheater'],
    fire: ['flashfire', 'wellbakedbody'],
    water: ['waterabsorb', 'stormdrain', 'dryskin'],
    electric: ['voltabsorb', 'lightningrod', 'motordrive'],
    grass: ['sapsipper'],
  }),
);

function visibleDamageBlock(
  attacker: MatchupMon,
  defender: MatchupMon,
  move: { flags: { sound?: 1; bullet?: 1; wind?: 1 }; ignoreAbility?: boolean | undefined },
  moveType: string,
  modifier: number,
): string | undefined {
  if (id(defender.item ?? '') === 'airballoon' && !defender.itemConsumed && id(moveType) === 'ground') {
    return defender.item;
  }
  const attackerAbility = id(attacker.ability ?? '');
  const ignoresAbility = move.ignoreAbility || ['moldbreaker', 'teravolt', 'turboblaze'].includes(attackerAbility);
  if (ignoresAbility) return undefined;
  const ability = id(defender.ability ?? '');
  if ((TYPE_BLOCKING_ABILITIES.get(id(moveType)) ?? []).includes(ability)) return defender.ability;
  if (ability === 'soundproof' && move.flags.sound) return defender.ability;
  if (ability === 'bulletproof' && move.flags.bullet) return defender.ability;
  if (ability === 'windrider' && move.flags.wind) return defender.ability;
  if (ability === 'wonderguard' && modifier <= 1) return defender.ability;
  return undefined;
}

function cleanDescription(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ');
}

function baseStats(stats: Dex.StatsTable): string {
  return `base stats HP ${stats.hp}, Attack ${stats.atk}, Defense ${stats.def}, Special Attack ${stats.spa}, Special Defense ${stats.spd}, Speed ${stats.spe}`;
}
const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const BOOST_IDS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;
type StatId = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
type BattleStatCalculator = Pick<Battle, 'dex' | 'ruleTable' | 'statModify'>;
type PokemonSet = Parameters<Battle['statModify']>[1];
function filledStats(value: number): Dex.StatsTable {
  return { hp: value, atk: value, def: value, spa: value, spd: value, spe: value };
}

function investedStats(stat: StatId, value: number): Dex.StatsTable {
  return {
    hp: stat === 'hp' ? value : 0,
    atk: stat === 'atk' ? value : 0,
    def: stat === 'def' ? value : 0,
    spa: stat === 'spa' ? value : 0,
    spd: stat === 'spd' ? value : 0,
    spe: stat === 'spe' ? value : 0,
  };
}

function investmentLimits(battle: BattleStatCalculator) {
  const champions = battle.dex.currentMod.startsWith('champions');
  const total = battle.ruleTable.evLimit;
  return {
    perStat: champions ? 32 : total === 0 ? 0 : Math.min(252, total ?? 252),
    total,
    fixedIvs: champions,
  };
}

function statSet(battle: BattleStatCalculator, nature: string, evs: Dex.StatsTable, ivs: Dex.StatsTable): PokemonSet {
  const level =
    battle.ruleTable.adjustLevel ??
    battle.ruleTable.adjustLevelDown ??
    battle.ruleTable.defaultLevel ??
    battle.ruleTable.maxLevel ??
    100;
  return { name: '', species: '', item: '', ability: '', moves: [], nature, gender: '', evs, ivs, level };
}

function statRange(
  battle: BattleStatCalculator,
  baseStats: Dex.StatsTable,
  nature: { name: string } | undefined,
  statName: Exclude<StatId, 'hp'>,
): [number, number] {
  const limits = investmentLimits(battle);
  const natures = battle.dex.natures.all();
  const lowNature =
    nature?.name ??
    natures.find((entry: { minus?: string; name: string }) => entry.minus === statName)?.name ??
    'Serious';
  const highNature =
    nature?.name ??
    natures.find((entry: { plus?: string; name: string }) => entry.plus === statName)?.name ??
    'Serious';
  const lowEvs = filledStats(0);
  const highEvs = investedStats(statName, limits.perStat);
  const lowIvs = filledStats(limits.fixedIvs ? 31 : 0);
  const highIvs = filledStats(31);
  return [
    battle.statModify(baseStats, statSet(battle, lowNature, lowEvs, lowIvs), statName),
    battle.statModify(baseStats, statSet(battle, highNature, highEvs, highIvs), statName),
  ];
}

function hpRange(battle: BattleStatCalculator, baseStats: Dex.StatsTable): [number, number] {
  const limits = investmentLimits(battle);
  const lowEvs = filledStats(0);
  const highEvs = investedStats('hp', limits.perStat);
  const lowIvs = filledStats(limits.fixedIvs ? 31 : 0);
  const highIvs = filledStats(31);
  return [
    battle.statModify(baseStats, statSet(battle, 'Serious', lowEvs, lowIvs), 'hp'),
    battle.statModify(baseStats, statSet(battle, 'Serious', highEvs, highIvs), 'hp'),
  ];
}

function effectivenessLabel(mod: number): string {
  if (mod === 0) return 'immune (0x)';
  if (mod === 1) return 'neutral (1x)';
  if (mod === 2) return 'super-effective (2x)';
  if (mod === 4) return 'super-effective (4x)';
  if (mod === 0.5) return 'not very effective (0.5x)';
  if (mod === 0.25) return 'not very effective (0.25x)';
  return `${mod}x`;
}

/** The per-type factors let a model with a wrong internal chart see exactly which pairing it misremembers
 * instead of dismissing the combined multiplier as a tool bug. */
function effectivenessDetail(
  dex: {
    getImmunity: (source: string, target: string[]) => boolean;
    getEffectiveness: (source: string, target: string[]) => number;
  },
  attackType: string,
  defenderTypes: string[],
): string {
  const mod = typeModifier(dex, attackType, defenderTypes);
  const parts = defenderTypes.map((type) => `vs ${type} ${typeModifier(dex, attackType, [type])}x`);
  return `${effectivenessLabel(mod)} = ${attackType} ${parts.join(' × ')}`;
}

function typeModifier(
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
    sun: 'Fire',
    sunnyday: 'Fire',
    desolateland: 'Fire',
    rain: 'Water',
    raindance: 'Water',
    primordialsea: 'Water',
    sand: 'Rock',
    sandstorm: 'Rock',
    snow: 'Ice',
    snowscape: 'Ice',
    hail: 'Ice',
  }),
);

function weatherBallOverride(moveId: string, weather: string): { type: string; power: number } | null {
  const type = WEATHER_BALL_TYPE.get(weather);
  return moveId === 'weatherball' && type ? { type, power: 100 } : null;
}

const RAGING_BULL_TYPE = new Map(
  Object.entries({
    taurospaldeacombat: 'Fighting',
    taurospaldeablaze: 'Fire',
    taurospaldeaaqua: 'Water',
  }),
);

const ATE_ABILITY_TYPE = new Map(
  Object.entries({
    pixilate: 'Fairy',
    aerilate: 'Flying',
    refrigerate: 'Ice',
    galvanize: 'Electric',
  }),
);

function speciesMoveType(
  moveId: string,
  defaultType: string,
  speciesName: string,
  ability = '',
  soundMove = false,
): string {
  if (moveId === 'ragingbull') return RAGING_BULL_TYPE.get(id(speciesName)) ?? defaultType;
  const abilityId = id(ability);
  if (abilityId === 'normalize') return 'Normal';
  if (defaultType === 'Normal') {
    const convertedType = ATE_ABILITY_TYPE.get(abilityId);
    if (convertedType) return convertedType;
  }
  if (abilityId === 'liquidvoice' && soundMove) return 'Water';
  return defaultType;
}

const SPEED_HALVING_ITEMS = new Set([
  'ironball',
  'machobrace',
  'poweranklet',
  'powerband',
  'powerbelt',
  'powerbracer',
  'powerlens',
  'powerweight',
]);

interface ScratchAlly {
  name: string;
  ability?: string | undefined;
  item?: string | undefined;
}

interface ScratchDamage {
  outcome: 'immune' | 'none' | 'damage';
  damage: number;
  moveType: string;
  basePower: number;
  hits: [number, number];
}

function modifyRange(range: [number, number], numerator: number, denominator = 1): [number, number] {
  return [
    Math.max(1, Math.floor((range[0] * numerator) / denominator)),
    Math.max(1, Math.floor((range[1] * numerator) / denominator)),
  ];
}

const WEATHER_IDS = new Map(
  Object.entries({
    sun: 'sunnyday',
    sunnyday: 'sunnyday',
    harshsunlight: 'sunnyday',
    rain: 'raindance',
    raindance: 'raindance',
    sand: 'sandstorm',
    sandstorm: 'sandstorm',
    snow: 'snowscape',
    snowscape: 'snowscape',
    hail: 'snowscape',
    desolateland: 'desolateland',
    extremelyharshsunlight: 'desolateland',
    primordialsea: 'primordialsea',
    heavyrain: 'primordialsea',
    deltastream: 'deltastream',
    strongwinds: 'deltastream',
  }),
);

const TERRAIN_IDS = new Map(
  Object.entries({
    electric: 'electricterrain',
    electricterrain: 'electricterrain',
    grassy: 'grassyterrain',
    grassyterrain: 'grassyterrain',
    misty: 'mistyterrain',
    mistyterrain: 'mistyterrain',
    psychic: 'psychicterrain',
    psychicterrain: 'psychicterrain',
  }),
);

const STATUS_IDS = new Map(
  Object.entries({
    brn: 'brn',
    burn: 'brn',
    burned: 'brn',
    par: 'par',
    paralysis: 'par',
    paralyzed: 'par',
    psn: 'psn',
    poison: 'psn',
    poisoned: 'psn',
    tox: 'tox',
    toxic: 'tox',
    badlypoisoned: 'tox',
    slp: 'slp',
    sleep: 'slp',
    asleep: 'slp',
    frz: 'frz',
    freeze: 'frz',
    frozen: 'frz',
  }),
);

const STATUS_WORDS = new Map(
  Object.entries({
    brn: 'burned',
    par: 'paralyzed',
    psn: 'poisoned',
    tox: 'badly poisoned',
    slp: 'asleep',
    frz: 'frozen',
  }),
);

const SCREEN_IDS = new Map(
  Object.entries({
    reflect: 'reflect',
    lightscreen: 'lightscreen',
    auroraveil: 'auroraveil',
  }),
);

const SCREEN_WORDS = new Map(
  Object.entries({
    reflect: 'Reflect',
    lightscreen: 'Light Screen',
    auroraveil: 'Aurora Veil',
  }),
);

const WEATHER_WORDS = new Map(
  Object.entries({
    sunnyday: 'sun',
    raindance: 'rain',
    sandstorm: 'sand',
    snowscape: 'snow',
    desolateland: 'Desolate Land',
    primordialsea: 'Primordial Sea',
    deltastream: 'Delta Stream',
  }),
);

const TERRAIN_WORDS = new Map(
  Object.entries({
    electricterrain: 'Electric Terrain',
    grassyterrain: 'Grassy Terrain',
    mistyterrain: 'Misty Terrain',
    psychicterrain: 'Psychic Terrain',
  }),
);

const TARGET_TAGS = new Map(
  Object.entries({
    allAdjacentFoes: 'spread',
    allAdjacent: 'spread+ally',
    self: 'self',
    adjacentAlly: 'ally',
    adjacentAllyOrSelf: 'ally/self',
    allySide: 'ally-side',
    allyTeam: 'ally-side',
    allies: 'ally-side',
    foeSide: 'foe-side',
    all: 'field',
    any: 'any-range',
    randomNormal: 'random-foe',
  }),
);
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
const lookupSpeciesArgumentsSchema = z.object({
  name: z.string().catch(''),
  item: optionalStringSchema,
  nature: optionalStringSchema,
});
const matchupArgumentsSchema = z.object({
  attacker: z.string().catch(''),
  attacker_type: z.string().catch(''),
  move: z.string().catch(''),
  defender: z.string().catch(''),
});
const calculateStatsArgumentsSchema = z.object({
  species: z.string().catch(''),
  nature: z.string().catch(''),
  evs: statInputSchema,
});
const estimateDamageArgumentsSchema = z.object({
  attacker: z.string().catch(''),
  defender: z.string().catch(''),
  move: z.string().catch(''),
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
function emptyBoosts(): StatBoosts {
  return {};
}
type CalculateStatsArguments = z.infer<typeof calculateStatsArgumentsSchema>;
type MatchupArguments = z.infer<typeof matchupArgumentsSchema>;
export type EstimateDamageArguments = z.infer<typeof estimateDamageArgumentsSchema>;

export class ShowdownReference {
  private readonly dex;
  private readonly battle: Battle;
  private readonly showdown: ShowdownApi;
  private readonly resolvedFormat: ReturnType<ShowdownApi['Dex']['formats']['get']>;

  constructor(
    readonly format: string,
    readonly psDir = defaultPsDir(),
  ) {
    this.showdown = loadShowdown(psDir);
    this.resolvedFormat = this.showdown.Dex.formats.get(format);
    this.dex = this.showdown.Dex.forFormat(this.resolvedFormat);
    this.battle = new this.showdown.Battle({ formatid: this.resolvedFormat.id, format: this.resolvedFormat });
  }

  get revision(): string {
    return showdownCommit(this.psDir).slice(0, 12);
  }

  speciesAbility(name: string): string | undefined {
    const species = this.getSpecies(name);
    if (!species.exists) return undefined;
    const abilities = uniqueNames(Object.values(species.abilities));
    return abilities.length === 1 ? abilities[0] : undefined;
  }

  moveTarget(name: string): string | undefined {
    const move = this.dex.moves.get(name);
    return move.exists ? move.target : undefined;
  }

  static renderRevision(): string {
    return createHash('sha256')
      .update(REFERENCE_RENDER_DIGEST_PROTOCOL)
      .update('\0')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex')
      .slice(0, 12);
  }

  renderCompact(mons: CompactMon[]): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const mon of mons) {
      const species = this.dex.species.get(mon.species);
      if (!species.exists) continue;
      const key = `${species.id}|${id(mon.nature ?? '')}|${id(mon.item ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reference = this.describeCompact(mon);
      if (!reference) continue;
      const moves = uniqueNames(mon.moves ?? []).flatMap((moveName) => {
        const detail = reference.moves[id(moveName)];
        return detail ? [`${moveName} ${detail}`] : [];
      });
      const active = mon.active ? 'active; ' : '';
      lines.push(
        `- ${species.name}: ${reference.types}; ${active}raw Speed ${reference.speed}${mon.item ? `; item ${mon.item}` : ''}${
          reference.mega ? ` (${reference.mega})` : ''
        }${moves.length ? `; moves ${moves.join(', ')}` : ''}`,
      );
    }
    return lines.length ? [`Compact Showdown reference (${this.format}, commit ${this.revision}):`, ...lines] : [];
  }

  describeCompact(mon: CompactMon): CompactMonReference | undefined {
    const species = this.dex.species.get(mon.species);
    if (!species.exists) return undefined;
    const nature = mon.nature ? this.dex.natures.get(mon.nature) : undefined;
    const knownNature = nature?.exists ? nature : undefined;
    const [low, high] = statRange(this.battle, species.baseStats, knownNature, 'spe');
    const moves = Object.fromEntries(
      uniqueNames(mon.moves ?? []).flatMap((moveName) => {
        const move = this.dex.moves.get(moveName);
        if (!move.exists) return [];
        const power = move.basePower ? String(move.basePower) : 'no power';
        const moveType = speciesMoveType(move.id, move.type, species.name);
        const details = [`${moveType}/${move.category}/${power}`];
        if (move.target !== 'normal') details.push(TARGET_TAGS.get(move.target) ?? move.target);
        if (move.priority) details.push(`priority ${move.priority > 0 ? '+' : ''}${move.priority}`);
        if (move.accuracy !== true && move.accuracy < 100) details.push(`accuracy ${move.accuracy}%`);
        if (move.flags.powder)
          details.push('powder: fails on Grass types, Overcoat, and Safety Goggles (including redirection)');
        return [[move.id, details.join('/')]];
      }),
    );
    const mega: string[] = [];
    const item = mon.item ? this.dex.items.get(mon.item) : undefined;
    if (item?.exists && item.megaStone) {
      for (const formeName of species.otherFormes ?? []) {
        const forme = this.dex.species.get(formeName);
        if (!forme.exists || !/^Mega(?:-|$)/.test(forme.forme)) continue;
        const target = item.megaStone[species.name];
        if (id(target ?? '') !== id(forme.name)) continue;
        const [megaLow, megaHigh] = statRange(this.battle, forme.baseStats, knownNature, 'spe');
        mega.push(
          `if Mega Evolved -> ${forme.name}: ${forme.types.join('/')}, ability ${uniqueNames(Object.values(forme.abilities)).join('/')}, ${baseStats(forme.baseStats)}, raw Speed ${megaLow}-${megaHigh}`,
        );
      }
    }
    const reference: CompactMonReference = {
      types: species.types.join('/'),
      speed: `${low}-${high}`,
      moves,
    };
    if (mega.length) reference.mega = mega.join('; ');
    return reference;
  }

  speedProfile(input: SpeedProfileInput): SpeedProfile | undefined {
    const species = this.dex.species.get(input.species);
    if (!species.exists) return undefined;
    const nature = input.nature ? this.dex.natures.get(input.nature) : undefined;
    const exact = Number.isInteger(input.exact) && (input.exact ?? 0) > 0 ? input.exact : undefined;
    const raw: [number, number] =
      exact === undefined
        ? statRange(this.battle, species.baseStats, nature?.exists ? nature : undefined, 'spe')
        : [exact, exact];
    const stage = Math.max(-6, Math.min(6, Math.trunc(input.boost ?? 0)));
    let effective = stage >= 0 ? modifyRange(raw, 2 + stage, 2) : modifyRange(raw, 2, 2 - stage);
    const modifiers: string[] = [];
    if (stage) modifiers.push(`Speed stage ${stage > 0 ? '+' : ''}${stage}`);

    const fallbackAbility = Object.values(species.abilities)[0];
    const ability = id(input.ability || fallbackAbility || '');
    const weather = canonicalWeather(input.weather ?? '');
    const terrain = id(input.terrain ?? '');
    let numerator = 1;
    let denominator = 1;
    const multiply = (label: string, top: number, bottom = 1) => {
      numerator *= top;
      denominator *= bottom;
      modifiers.push(label);
    };
    if (
      (ability === 'chlorophyll' && ['sun', 'sunnyday', 'desolateland'].includes(weather)) ||
      (ability === 'swiftswim' && ['rain', 'raindance', 'primordialsea'].includes(weather)) ||
      (ability === 'sandrush' && ['sand', 'sandstorm'].includes(weather)) ||
      (ability === 'slushrush' && ['hail', 'snow', 'snowscape'].includes(weather))
    )
      multiply(`${input.ability || fallbackAbility} ×2`, 2);
    if (ability === 'surgesurfer' && ['electricterrain', 'electric'].includes(terrain))
      multiply(`${input.ability || fallbackAbility} ×2`, 2);
    if (ability === 'quickfeet' && input.status) multiply(`${input.ability || fallbackAbility} ×1.5`, 3, 2);
    if (ability === 'unburden' && input.itemConsumed) multiply(`${input.ability || fallbackAbility} ×2`, 2);

    const item = input.itemConsumed ? '' : id(input.item ?? '');
    if (item === 'choicescarf') multiply('Choice Scarf ×1.5', 3, 2);
    else if (SPEED_HALVING_ITEMS.has(item)) multiply(`${input.item} ×0.5`, 1, 2);
    if (input.tailwind) multiply('Tailwind ×2', 2);
    if (id(input.status ?? '') === 'par' && ability !== 'quickfeet') multiply('paralysis ×0.5', 1, 2);
    effective = modifyRange(effective, numerator, denominator);
    return { raw, effective, modifiers };
  }

  movePriority(name: string): number | undefined {
    const move = this.dex.moves.get(name);
    return move.exists ? move.priority : undefined;
  }

  priorityProfile(
    name: string,
    context: { ability?: string; item?: string; itemConsumed?: boolean; fullHp?: boolean; grassyTerrain?: boolean },
  ): { priority: number; notes: string[]; unresolved?: string } | undefined {
    const move = this.dex.moves.get(name);
    if (!move.exists) return undefined;
    let priority = move.priority;
    const notes: string[] = [];
    let unresolved: string | undefined;
    const ability = id(context.ability ?? '');
    if (ability === 'prankster' && move.category === 'Status') {
      priority += 1;
      notes.push('Prankster +1 (fails against Dark-type targets)');
    }
    if (ability === 'galewings' && move.type === 'Flying') {
      if (context.fullHp === true) {
        priority += 1;
        notes.push('Gale Wings +1 (full HP)');
      } else if (context.fullHp === false) notes.push('Gale Wings inactive (not at full HP)');
      else unresolved = 'Gale Wings adds +1 only at full HP; current HP unknown';
    }
    if (ability === 'triage' && move.flags.heal) {
      priority += 3;
      notes.push('Triage +3');
    }
    if (ability === 'myceliummight' && move.category === 'Status')
      notes.push('Mycelium Might: acts last within its bracket');
    if (ability === 'stall') notes.push('Stall: acts last within its bracket');
    if (move.id === 'grassyglide' && context.grassyTerrain) {
      priority += 1;
      notes.push('Grassy Glide +1 (Grassy Terrain)');
    }
    const item = context.itemConsumed ? '' : id(context.item ?? '');
    if (item === 'quickclaw') notes.push('Quick Claw: 20% chance to act first within its bracket');
    if (item === 'laggingtail' || item === 'fullincense') notes.push(`${context.item}: acts last within its bracket`);
    if (unresolved === undefined) return { priority, notes };
    return { priority, notes, unresolved };
  }

  renderActiveMatchups(attackers: MatchupMon[], defenders: MatchupMon[], weather = ''): string[] {
    const lines: string[] = [];
    let examined = false;
    const weatherId = canonicalWeather(weather);
    for (const attacker of attackers) {
      const species = this.dex.species.get(attacker.species);
      if (!species.exists) continue;
      for (const moveName of uniqueNames(attacker.moves)) {
        const move = this.dex.moves.get(moveName);
        if (!move.exists || move.category === 'Status' || !move.type || move.type === '???') continue;
        const override = weatherBallOverride(move.id, weatherId);
        const speciesType = speciesMoveType(move.id, move.type, species.name);
        const moveType =
          override?.type ??
          speciesMoveType(move.id, move.type, species.name, attacker.ability ?? '', !!move.flags.sound);
        const abilityConverted = !override && moveType !== speciesType && attacker.ability;
        const typeLabel = override
          ? `currently ${override.type} in ${weather}`
          : moveType !== move.type
            ? `currently ${moveType} for ${species.name}${abilityConverted ? ` (${attacker.ability})` : ''}`
            : moveType;
        const bits: string[] = [];
        for (const defender of defenders) {
          if (attacker.ally !== undefined && defender.ally !== undefined && attacker.ally === defender.ally) continue;
          const target = this.dex.species.get(defender.species);
          if (!target.exists) continue;
          examined = true;
          const mod = typeModifier(this.dex, moveType, target.types);
          const blockedBy = visibleDamageBlock(attacker, defender, move, moveType, mod);
          if (blockedBy) bits.push(`${target.name} immune via ${blockedBy} (type chart ${effectivenessLabel(mod)})`);
          else if (mod !== 1) bits.push(`${target.name} ${effectivenessLabel(mod)}`);
        }
        if (bits.length) lines.push(`- ${species.name} ${move.name} (${typeLabel}): ${bits.join('; ')}`);
      }
    }
    if (examined) lines.push('- Damaging matchups not listed above are neutral (1x).');
    return lines;
  }

  render(query: ReferenceQuery = {}): string[] {
    const speciesSets = query.speciesSets ?? [];
    const moves = uniqueNames(query.moves ?? []);
    const items = uniqueNames([...(query.items ?? []), ...speciesSets.map((set) => set[1])]);
    const abilities = uniqueNames(query.abilities ?? []);
    const natures = uniqueNames([...(query.natures ?? []), ...speciesSets.map((set) => set[2])]);
    const lines: string[] = [];

    const speciesGroups = new Map<string, { species: Dex.Species; sets: SpeciesSet[] }>();
    for (const set of speciesSets) {
      const species = this.getSpecies(set[0]);
      if (!species.exists) continue;
      const group = speciesGroups.get(species.id) ?? { species, sets: [] };
      if (!group.sets.some((current) => JSON.stringify(current.slice(1)) === JSON.stringify(set.slice(1))))
        group.sets.push(set);
      speciesGroups.set(species.id, group);
    }
    const fixedIvs = investmentLimits(this.battle).fixedIvs;
    for (const { species, sets } of [...speciesGroups.values()].sort((a, b) =>
      id(a.species.name).localeCompare(id(b.species.name)),
    )) {
      const abilityNames = uniqueNames(Object.values(species.abilities));
      const details = [
        species.types.join('/'),
        baseStats(species.baseStats),
        ...(abilityNames.length ? [`abilities ${abilityNames.join('/')}`] : []),
      ];
      if (species.forme) details.push(`forme ${species.forme}`);
      for (const [, , natureName] of sets) {
        const nature = natureName ? this.dex.natures.get(natureName) : undefined;
        const knownNature = nature?.exists ? nature : undefined;
        const [low, high] = statRange(this.battle, species.baseStats, knownNature, 'spe');
        const detail = knownNature
          ? `raw Speed ${low}-${high} with ${knownNature.name} alignment (${fixedIvs ? 'fixed maximum IV/Stat Point range' : 'full legal IV/EV range'})`
          : `raw Speed ${low}-${high} (${fixedIvs ? 'fixed maximum IV/Stat Point/nature range' : 'full legal IV/EV/nature range'})`;
        if (!details.includes(detail)) details.push(detail);
      }
      for (const itemName of uniqueNames(sets.map((set) => set[1]))) {
        const item = this.dex.items.get(itemName);
        if (!item.exists || !item.megaStone) continue;
        for (const formeName of species.otherFormes ?? []) {
          const mega = this.dex.species.get(formeName);
          if (!mega.exists || !/^Mega(?:-|$)/.test(mega.forme)) continue;
          const target = item.megaStone[species.name];
          if (id(target ?? '') !== id(mega.name)) continue;
          const ranges = sets.flatMap(([, visibleItem, natureName]) => {
            if (id(visibleItem ?? '') !== id(itemName)) return [];
            const nature = natureName ? this.dex.natures.get(natureName) : undefined;
            const knownNature = nature?.exists ? nature : undefined;
            const [low, high] = statRange(this.battle, mega.baseStats, knownNature, 'spe');
            return [`raw Speed ${low}-${high}${knownNature ? ` with ${knownNature.name} alignment` : ''}`];
          });
          const megaAbilities = uniqueNames(Object.values(mega.abilities));
          for (const ability of megaAbilities)
            if (!abilities.some((current) => id(current) === id(ability))) abilities.push(ability);
          details.push(
            `with ${item.name} -> ${mega.name} (${mega.types.join('/')}, ${baseStats(mega.baseStats)}, abilities ${megaAbilities.join('/')}${ranges.length ? `; ${[...new Set(ranges)].sort().join(', ')}` : ''})`,
          );
        }
      }
      lines.push(`- Species ${species.name}: ${details.join('; ')}`);
    }

    for (const name of moves) {
      const move = this.dex.moves.get(name);
      if (!move.exists) continue;
      const details = [
        move.type,
        move.category,
        move.basePower ? `BP ${move.basePower}` : 'BP none',
        move.accuracy === true ? 'always hits' : `acc ${move.accuracy}%`,
        `priority ${move.priority >= 0 ? '+' : ''}${move.priority}`,
        `target ${move.target}`,
      ];
      if (move.flags.powder)
        details.push(
          'powder move: no effect on Grass types, Overcoat, or Safety Goggles holders (including redirection)',
        );
      if (move.flags.sound) details.push('sound move: blocked by Soundproof, bypasses Substitute');
      const description = cleanDescription(move.desc || move.shortDesc);
      if (description) details.push(description);
      lines.push(`- Move ${move.name}: ${details.join('; ')}`);
    }
    for (const name of items) {
      const item = this.dex.items.get(name);
      const description = item.exists ? cleanDescription(item.desc || item.shortDesc) : '';
      if (description) lines.push(`- Item ${item.name}: ${description}`);
    }
    for (const name of abilities) {
      const ability = this.dex.abilities.get(name);
      const description = ability.exists ? cleanDescription(ability.desc || ability.shortDesc) : '';
      if (description) lines.push(`- Ability ${ability.name}: ${description}`);
    }
    for (const name of natures) {
      const nature = this.dex.natures.get(name);
      if (!nature.exists) continue;
      lines.push(
        nature.plus && nature.minus
          ? `- Stat alignment ${nature.name} (Showdown Nature): +${nature.plus}, -${nature.minus}`
          : `- Stat alignment ${nature.name} (Showdown Nature): neutral`,
      );
    }
    return lines.length ? [`Showdown reference (${this.format}, commit ${this.revision}):`, ...lines] : [];
  }

  lookup(name: string, args: JsonObject = {}): string {
    const speciesArguments = lookupSpeciesArgumentsSchema.parse(args);
    const value = speciesArguments.name;
    if (name === 'lookup_species') {
      return this.lookupSpecies(value, speciesArguments.item, speciesArguments.nature);
    }
    if (name === 'lookup_move') {
      return this.formatLegalityError('move', value) ?? this.lookupOne('Move', value, { moves: [value] });
    }
    if (name === 'lookup_item') {
      return this.formatLegalityError('item', value) ?? this.lookupOne('Item', value, { items: [value] });
    }
    if (name === 'lookup_learnset') return this.lookupLearnset(value);
    if (name === 'lookup_ability') return this.lookupOne('Ability', value, { abilities: [value] });
    if (name === 'calculate_stats') return this.calculateStats(calculateStatsArgumentsSchema.parse(args));
    if (name === 'lookup_matchup') return this.lookupMatchup(matchupArgumentsSchema.parse(args));
    if (name === 'estimate_damage') return this.estimateDamage(estimateDamageArgumentsSchema.parse(args));
    return `Unknown tool: ${name}`;
  }

  private formatLegalityError(kind: FormatDataKind, name: string): string | null {
    if (!name.trim()) return null;
    const data = kind === 'move' ? this.dex.moves.get(name) : this.dex.items.get(name);
    if (!data.exists) return null;
    const banned = this.battle.ruleTable.has(`-${kind}:${data.id}`);
    return data.isNonstandard || banned ? `${data.name} is not legal in ${this.format}.` : null;
  }

  private getSpecies(name: string): Dex.Species {
    const direct = this.dex.species.get(name);
    if (direct.exists || !name.trim()) return direct;
    const candidates = [
      name.replace(/-Male$/i, ''),
      name.replace(/-Female$/i, '-F'),
      name.replace(/^Mega (.+?)(?: ([XY]))?$/i, (_, base, xy) => (xy ? `${base}-Mega-${xy}` : `${base}-Mega`)),
      name.replace(/^Paldean (.+?)(?: (Aqua|Blaze|Combat))?$/i, (_, base, breed) =>
        breed ? `${base}-Paldea-${breed}` : `${base}-Paldea`,
      ),
    ];
    for (const candidate of candidates) {
      if (candidate === name) continue;
      const species = this.dex.species.get(candidate);
      if (species.exists) return species;
    }
    return direct;
  }

  private lookupSpecies(name: string, item?: string, nature?: string): string {
    if (!name.trim()) return 'Species name is required.';
    if (item) {
      const error = this.formatLegalityError('item', item);
      if (error) return error;
    }
    const lines = this.render({
      speciesSets: [[name, item?.trim() ? item : null, nature?.trim() ? nature : null]],
    });
    return (
      lines.find((line) => line.startsWith('- Species ')) ??
      `No species data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }

  private lookupLearnset(name: string): string {
    if (!name.trim()) return 'Species name is required.';
    const species = this.getSpecies(name);
    if (!species.exists) return `No species data for ${JSON.stringify(name)} in ${this.format}.`;
    const moves: string[] = [];
    for (const moveId of this.dex.species.getMovePool(species.id)) {
      const move = this.dex.moves.get(moveId);
      if (move.exists && !move.isNonstandard) moves.push(move.name);
    }
    moves.sort();
    return `- Learnset ${species.name} (${moves.length} legal moves): ${moves.join(', ')}`;
  }

  private lookupMatchup(args: MatchupArguments): string {
    const defenderName = args.defender;
    if (!defenderName.trim()) return 'defender is required.';
    const defender = this.getSpecies(defenderName);
    if (!defender.exists) return `No species data for ${JSON.stringify(defenderName)} in ${this.format}.`;
    const attackerName = args.attacker;
    const attacker = attackerName ? this.getSpecies(attackerName) : undefined;
    let attackType = args.attacker_type;
    let moveName = args.move;
    let typeNote = '';
    if (moveName.trim()) {
      const move = this.dex.moves.get(moveName);
      if (!move.exists) return `No move data for ${JSON.stringify(moveName)} in ${this.format}.`;
      const error = this.formatLegalityError('move', moveName);
      if (error) return error;
      if (move.id === 'ragingbull' && !attacker?.exists) return 'attacker is required to resolve Raging Bull typing.';
      attackType = speciesMoveType(move.id, move.type, attacker?.name ?? '');
      if (attacker?.exists) {
        const abilities = [...new Set(Object.values(attacker.abilities).flatMap((entry) => (entry ? [entry] : [])))];
        const conversions = abilities.flatMap((abilityName) => {
          const converted = speciesMoveType(move.id, move.type, attacker.name, abilityName, !!move.flags.sound);
          return converted === attackType ? [] : [{ abilityName, converted }];
        });
        const onlyConversion = conversions.length === 1 ? conversions[0] : undefined;
        if (onlyConversion && abilities.length === 1) {
          attackType = onlyConversion.converted;
          typeNote = ` via ${onlyConversion.abilityName}`;
        } else if (conversions.length) {
          typeNote = ` (${conversions
            .map((entry) => `${entry.abilityName} would make it ${entry.converted}`)
            .join('; ')})`;
        }
      }
      moveName = move.name;
    }
    if (!attackType.trim()) {
      if (attacker?.exists) {
        const perType = attacker.types.map((type) => `${type}: ${effectivenessDetail(this.dex, type, defender.types)}`);
        return `${attacker.name} types into ${defender.name} (${defender.types.join('/')}): ${perType.join(' | ')}.`;
      }
      return 'Provide move or attacker_type.';
    }
    const type = this.dex.types.get(attackType);
    if (!type.exists) return `No type data for ${JSON.stringify(attackType)}.`;
    const source = moveName ? `${moveName} (${type.name}${typeNote})` : type.name;
    return `${source} into ${defender.name} (${defender.types.join('/')}): ${effectivenessDetail(this.dex, type.name, defender.types)}.`;
  }

  private calculateStats(args: CalculateStatsArguments): string {
    const speciesName = args.species;
    const natureName = args.nature;
    if (!speciesName.trim() || !natureName.trim() || !args.evs) {
      return 'species, nature, and evs are required.';
    }
    const species = this.getSpecies(speciesName);
    if (!species.exists) return `No species data for ${JSON.stringify(speciesName)} in ${this.format}.`;
    const nature = this.dex.natures.get(natureName);
    if (!nature.exists) return `No nature data for ${JSON.stringify(natureName)} in ${this.format}.`;
    const limits = investmentLimits(this.battle);
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
    const stats = this.battle.spreadModify(species.baseStats, statSet(this.battle, nature.name, evs, filledStats(31)));
    const label = limits.fixedIvs ? 'Stat Points' : 'EVs';
    return `${species.name} (${nature.name}; ${label} ${total}${limits.total === null ? '' : `/${limits.total}`}): HP ${stats.hp}, Attack ${stats.atk}, Defense ${stats.def}, Special Attack ${stats.spa}, Special Defense ${stats.spd}, Speed ${stats.spe}.`;
  }

  private implausibleStat(
    species: Dex.Species,
    stat: Exclude<StatId, 'hp'>,
    value: number,
    label: string,
  ): string | null {
    const [low, high] = statRange(this.battle, species.baseStats, undefined, stat);
    return value < Math.floor(low / 4) || value > high * 4
      ? `${label} ${value} is implausible for ${species.name}: legal raw ${stat} spans ${low}-${high}, and stat stages reach x0.25-x4.`
      : null;
  }

  private estimateDamage(args: EstimateDamageArguments): string {
    const attackerName = args.attacker;
    const defenderName = args.defender;
    const moveName = args.move;
    if (!attackerName.trim() || !defenderName.trim() || !moveName.trim())
      return 'attacker, defender, and move are required.';
    const attacker = this.getSpecies(attackerName);
    const defender = this.getSpecies(defenderName);
    const move = this.dex.moves.get(moveName);
    if (!attacker.exists) return `No species data for ${JSON.stringify(attackerName)}.`;
    if (!defender.exists) return `No species data for ${JSON.stringify(defenderName)}.`;
    if (!move.exists) return `No move data for ${JSON.stringify(moveName)}.`;
    const moveError = this.formatLegalityError('move', moveName);
    if (moveError) return moveError;
    if (move.category === 'Status') return `${move.name} is a status move; no damage estimate.`;
    if (!move.basePower && !move.basePowerCallback && !move.damage && !move.damageCallback && !move.ohko)
      return `${move.name} has no standard damage output to estimate.`;

    const notes: string[] = [];
    const items: Partial<Record<'attacker' | 'defender', string>> = {};
    const abilities: Partial<Record<'attacker' | 'defender', string>> = {};
    const statuses: Partial<Record<'attacker' | 'defender', string>> = {};
    const natures: Partial<Record<'attacker' | 'defender', { name: string }>> = {};
    const boosts = { attacker: emptyBoosts(), defender: emptyBoosts() };
    for (const side of ['attacker', 'defender'] as const) {
      const itemRaw = args[`${side}_item`];
      if (itemRaw?.trim()) {
        const item = this.dex.items.get(itemRaw);
        if (!item.exists) return `No item data for ${JSON.stringify(itemRaw)}.`;
        const itemError = this.formatLegalityError('item', itemRaw);
        if (itemError) return itemError;
        items[side] = item.name;
      }
      const abilityRaw = args[`${side}_ability`];
      if (abilityRaw?.trim()) {
        const ability = this.dex.abilities.get(abilityRaw);
        if (!ability.exists) return `No ability data for ${JSON.stringify(abilityRaw)}.`;
        abilities[side] = ability.name;
        const species = side === 'attacker' ? attacker : defender;
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
        const nature = this.dex.natures.get(natureRaw);
        if (!nature.exists) return `No nature data for ${JSON.stringify(natureRaw)}.`;
        natures[side] = nature;
      }
      const boostsRaw = args[`${side}_boosts`];
      if (boostsRaw !== undefined && boostsRaw !== null) {
        const parsedBoosts = boostInputSchema.safeParse(boostsRaw);
        if (!parsedBoosts.success) return `${side}_boosts must be an object of integer stat stages from -6 to 6.`;
        boosts[side] = parsedBoosts.data;
      }
    }
    const screens: string[] = [];
    if (args.defender_screens !== undefined && args.defender_screens !== null) {
      const parsedScreens = screenInputSchema.safeParse(args.defender_screens);
      if (!parsedScreens.success) return 'defender_screens must be an array of screen names.';
      for (const raw of parsedScreens.data) {
        const screen = SCREEN_IDS.get(id(raw));
        if (!screen) return `Unknown screen ${JSON.stringify(raw)}; accepted: reflect, lightscreen, auroraveil.`;
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
      terrainId = TERRAIN_IDS.get(id(args.terrain.replace(/\s*terrain\s*$/i, '')));
      if (!terrainId)
        return `Unknown terrain ${JSON.stringify(args.terrain)}; accepted: electric, grassy, misty, psychic.`;
    }

    const offFromDefender = move.overrideOffensivePokemon === 'target';
    const offStat = move.overrideOffensiveStat ?? (move.category === 'Physical' ? 'atk' : 'spa');
    const defStat = move.overrideDefensiveStat ?? (move.category === 'Special' ? 'spd' : 'def');
    const offSide = offFromDefender ? 'defender' : 'attacker';
    const offSpecies = offFromDefender ? defender : attacker;

    const exactStat = (side: 'attacker' | 'defender', stat: StatId, species: Dex.Species): number | undefined => {
      const source = args[`${side}_stats`];
      if (!source) return undefined;
      const value = source[stat];
      if (value === undefined || value <= 0) return undefined;
      if (stat === 'hp') {
        const [legalLow, legalHigh] = hpRange(this.battle, species.baseStats);
        if (value < legalLow || value > legalHigh) {
          notes.push(
            `${side}_stats.hp ${value} is outside ${species.name}'s legal HP range ${legalLow}-${legalHigh}, so the legal range was used instead`,
          );
          return undefined;
        }
        return value;
      }
      if (this.implausibleStat(species, stat, value, `${side}_stats.${stat}`)) {
        notes.push(
          `${side}_stats.${stat} ${value} is implausible for ${species.name}, so the legal range was used instead`,
        );
        return undefined;
      }
      return value;
    };
    const exactOff = exactStat(offSide, offStat, offSpecies);
    const exactDef = exactStat('defender', defStat, defender);
    const exactHp = exactStat('defender', 'hp', defender);
    const [offLow, offHigh] =
      exactOff !== undefined
        ? [exactOff, exactOff]
        : statRange(this.battle, offSpecies.baseStats, natures[offSide], offStat);
    const [defLow, defHigh] =
      exactDef !== undefined
        ? [exactDef, exactDef]
        : statRange(this.battle, defender.baseStats, natures.defender, defStat);
    const [hpLow, hpHigh] = exactHp !== undefined ? [exactHp, exactHp] : hpRange(this.battle, defender.baseStats);

    const suppliedAttackerHp = args.attacker_hp_percent;
    const attackerHpPercent =
      suppliedAttackerHp === undefined ? undefined : Math.max(0, Math.min(100, suppliedAttackerHp));
    const suppliedHpPercent = args.defender_hp_percent;
    const hpPercent = suppliedHpPercent === undefined ? undefined : Math.max(0, Math.min(100, suppliedHpPercent));

    const isSpread = args.is_spread_hit === true;
    const crit = args.is_critical_hit === true;
    const helpingHand = args.helping_hand === true;
    const faintedAllies = Math.max(0, Math.trunc(args.attacker_fainted_allies ?? 0));
    const allies: Partial<Record<'attacker' | 'defender', ScratchAlly>> = {};
    for (const side of ['attacker', 'defender'] as const) {
      const raw = args[`${side}_ally`];
      if (!raw?.trim()) continue;
      const species = this.dex.species.get(raw);
      if (!species.exists) return `No species data for ${JSON.stringify(raw)}.`;
      const abilityRaw = args[`${side}_ally_ability`];
      const itemRaw = args[`${side}_ally_item`];
      allies[side] = {
        name: species.name,
        ability: abilityRaw?.trim() ? this.dex.abilities.get(abilityRaw).name : undefined,
        item: itemRaw?.trim() ? this.dex.items.get(itemRaw).name : undefined,
      };
    }

    const run = (offValue: number, defValue: number, rollPercent: 85 | 100) =>
      this.scratchDamage({
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
    if (weatherId === 'desolateland' && moveType === 'Water')
      return `${attacker.name} ${move.name} into ${defender.name}: fails in Desolate Land; 0% damage. Cannot KO.`;
    if (weatherId === 'primordialsea' && moveType === 'Fire')
      return `${attacker.name} ${move.name} into ${defender.name}: fails in Primordial Sea; 0% damage. Cannot KO.`;
    if (low.outcome === 'immune' || high.outcome === 'immune') {
      const chartDetail = effectivenessDetail(this.dex, moveType, defender.types);
      const reason =
        typeModifier(this.dex, moveType, defender.types) === 0
          ? chartDetail
          : `immune or absorbed${abilities.defender ? ` by ${abilities.defender}` : ''}; type chart alone says ${chartDetail}`;
      return `${attacker.name} ${move.name} into ${defender.name}: ${reason}; 0% damage. Cannot KO.`;
    }
    if (low.outcome === 'none' || high.outcome === 'none')
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
        ? 'Target is already at 0%.'
        : guaranteed
          ? `Guaranteed ${fullHealth ? 'OHKO' : `KO from the shown ${Math.round(targetPercent)}%`} across the full legal range.`
          : possible
            ? `Possible ${fullHealth ? 'OHKO' : `KO from the shown ${Math.round(targetPercent)}%`}, not guaranteed across the legal range.`
            : `Cannot ${fullHealth ? 'OHKO' : `KO from the shown ${Math.round(targetPercent)}%`} in this estimate.`;
    const shownHp = hpPercent === undefined ? '' : ` Target HP shown: ${Math.round(hpPercent)}%.`;
    const attackBasis =
      exactOff !== undefined
        ? `${offFromDefender ? `defender ${offStat}` : 'attack'} exact from request`
        : offFromDefender
          ? `legal defender ${offStat} range (this move uses the target's stat)`
          : 'legal attack range';
    const defenseBasis =
      exactDef !== undefined && exactHp !== undefined
        ? 'defense/HP exact from request'
        : exactDef !== undefined
          ? 'defense exact from request, legal HP range'
          : exactHp !== undefined
            ? 'HP exact from request, legal defense range'
            : 'legal defense/HP range';

    const applied: string[] = [];
    if (abilities.attacker) applied.push(`attacker ability ${abilities.attacker}`);
    if (abilities.defender) applied.push(`defender ability ${abilities.defender}`);
    if (items.attacker) applied.push(`attacker item ${items.attacker}`);
    if (items.defender) applied.push(`defender item ${items.defender}`);
    for (const side of ['attacker', 'defender'] as const) {
      for (const [stat, stage] of Object.entries(boosts[side]))
        if (stage) applied.push(`${side} ${stage > 0 ? '+' : ''}${stage} ${stat}`);
      const status = statuses[side];
      if (status) applied.push(`${side} ${STATUS_WORDS.get(status)}`);
    }
    for (const screen of screens) {
      const screenName = SCREEN_WORDS.get(screen);
      if (screenName) applied.push(screenName);
    }
    if (weatherId) applied.push(WEATHER_WORDS.get(weatherId) ?? weatherId);
    if (terrainId) applied.push(TERRAIN_WORDS.get(terrainId) ?? terrainId);
    if (helpingHand) applied.push('Helping Hand');
    if (crit) applied.push('critical hit');
    if (isSpread) applied.push('spread (0.75x)');
    for (const side of ['attacker', 'defender'] as const) {
      const ally = allies[side];
      if (ally) applied.push(`${side} ally ${ally.name}${ally.ability ? ` (${ally.ability})` : ''}`);
    }
    const appliedText = applied.length
      ? `applied ${applied.join(', ')}`
      : 'no abilities, items, status, or field effects applied';

    const hits = [low.hits[0], high.hits[1]] as const;
    const hitsText = hits[1] > 1 ? ` x${hits[0] === hits[1] ? hits[0] : `${hits[0]}-${hits[1]}`} hits` : '';
    const bpText = high.basePower > 0 ? `BP ${high.basePower}` : 'fixed damage';
    const notesText = notes.length ? ` Notes: ${notes.join('; ')}.` : '';
    return `${attacker.name} ${move.name} (${moveType} ${move.category} ${bpText}${hitsText}) into ${defender.name}: ${minimumPercent}-${maximumPercent}% of maximum HP.${shownHp} ${outcome} ${effectivenessDetail(this.dex, moveType, defender.types)}; ${appliedText}; ${attackBasis}, ${defenseBasis}.${notesText}`;
  }

  private scratchDamage(cfg: {
    attacker: Dex.Species;
    defender: Dex.Species;
    moveId: string;
    attackerAbility?: string | undefined;
    defenderAbility?: string | undefined;
    attackerItem?: string | undefined;
    defenderItem?: string | undefined;
    pins: {
      offFromDefender: boolean;
      offStat: Exclude<StatId, 'hp'>;
      offValue: number;
      defStat: Exclude<StatId, 'hp'>;
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
  }): ScratchDamage {
    const scratchSet = (species: string, ability: string, item: string, moves: string[]): PokemonSet => ({
      name: species,
      species,
      item,
      ability,
      moves,
      nature: 'Serious',
      gender: '',
      evs: filledStats(0),
      ivs: filledStats(31),
      level: 50,
    });
    const filler = () => scratchSet('Magikarp', 'Honey Gather', '', ['Splash']);
    const allySlot = (ally: ScratchAlly | undefined) =>
      ally ? scratchSet(ally.name, ally.ability ?? 'Honey Gather', ally.item ?? '', ['Splash']) : filler();
    const battle = new this.showdown.Battle({
      formatid: this.resolvedFormat.id,
      format: this.resolvedFormat,
      p1: {
        name: 'Attacker',
        team: [
          scratchSet(cfg.attacker.name, cfg.attackerAbility ?? 'Honey Gather', cfg.attackerItem ?? '', [cfg.moveId]),
          allySlot(cfg.attackerAlly),
        ],
      },
      p2: {
        name: 'Defender',
        team: [
          scratchSet(cfg.defender.name, cfg.defenderAbility ?? 'Honey Gather', cfg.defenderItem ?? '', ['Splash']),
          allySlot(cfg.defenderAlly),
        ],
      },
    });
    try {
      if (!battle.turn) battle.makeChoices('default', 'default');
      const att = battle.p1.active[0];
      const def = battle.p2.active[0];
      if (!att || !def) throw new Error('scratch battle failed to field both sides');
      const offHolder = cfg.pins.offFromDefender ? def : att;
      offHolder.storedStats[cfg.pins.offStat] = cfg.pins.offValue;
      def.storedStats[cfg.pins.defStat] = cfg.pins.defValue;
      /** An ally fielded for its Friend Guard also brings its Drought, which the caller never asked
       * for; weather the attacker or defender itself creates still stands, as it does on a real field. */
      const fromAlly = (state: Battle['field']['weatherState']): boolean => {
        const source = state.source;
        return Boolean(source) && source !== att && source !== def;
      };
      if (cfg.weather) battle.field.setWeather(cfg.weather, 'debug');
      else if (fromAlly(battle.field.weatherState)) battle.field.clearWeather();
      if (cfg.terrain) battle.field.setTerrain(cfg.terrain, 'debug');
      else if (fromAlly(battle.field.terrainState)) battle.field.clearTerrain();
      for (const stat of BOOST_IDS) att.boosts[stat] = 0;
      for (const stat of BOOST_IDS) def.boosts[stat] = 0;
      Object.assign(att.boosts, cfg.attackerBoosts);
      Object.assign(def.boosts, cfg.defenderBoosts);
      if (cfg.defenderMaxHp !== undefined) {
        def.maxhp = cfg.defenderMaxHp;
        def.hp = cfg.defenderMaxHp;
      }
      for (const screen of cfg.screens) def.side.addSideCondition(screen, 'debug');
      if (cfg.attackerStatus) att.status = battle.dex.toID(cfg.attackerStatus);
      if (cfg.defenderStatus) def.status = battle.dex.toID(cfg.defenderStatus);
      if (cfg.helpingHand) att.addVolatile('helpinghand');
      /** Last Respects reads the attacker's side fainted count off the battle it runs in, and the
       * scratch battle starts empty; without this every fainted ally is worth 50 lost base power. */
      att.side.totalFainted = cfg.faintedAllies;
      if (cfg.attackerHpPercent !== undefined)
        att.hp = Math.max(1, Math.round((att.maxhp * cfg.attackerHpPercent) / 100));
      if (cfg.defenderHpPercent !== undefined)
        def.hp = Math.max(1, Math.round((def.maxhp * cfg.defenderHpPercent) / 100));

      let active = battle.dex.getActiveMove(cfg.moveId);
      active.willCrit = cfg.crit;
      /** Handlers like Unaware's onAnyModifyBoost read battle.activePokemon/activeTarget,
       * which only real move execution sets; without them the scratch call silently no-ops. */
      battle.activePokemon = att;
      battle.activeTarget = def;
      battle.activeMove = active;
      battle.singleEvent('ModifyType', active, null, att, def, active, active);
      battle.singleEvent('ModifyMove', active, null, att, def, active, active);
      active = battle.runEvent('ModifyType', att, def, active, active);
      active = battle.runEvent('ModifyMove', att, def, active, active);
      if (cfg.spread) active.spreadHit = true;

      const hits = (
        Array.isArray(active.multihit)
          ? [active.multihit[0] ?? 1, active.multihit[active.multihit.length - 1] ?? 1]
          : [active.multihit ?? 1, active.multihit ?? 1]
      ) satisfies [number, number];
      let basePower = active.basePower;
      /** A move can carry both a static basePower and a callback that overrides it, so the callback
       * decides whenever it exists; reading the static field first reports the unscaled floor. */
      if (active.basePowerCallback) {
        const computed = active.basePowerCallback.call(battle, att, def, active);
        if (computed !== false && computed !== null && computed !== undefined) basePower = computed;
      }
      const tryHit = battle.runEvent('TryHit', def, att, active);
      if (!tryHit && tryHit !== 0) return { outcome: 'immune', damage: 0, moveType: active.type, basePower, hits };

      battle.randomizer = (value: number) => battle.trunc((value * cfg.rollPercent) / 100);
      const damage = battle.actions.getDamage(att, def, active, true);
      if (damage === false) return { outcome: 'immune', damage: 0, moveType: active.type, basePower, hits };
      if (damage === undefined || damage === null)
        return { outcome: 'none', damage: 0, moveType: active.type, basePower, hits };
      return { outcome: 'damage', damage, moveType: active.type, basePower, hits };
    } finally {
      battle.destroy();
    }
  }

  private lookupOne(kind: string, name: string, query: ReferenceQuery, prefix = `- ${kind} `): string {
    if (!name.trim()) return `${kind} name is required.`;
    return (
      this.render(query).find((line) => line.startsWith(prefix)) ??
      `No ${kind.toLowerCase()} data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }
}
