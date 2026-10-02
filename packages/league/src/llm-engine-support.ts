import { z } from "zod";
import {
  applyMemoryUpdate,
  type BattleMemory,
  type MemoryUpdate,
  MemoryUpdateError,
  notebookSchema,
} from "./battle-memory.js";
import type { SlotMenu } from "./choices.js";
import type { SheetPolicy } from "./prompts.js";
import { DEX_TOOLS } from "./reference.js";
import type { BattleRequest, JsonObject, ToolDefinition } from "./types.js";

interface EvidenceSupplied {
  rationale: boolean;
  notebookUpdate: boolean;
}

export interface DecisionEvidence {
  rationale: string;
  memory: BattleMemory;
  memoryUpdate: MemoryUpdate;
  supplied: EvidenceSupplied;
}

export interface ParsedDecision {
  choices: number[];
  evidence: DecisionEvidence;
}

export interface Reflection {
  summary: string;
  adjustment: string;
  memory: BattleMemory;
  memoryUpdate: MemoryUpdate;
  retrospective?: {
    didWell: string;
    didPoorly: string;
    wouldChange: string;
  };
}

const decisionToolParametersSchema = z
  .object({ properties: z.record(z.string(), z.json()) })
  .passthrough();

const reviewText = z.string().max(2000);

export const decisionSchema = z.object({
  choices: z
    .array(z.int().min(0))
    .min(1)
    .describe("The menu index chosen for each displayed slot, in slot order."),
  rationale: reviewText.optional().describe("Why this joint action; kept in your private history."),
  notebook: notebookSchema.optional(),
});
export const reflectionSchema = z.object({
  summary: reviewText.describe("Your assessment of the game."),
  adjustment: reviewText.optional().describe("What, if anything, to keep or change next game."),
  notebook: notebookSchema.optional(),
});
export const retrospectiveSchema = z.object({
  summary: reviewText.describe("Your assessment of your tournament run."),
  did_well: reviewText,
  did_poorly: reviewText,
  would_change: reviewText,
});

export const BATTLE_HISTORY_TOOL: ToolDefinition = {
  name: "read_battle_history",
  description:
    "Read your private Showdown observations, submitted choices and stated reasons, and reviews from a game in this series, including earlier games and turns omitted from the prompt. Submitted choices may have been rejected by Showdown. For another page, repeat the same game_number and from_turn with the returned next_offset.",
  parameters: {
    type: "object",
    properties: {
      game_number: { type: "integer", minimum: 1 },
      from_turn: {
        type: "integer",
        minimum: 0,
        description: "First turn to include; defaults to 0.",
      },
      offset: { type: "integer", minimum: 0, description: "Character offset; defaults to 0." },
    },
    required: ["game_number"],
    additionalProperties: false,
  },
};

export const ACTION_ORDER_TOOL: ToolDefinition = {
  name: "compare_action_order",
  description:
    'Compare two Pokémon (active, benched, or any two registered at team preview) using live Speed state without revealing hidden EVs. Applies visible items, boosts, status, Tailwind, weather abilities, Trick Room, and move priority including ability modifiers (Prankster, Gale Wings, Triage, Grassy Glide, Stall, Mycelium Might) and priority items (Quick Claw, Lagging Tail); also explains Encore timing and redundant locks. A Speed change takes effect the moment it happens, so to see the order after a Tailwind, Icy Wind, Trick Room or weather that goes up earlier in the same turn, set the matching hypothetical. Pass "switch" as a move to time a switch-out, which resolves before moves.',
  parameters: {
    type: "object",
    properties: {
      first: {
        type: "string",
        description: "Species name (active or benched) or ally/foe slot, such as ally 1.",
      },
      second: {
        type: "string",
        description: "Species name (active or benched) or ally/foe slot, such as foe 2.",
      },
      first_move: {
        type: "string",
        description:
          'Optional move being considered for the first Pokémon, or "switch" for switching out.',
      },
      second_move: {
        type: "string",
        description:
          'Optional move being considered for the second Pokémon, or "switch" for switching out.',
      },
      first_mega: {
        type: "boolean",
        description: "Compare the first Pokémon after a legal Mega Evolution with its known stone.",
      },
      second_mega: {
        type: "boolean",
        description:
          "Compare the second Pokémon after a legal Mega Evolution with its known stone.",
      },
      weather: {
        type: "string",
        description:
          "Hypothetical weather: sun, rain, sand, snow, or none. Defaults to the live weather.",
      },
      first_speed_stage: {
        type: "integer",
        minimum: -6,
        maximum: 6,
        description:
          "Hypothetical Speed stage for the first Pokémon, such as -1 after Icy Wind or +1 after Dragon Dance. Defaults to its live stage.",
      },
      second_speed_stage: {
        type: "integer",
        minimum: -6,
        maximum: 6,
        description: "Hypothetical Speed stage for the second Pokémon.",
      },
      first_tailwind: {
        type: "boolean",
        description:
          "Whether Tailwind is up on the first Pokémon's side for this comparison. Defaults to the live field.",
      },
      second_tailwind: {
        type: "boolean",
        description: "Whether Tailwind is up on the second Pokémon's side for this comparison.",
      },
      trick_room: {
        type: "boolean",
        description: "Whether Trick Room is up for this comparison. Defaults to the live field.",
      },
    },
    required: ["first", "second"],
    additionalProperties: false,
  },
};

