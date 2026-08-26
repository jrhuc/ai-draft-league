import type { JsonObject, ToolDefinition } from "./types.js";

type SchemaType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

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

function tool(
  name: string,
  description: string,
  properties: ToolProperties,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

export const DEX_TOOLS: ToolDefinition[] = [
  tool(
    "lookup_species",
    "Look up a species: typing, abilities, base stats, forme, Mega Stone outcomes, and optional nature-based raw Speed range.",
    {
      name: { type: "string" },
      item: { type: ["string", "null"] },
      nature: { type: ["string", "null"] },
    },
    ["name"],
  ),
  tool(
    "lookup_move",
    "Look up a move: type, category, power, accuracy, priority, target, and effect text.",
    { name: { type: "string" } },
    ["name"],
  ),
  tool(
    "lookup_item",
    "Look up an item's effect text and mega-stone behaviour.",
    { name: { type: "string" } },
    ["name"],
  ),
  tool(
    "lookup_learnset",
    "List every move a species can legally learn in this format's ruleset.",
    { name: { type: "string" } },
    ["name"],
  ),
  tool("lookup_ability", "Look up an ability's effect text.", { name: { type: "string" } }, [
    "name",
  ]),
  tool(
    "calculate_stats",
    "Calculate exact raw stats for a proposed spread using this format simulator. Champions Stat Points cap at 32 per stat and 66 total; classic EV formats cap at 252 per stat and 510 total.",
    {
      species: { type: "string" },
      nature: { type: "string" },
      evs: {
        type: "object",
        description:
          "Format investment values: Stat Points in Champions, EVs elsewhere. Omitted stats are 0.",
        properties: {
          hp: { type: "integer", minimum: 0 },
          atk: { type: "integer", minimum: 0 },
          def: { type: "integer", minimum: 0 },
          spa: { type: "integer", minimum: 0 },
          spd: { type: "integer", minimum: 0 },
          spe: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    ["species", "nature", "evs"],
  ),
  tool(
    "lookup_matchup",
    "Look up type-chart effectiveness for an attacking move or type into a defending species. Returns immunity/SE/NVE multipliers only, not damage. With only attacker and defender species, reports each of the attacker types into the defender.",
    {
      attacker: {
        type: "string",
        description: "Attacking species, required for form-dependent moves such as Raging Bull.",
      },
      attacker_type: {
        type: "string",
        description: "Attacking type, or omit when move is provided.",
      },
      move: {
        type: "string",
        description: "Move name; its contextual type is used when provided.",
      },
      defender: { type: "string", description: "Defending species name." },
    },
    ["defender"],
  ),
  tool(
    "estimate_damage",
    "Damage estimate computed by this format's real battle engine at level 50 in doubles, as a percentage range across legal investment. Abilities, any items (including berries), stat stages, status, screens, weather, terrain, Helping Hand, spread reduction, and variable-power moves are all applied exactly when supplied; anything you leave out is neutral. During a battle the harness supplies all of them from the live board and any open team sheet, along with both active allies and their abilities (Friend Guard, Power Spot, Ruin auras) and the fainted count that scales Last Respects, and what it reads there overrides anything you pass. The result names every factor it applied. It assumes no critical hit unless you ask for one, and it never models hazard chip or pre-existing activation state such as a Flash Fire charge, a Metronome count, or Rage Fist's hit tally. Supply your own Pokémon's exact battle stats on whichever side is yours to narrow the range; opposing stats use format-legal investment ranges, narrowed by the opposing nature only when a team sheet or the battle has revealed it. Only the stats this move actually uses are read; an implausible value falls back to the legal range with a note instead of failing the call.",
    {
      attacker: { type: "string" },
      defender: { type: "string" },
      move: { type: "string" },
      attacker_ability: {
        type: "string",
        description: "Applied exactly by the engine. Omit for a neutral, no-effect ability.",
      },
      defender_ability: {
        type: "string",
        description:
          "Applied exactly by the engine, including immunities and absorb abilities. Omit for a neutral, no-effect ability.",
      },
      attacker_stats: {
        type: "object",
        description:
          "Optional exact raw stats from your own build. Only the stat this move attacks with is read; other keys are ignored, so never pad unknown stats with placeholder values.",
        properties: {
          atk: { type: "number", exclusiveMinimum: 0 },
          def: { type: "number", exclusiveMinimum: 0 },
          spa: { type: "number", exclusiveMinimum: 0 },
          spd: { type: "number", exclusiveMinimum: 0 },
          spe: { type: "number", exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      defender_stats: {
        type: "object",
        description:
          "Optional exact raw stats when the defender is your own Pokémon. HP also drives fixed and HP-scaled damage; other keys beyond hp and the stat this move targets are ignored.",
        properties: {
          hp: { type: "number", exclusiveMinimum: 0 },
          atk: { type: "number", exclusiveMinimum: 0 },
          def: { type: "number", exclusiveMinimum: 0 },
          spa: { type: "number", exclusiveMinimum: 0 },
          spd: { type: "number", exclusiveMinimum: 0 },
          spe: { type: "number", exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      attacker_boosts: {
        type: "object",
        description: "Current stat stages on the attacker, -6 to +6.",
        properties: {
          atk: { type: "integer", minimum: -6, maximum: 6 },
          def: { type: "integer", minimum: -6, maximum: 6 },
          spa: { type: "integer", minimum: -6, maximum: 6 },
          spd: { type: "integer", minimum: -6, maximum: 6 },
          spe: { type: "integer", minimum: -6, maximum: 6 },
        },
        additionalProperties: false,
      },
      defender_boosts: {
        type: "object",
        description: "Current stat stages on the defender, -6 to +6.",
        properties: {
          atk: { type: "integer", minimum: -6, maximum: 6 },
          def: { type: "integer", minimum: -6, maximum: 6 },
          spa: { type: "integer", minimum: -6, maximum: 6 },
          spd: { type: "integer", minimum: -6, maximum: 6 },
          spe: { type: "integer", minimum: -6, maximum: 6 },
        },
        additionalProperties: false,
      },
      attacker_status: {
        type: "string",
        enum: ["brn", "par", "psn", "tox", "slp", "frz"],
        description:
          "Status on the attacker; burn, Guts, Facade, and similar interactions are engine-computed.",
      },
      defender_status: {
        type: "string",
        enum: ["brn", "par", "psn", "tox", "slp", "frz"],
        description: "Status on the defender, for moves like Hex.",
      },
      defender_screens: {
        type: "array",
        items: { type: "string", enum: ["reflect", "lightscreen", "auroraveil"] },
        description: "Screens up on the defender's side.",
      },
      terrain: {
        type: "string",
        description: "electric | grassy | misty | psychic",
      },
      weather: {
        type: "string",
        description: "sun | rain | sand | snow | desolateland | primordialsea",
      },
      helping_hand: {
        type: "boolean",
        description: "An ally used Helping Hand on the attacker this turn (1.5x).",
      },
      is_critical_hit: {
        type: "boolean",
        description:
          "Compute as a critical hit: 1.5x, ignoring the defender's positive stages and screens.",
      },
      attacker_hp_percent: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description: "Current attacker HP percentage, for HP-scaling moves and pinch abilities.",
      },
      defender_hp_percent: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description:
          "Current defender HP percentage shown in battle; also gates HP-dependent defensive abilities.",
      },
      attacker_item: {
        type: "string",
        description: "Any item; the engine applies its real effect.",
      },
      defender_item: {
        type: "string",
        description: "Any item; the engine applies its real effect.",
      },
      attacker_nature: { type: "string" },
      defender_nature: { type: "string" },
      is_spread_hit: {
        type: "boolean",
        description:
          "True when the move hits more than one Pokémon (0.75x in doubles). Defaults false outside a live battle because no second target is known; the live harness derives this from the board.",
      },
    },
    ["attacker", "defender", "move"],
  ),
];

export type SpeciesSet = [name: string, item?: string | null, nature?: string | null];

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
