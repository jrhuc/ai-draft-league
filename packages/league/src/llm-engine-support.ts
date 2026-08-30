import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applyMemoryUpdate,
  DECISION_NOTE_LIMIT,
  type BattleMemory,
  type MemoryUpdate,
  MemoryUpdateError,
} from "./battle-memory.js";
import type { SlotMenu } from "./choices.js";
import type { SheetPolicy } from "./prompts.js";
import { DEX_TOOLS } from "./reference.js";
import { normalizeStageEvidence, type StageEvidence } from "./stage-evidence.js";
import type {
  BattleRequest,
  JsonObject,
  JsonValue,
  Pid,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { clip, isRecord } from "./value.js";

export interface ParsedDecision {
  choices: number[];
  rationale?: string;
  evidence: StageEvidence;
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

export interface ToolTrace extends JsonObject {
  name: string;
  arguments: JsonObject;
  result: string;
}

export interface PendingDecision {
  prompt?: string;
  rawResponse?: string;
  evidence?: StageEvidence;
  reasoning?: string;
  generation: number;
  usage?: Record<string, number>;
  upstreamProviders?: string[];
  fallback?: boolean;
  error?: string;
  latencyMs?: number;
  toolCalls?: ToolTrace[];
  failedAttempts?: { response: string; error: string }[];
  parseFailures?: number;
  toolRounds?: number;
  errorSummary?: string;
  maxTokens?: number;
  timer?: { turnSeconds?: number; seconds?: number };
}

const decisionToolParametersSchema = z
  .object({ properties: z.record(z.string(), z.json()) })
  .passthrough();
export const replayDecisionSchema = z.object({
  request_digest: z.string(),
  pid: z.enum(["p1", "p2"]),
  series_id: z.string().nullable(),
  game_id: z.string(),
  game_number: z.number(),
  turn: z.number(),
  phase: z.enum(["team_preview", "forced_switch", "turn"]),
  action: z.string(),
  submission_id: z.string(),
  submission_source: z.enum(["model", "automatic", "model-default"]),
  outcome: z.enum(["accepted", "rejected"]),
  memory_state: z.string().optional().catch(undefined),
  notebook: z.string().optional().catch(undefined),
  rationale: z.string().optional().catch(undefined),
});
const reflectionSchema = z.object({
  summary: z.string(),
  adjustment: z.string(),
  notebook: z.json(),
});
const tournamentRetrospectiveSchema = z.object({
  summary: z.string(),
  did_well: z.string(),
  did_poorly: z.string(),
  would_change: z.string(),
});

export const FORCE_COMMIT_MS = 25_000;
export const FORCE_COMMIT_TURN_FRACTION = 0.5;
export const BANK_HEALTHY_SECONDS = 300;
export const BANK_LOW_SECONDS = 120;
const DECISION_MIN_TOKENS = 1024;
export const DECISION_MAX_TOKENS_CEILING = 65_536;
export const ASSUMED_TOKENS_PER_SECOND = 75;
const PACE_SAFETY = 0.8;
const PACE_SAMPLE_MIN_TOKENS = 256;
const PACE_SAMPLE_MIN_MS = 2000;
export const DECISION_MAX_TOOL_ROUNDS = 2;
export const DECISION_MAX_STANDARD_TOOL_CALLS = 2;
export const DECISION_MAX_ORDER_TOOL_CALLS = 1;
export const UNTIMED_MAX_TOOL_ROUNDS = 30;
export const UNTIMED_MAX_STANDARD_TOOL_CALLS = 12;
export const UNTIMED_MAX_ORDER_TOOL_CALLS = 4;
export const DECISION_PARSE_ATTEMPTS = 2;
export const UNTIMED_DECISION_PARSE_ATTEMPTS = 4;
export const DECISION_PREFILL = '{"choices": [';
export const DEX_LOOKUP_CACHE_LIMIT = 256;
export const UNTIMED_EMPTY_RESPONSE_RETRIES = 2;
export { DECISION_NOTE_LIMIT };
const DECISION_RATIONALE_LIMIT = 2000;
export const REFLECTION_MAX_TOKENS = 32_768;
export const TRANSCRIPT_CHARACTER_LIMIT = 24000;
export const TRANSCRIPT_CLIP_MARKER = "[Earlier turns are omitted from this timeline.]";

export const ACTION_ORDER_TOOL: ToolDefinition = {
  name: "compare_action_order",
  description:
    'Compare two Pokémon (active or benched) using live Speed state without revealing hidden EVs. Applies visible items, boosts, status, Tailwind, weather abilities, Trick Room, and move priority including ability modifiers (Prankster, Gale Wings, Triage, Grassy Glide, Stall, Mycelium Might) and priority items (Quick Claw, Lagging Tail); also explains Encore timing and redundant locks. Pass "switch" as a move to time a switch-out, which resolves before moves.',
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
    },
    required: ["first", "second"],
    additionalProperties: false,
  },
};