const BATTLER_DESCRIPTION =
  "Species name, or a slot: ally 1, ally 2, foe 1, foe 2. When both sides have the species, prefix it: ally Charizard or foe Charizard.";

function stagesParameter(description: string): JsonObject {
  const stage = { type: "integer", minimum: -6, maximum: 6 };
  return {
    type: "object",
    description,
    properties: { atk: stage, def: stage, spa: stage, spd: stage, spe: stage },
    additionalProperties: false,
  };
}

const DAMAGE_TOOL_DESCRIPTIONS = {
  open: "Estimate conditional hit outcomes using the current battle request and open team sheets. Hits are assumed to connect; evaluated endpoints do not establish exhaustive KO certainty or resolve action-level effects such as protection or redirection. Supply only the two visible Pokémon and move; the harness applies known abilities, items, exact own stats, opposing nature ranges, boosts, status, HP, screens, weather, terrain, both active allies with their abilities, the fainted count that scales Last Respects, and the hits the attacker has taken that scale Rage Fist. Helping Hand, critical-hit and hits-taken inputs are optional hypothetical overrides.",
  closed:
    "Estimate conditional hit outcomes using the current battle request and what the battle has revealed. Hits are assumed to connect; evaluated endpoints do not establish exhaustive KO certainty or resolve action-level effects such as protection or redirection. Supply only the two visible Pokémon and move; the harness applies revealed abilities and items, exact own stats, legal opposing stat ranges, boosts, status, HP, screens, weather, terrain, both active allies with their abilities, the fainted count that scales Last Respects, and the hits the attacker has taken that scale Rage Fist; anything unrevealed is treated as neutral across legal ranges. Helping Hand, critical-hit and hits-taken inputs are optional hypothetical overrides.",
} satisfies Record<SheetPolicy, string>;

export function decisionTools(sheets: SheetPolicy): ToolDefinition[] {
  return [
    ...DEX_TOOLS.map((tool) => {
      if (tool.name !== "estimate_damage") return tool;
      const parameters = decisionToolParametersSchema.parse(tool.parameters);
      return {
        ...tool,
        description: `${DAMAGE_TOOL_DESCRIPTIONS[sheets]} Any two registered Pokémon can be evaluated at team preview. A benched Pokémon fills an empty slot on its side; when the side is full it is evaluated in each slot it could take, unless attacker_replaces or defender_replaces names the one that leaves. Switch-in events are not simulated. Set attacker_mega or defender_mega to evaluate its legal Mega forme with the known stone, which also brings the weather its ability sets; weather, terrain and each side's stat stages default to the live state and can be overridden; the live state is unchanged.`,
        parameters: {
          ...parameters,
          properties: {
            ...Object.fromEntries(
              ["move", "helping_hand", "is_critical_hit", "attacker_hits_taken"].map((name) => [
                name,
                parameters.properties[name] ?? null,
              ]),
            ),
            attacker: { type: "string", description: BATTLER_DESCRIPTION },
            defender: { type: "string", description: BATTLER_DESCRIPTION },
            attacker_boosts: stagesParameter(
              'Hypothetical stat stages for the attacker, such as {"atk": 2} after Swords Dance or {"atk": -1} after an Intimidate. Stats left out keep their live stage.',
            ),
            defender_boosts: stagesParameter(
              "Hypothetical stat stages for the defender. Stats left out keep their live stage.",
            ),
            weather: {
              type: "string",
              description:
                "Hypothetical weather: sun, rain, sand, snow, or none. Defaults to the live weather; use it to see a Chlorophyll or sun-boosted line before Drought is up.",
            },
            terrain: {
              type: "string",
              description:
                "Hypothetical terrain: electric, grassy, misty, psychic, or none. Defaults to the live terrain.",
            },
            attacker_mega: {
              type: "boolean",
              description: "Evaluate the attacker after Mega Evolving.",
            },
            defender_mega: {
              type: "boolean",
              description: "Evaluate the defender after Mega Evolving.",
            },
            attacker_replaces: {
              type: "string",
              description:
                "For a benched attacker, the same-side active Pokémon or slot it replaces.",
            },
            defender_replaces: {
              type: "string",
              description:
                "For a benched defender, the same-side active Pokémon or slot it replaces.",
            },
          },
        },
      };
    }),
    ACTION_ORDER_TOOL,
    BATTLE_HISTORY_TOOL,
  ];
}