const DAMAGE_TOOL_DESCRIPTIONS = {
  open: "Estimate damage using the current battle request and open team sheets. Supply only the two visible Pokémon and move; the harness applies known abilities, items, exact own stats, opposing nature ranges, boosts, status, HP, screens, weather, terrain, both active allies with their abilities, and the fainted count that scales Last Respects. Helping Hand and critical-hit flags are optional hypothetical modifiers.",
  closed:
    "Estimate damage using the current battle request and what the battle has revealed. Supply only the two visible Pokémon and move; the harness applies revealed abilities and items, exact own stats, legal opposing stat ranges, boosts, status, HP, screens, weather, terrain, both active allies with their abilities, and the fainted count that scales Last Respects. Helping Hand and critical-hit flags are optional hypothetical modifiers.",
} satisfies Record<SheetPolicy, string>;

export function decisionTools(sheets: SheetPolicy): ToolDefinition[] {
  return [
    ...DEX_TOOLS.map((tool) => {
      if (tool.name !== "estimate_damage") return tool;
      const parameters = decisionToolParametersSchema.parse(tool.parameters);
      return {
        ...tool,
        description: DAMAGE_TOOL_DESCRIPTIONS[sheets],
        parameters: {
          ...parameters,
          properties: Object.fromEntries(
            ["attacker", "defender", "move", "helping_hand", "is_critical_hit"].map((name) => [
              name,
              parameters.properties[name] ?? null,
            ]),
          ),
        },
      };
    }),
    ACTION_ORDER_TOOL,
  ];
}

export function reflectionTools(): ToolDefinition[] {
  const allowed = new Set(["lookup_species", "lookup_move", "lookup_item", "lookup_ability"]);
  return DEX_TOOLS.filter((tool) => allowed.has(tool.name));
}

export function totalTokens(usage: Record<string, number> | undefined): number {
  return Math.trunc((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0));
}

export function reasoningField(usage: Record<string, number> | undefined): Record<string, number> {
  const value = usage?.reasoning_tokens;
  return value === undefined ? {} : { reasoning_tokens: Math.trunc(value) };
}

export function decisionTokenBudget(remainingMs: number, tokensPerSecond: number): number {
  if (!Number.isFinite(remainingMs)) return DECISION_MAX_TOKENS_CEILING;
  const feasible = Math.floor(((remainingMs / 1000) * tokensPerSecond * PACE_SAFETY) / 256) * 256;
  return Math.min(DECISION_MAX_TOKENS_CEILING, Math.max(DECISION_MIN_TOKENS, feasible));
}

export function updatedPace(
  previous: number | undefined,
  outputTokens: number,
  elapsedMs: number,
): number | undefined {
  if (outputTokens < PACE_SAMPLE_MIN_TOKENS || elapsedMs < PACE_SAMPLE_MIN_MS) return previous;
  const rate = (1000 * outputTokens) / elapsedMs;
  return previous === undefined ? rate : (previous + rate) / 2;
}

export function boundedToolCalls(calls: ToolCall[], standardMax: number, orderMax: number) {
  const order = calls.filter((call) => call.name === ACTION_ORDER_TOOL.name).slice(0, orderMax);
  const standard = calls
    .filter((call) => call.name !== ACTION_ORDER_TOOL.name)
    .slice(0, standardMax);
  const selectedIds = new Set([...standard, ...order].map((call) => call.id));
  return {
    kept: calls.filter((call) => selectedIds.has(call.id)),
    dropped: calls.filter((call) => !selectedIds.has(call.id)),
  };
}

export type DecisionPhase = "team_preview" | "forced_switch" | "turn";

const DECISION_REQUEST_DIGEST_VERSION = "battle-decision-request-v1";

export function decisionPhase(request: BattleRequest): DecisionPhase {
  return request.teamPreview ? "team_preview" : request.forceSwitch ? "forced_switch" : "turn";
}

function decisionRequestProjection(request: BattleRequest): JsonObject {
  return {
    active: request.active ?? null,
    force_switch: request.forceSwitch ?? null,
    max_chosen_team_size: request.maxChosenTeamSize ?? null,
    side: request.side ?? null,
    team_preview: request.teamPreview ?? null,
    timer: request.timer ?? null,
    wait: request.wait ?? null,
  };
}

function stableDecisionRequestJson(value: JsonObject): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!isRecord(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}

export function decisionRequestDigest(input: {
  pid: Pid;
  seriesId: string | undefined;
  gameId: string;
  gameNumber: number;
  turn: number;
  phase: DecisionPhase;
  request: BattleRequest;
  menus: SlotMenu[];
}): string {
  const projection = {
    version: DECISION_REQUEST_DIGEST_VERSION,
    pid: input.pid,
    series_id: input.seriesId ?? null,
    game_id: input.gameId,
    game_number: input.gameNumber,
    turn: input.turn,
    phase: input.phase,
    request: decisionRequestProjection(input.request),
    menus: input.menus.map((menu) =>
      menu.map((item) => ({ label: item.label, canonical_action: item.part, kind: item.kind })),
    ),
  };
  const hash = createHash("sha256").update(stableDecisionRequestJson(projection)).digest("hex");
  return `${DECISION_REQUEST_DIGEST_VERSION}:${hash}`;
}