export function totalTokens(usage: Record<string, number> | undefined): number {
  return Math.trunc((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0));
}

export function reasoningField(usage: Record<string, number> | undefined): Record<string, number> {
  const value = usage?.reasoning_tokens;
  return value === undefined ? {} : { reasoning_tokens: Math.trunc(value) };
}

export type DecisionPhase = "team_preview" | "forced_switch" | "turn";

export function decisionPhase(request: BattleRequest): DecisionPhase {
  return request.teamPreview ? "team_preview" : request.forceSwitch ? "forced_switch" : "turn";
}

export function parseDecision(
  object: JsonObject,
  menus: SlotMenu[],
  currentMemory: BattleMemory,
): ParsedDecision {
  const reply = decisionSchema.safeParse(object);
  if (!reply.success) throw new Error(z.prettifyError(reply.error));
  if (reply.data.choices.length !== menus.length)
    throw new Error(
      `choices must hold exactly ${menus.length} ${menus.length === 1 ? "entry" : "entries"}, one per displayed slot in slot order`,
    );
  for (const [slot, index] of reply.data.choices.entries())
    if (index >= menus[slot]!.length)
      throw new Error(
        `choice for slot ${slot + 1} must be between 0 and ${menus[slot]!.length - 1}`,
      );
  const memoryUpdate = applyMemoryUpdate(currentMemory, reply.data.notebook);
  if (!memoryUpdate.accepted) throw new MemoryUpdateError(memoryUpdate);
  const rationale = reply.data.rationale?.trim();
  return {
    choices: reply.data.choices,
    evidence: {
      rationale: rationale ?? "",
      memory: memoryUpdate.memory,
      memoryUpdate,
      supplied: { rationale: rationale !== undefined, notebookUpdate: memoryUpdate.supplied },
    },
  };
}

export function noDecisionEvidence(currentMemory: BattleMemory): DecisionEvidence {
  const memoryUpdate = applyMemoryUpdate(currentMemory, undefined);
  return {
    rationale: "",
    memory: currentMemory,
    memoryUpdate,
    supplied: { rationale: false, notebookUpdate: false },
  };
}

export function parseReflection(object: JsonObject, currentMemory: BattleMemory): Reflection {
  const reply = reflectionSchema.safeParse(object);
  if (!reply.success) throw new Error(z.prettifyError(reply.error));
  const memoryUpdate = applyMemoryUpdate(currentMemory, reply.data.notebook);
  if (!memoryUpdate.accepted) throw new MemoryUpdateError(memoryUpdate);
  return {
    summary: reply.data.summary,
    adjustment: reply.data.adjustment ?? "",
    memory: memoryUpdate.memory,
    memoryUpdate,
  };
}

export function parseTournamentRetrospective(
  object: JsonObject,
  currentMemory: BattleMemory,
): Reflection {
  const reply = retrospectiveSchema.safeParse(object);
  if (!reply.success) throw new Error(z.prettifyError(reply.error));
  return {
    summary: reply.data.summary,
    adjustment: "",
    memory: currentMemory,
    memoryUpdate: applyMemoryUpdate(currentMemory, undefined),
    retrospective: {
      didWell: reply.data.did_well,
      didPoorly: reply.data.did_poorly,
      wouldChange: reply.data.would_change,
    },
  };
}