export function extractChoices(
  response: string,
  menus: SlotMenu[],
  currentMemory: BattleMemory,
): ParsedDecision {
  const objects = jsonObjects(response, true).filter(
    (value) => "choices" in value || "choice" in value,
  );
  if (!objects.length) throw new Error("no JSON object with a choices key");
  let failure: unknown;
  for (const object of objects.reverse()) {
    try {
      return parseDecision(object, menus, currentMemory);
    } catch (caught) {
      failure ??= caught;
    }
  }
  throw failure;
}

function parseDecision(
  object: JsonObject,
  menus: SlotMenu[],
  currentMemory: BattleMemory,
): ParsedDecision {
  const rawChoices = object.choices ?? (menus.length === 1 ? [object.choice] : undefined);
  if (!Array.isArray(rawChoices) || rawChoices.length !== menus.length)
    throw new Error(`choices must be an array of exactly ${menus.length} integers`);
  const choices = rawChoices.map((choice, slot) => {
    const parsedChoice = z.number().int().safeParse(choice);
    if (!parsedChoice.success) throw new Error(`choice for slot ${slot + 1} must be an integer`);
    const index = parsedChoice.data;
    if (index < 0 || index >= menus[slot]!.length)
      throw new Error(
        `choice for slot ${slot + 1} must be between 0 and ${menus[slot]!.length - 1}`,
      );
    return index;
  });
  const evidence = normalizeStageEvidence(object.rationale, object.notebook, {
    currentMemory,
    rationaleLimit: DECISION_RATIONALE_LIMIT,
  });
  const decision: ParsedDecision = { choices, evidence };
  if (evidence.supplied.rationale) decision.rationale = evidence.rationale;
  return decision;
}

export function extractReflection(response: string, currentMemory: BattleMemory): Reflection {
  const object = jsonObjects(response)
    .filter((value) => "summary" in value || "adjustment" in value)
    .at(-1);
  if (!object) throw new Error("no JSON game review found");
  const parsed = reflectionSchema.safeParse(object);
  if (!parsed.success)
    throw new Error("review must contain summary, adjustment, and notebook fields");
  const memoryUpdate = applyMemoryUpdate(currentMemory, parsed.data.notebook as JsonValue);
  if (!memoryUpdate.accepted) throw new MemoryUpdateError(memoryUpdate);
  return {
    summary: clip(parsed.data.summary, DECISION_RATIONALE_LIMIT),
    adjustment: clip(parsed.data.adjustment, DECISION_RATIONALE_LIMIT),
    memory: memoryUpdate.memory,
    memoryUpdate,
  };
}

export function extractTournamentRetrospective(
  response: string,
  currentMemory: BattleMemory,
): Reflection {
  const object = jsonObjects(response)
    .filter((value) => "summary" in value || "did_well" in value)
    .at(-1);
  if (!object) throw new Error("no JSON tournament retrospective found");
  const parsed = tournamentRetrospectiveSchema.safeParse(object);
  if (!parsed.success)
    throw new Error(
      "retrospective must contain string summary, did_well, did_poorly, and would_change fields",
    );
  return {
    summary: clip(parsed.data.summary, DECISION_RATIONALE_LIMIT),
    adjustment: "",
    memory: currentMemory,
    memoryUpdate: applyMemoryUpdate(currentMemory, undefined),
    retrospective: {
      didWell: clip(parsed.data.did_well, DECISION_RATIONALE_LIMIT),
      didPoorly: clip(parsed.data.did_poorly, DECISION_RATIONALE_LIMIT),
      wouldChange: clip(parsed.data.would_change, DECISION_RATIONALE_LIMIT),
    },
  };
}

function jsonObjects(input: string, preferOuterDecision = false): JsonObject[] {
  const matches: Array<{ value: JsonObject; start: number; end: number }> = [];
  for (let start = input.indexOf("{"); start >= 0; start = input.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const value: JsonValue = JSON.parse(input.slice(start, index + 1));
          if (isRecord(value)) matches.push({ value, start, end: index });
        } catch {}
        break;
      }
    }
  }
  if (!preferOuterDecision) return matches.map(({ value }) => value);
  return matches
    .filter(
      (match) =>
        !matches.some(
          (parent) =>
            parent.start < match.start &&
            parent.end >= match.end &&
            ("choices" in parent.value || "choice" in parent.value) &&
            (typeof parent.value.rationale === "string" ||
              typeof parent.value.notebook === "string" ||
              isRecord(parent.value.notebook)),
        ),
    )
    .map(({ value }) => value);
}
