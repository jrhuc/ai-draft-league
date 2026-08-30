import { z } from "zod";
import type { JsonObject, JsonValue } from "./types.js";

export const TEAM_PLAYBOOK_LIMIT = 3500;
export const SERIES_MEMORY_LIMIT = 3000;
export const NEXT_GAME_PLAN_LIMIT = 1500;
export const STRATEGIC_MEMORY_LIMIT =
  TEAM_PLAYBOOK_LIMIT + SERIES_MEMORY_LIMIT + NEXT_GAME_PLAN_LIMIT;
export const VERIFIED_REFERENCE_LIMIT = 2000;
export const VERIFIED_REFERENCE_COUNT_LIMIT = 24;

export type MemoryUpdateScope = "series" | "next-round" | "rematch";

export interface VerifiedReference {
  tool: string;
  arguments: JsonObject;
  format: string;
  revision: string;
  result: string;
}

export interface StrategicMemory {
  teamPlaybook: string;
  seriesMemory: string;
  nextGamePlan: string;
  verifiedReferences: VerifiedReference[];
}

interface ParsedUpdate {
  team_playbook: string;
  series_memory?: string;
  next_game_plan?: string;
}

const REFERENCE_TOOLS = new Set(["lookup_species", "lookup_move", "lookup_item", "lookup_ability"]);
const referenceSchema = z
  .object({
    tool: z.string(),
    arguments: z.record(z.string(), z.json()),
    format: z.string(),
    revision: z.string(),
    result: z.string(),
  })
  .strict();
const storedMemorySchema = z
  .object({
    team_playbook: z.string(),
    series_memory: z.string(),
    next_game_plan: z.string(),
    verified_references: z.array(referenceSchema),
  })
  .strict();
const seriesUpdateSchema = z
  .object({
    team_playbook: z.string(),
    series_memory: z.string(),
    next_game_plan: z.string(),
  })
  .strict();
const nextRoundUpdateSchema = z.object({ team_playbook: z.string() }).strict();
const rematchUpdateSchema = z
  .object({ team_playbook: z.string(), series_memory: z.string() })
  .strict();

const emptyMemory = (): StrategicMemory => ({
  teamPlaybook: "",
  seriesMemory: "",
  nextGamePlan: "",
  verifiedReferences: [],
});

function boundedText(name: string, value: string, limit: number): string {
  const normalized = value.trim();
  if (normalized.length > limit)
    throw new Error(
      `${name} is ${normalized.length} characters; limit ${limit}; compress it to the durable facts that change future choices`,
    );
  return normalized;
}

function boundedReferences(references: VerifiedReference[]): VerifiedReference[] {
  if (references.length > VERIFIED_REFERENCE_COUNT_LIMIT)
    throw new Error(`verified_references exceeds ${VERIFIED_REFERENCE_COUNT_LIMIT} entries`);
  if (JSON.stringify(references).length > VERIFIED_REFERENCE_LIMIT)
    throw new Error(`verified_references exceeds ${VERIFIED_REFERENCE_LIMIT} characters`);
  return references;
}

function validateMemory(memory: StrategicMemory): StrategicMemory {
  return {
    teamPlaybook: boundedText("team_playbook", memory.teamPlaybook, TEAM_PLAYBOOK_LIMIT),
    seriesMemory: boundedText("series_memory", memory.seriesMemory, SERIES_MEMORY_LIMIT),
    nextGamePlan: boundedText("next_game_plan", memory.nextGamePlan, NEXT_GAME_PLAN_LIMIT),
    verifiedReferences: boundedReferences(memory.verifiedReferences),
  };
}

function serializeMemory(memory: StrategicMemory): string {
  const validated = validateMemory(memory);
  if (
    !validated.teamPlaybook &&
    !validated.seriesMemory &&
    !validated.nextGamePlan &&
    !validated.verifiedReferences.length
  )
    return "";
  return JSON.stringify({
    team_playbook: validated.teamPlaybook,
    series_memory: validated.seriesMemory,
    next_game_plan: validated.nextGamePlan,
    verified_references: validated.verifiedReferences,
  });
}

function scopedReferences(
  references: VerifiedReference[],
  scope: Pick<VerifiedReference, "format" | "revision">,
): VerifiedReference[] {
  return references.filter(
    (reference) => reference.format === scope.format && reference.revision === scope.revision,
  );
}

export function parseStrategicMemory(value: string): StrategicMemory {
  const normalized = value.trim();
  if (!normalized) return emptyMemory();
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return validateMemory({ ...emptyMemory(), teamPlaybook: normalized });
  }
  const result = storedMemorySchema.safeParse(parsed);
  if (!result.success) throw new Error("stored notebook is not valid scoped strategic memory");
  return validateMemory({
    teamPlaybook: result.data.team_playbook,
    seriesMemory: result.data.series_memory,
    nextGamePlan: result.data.next_game_plan,
    verifiedReferences: result.data.verified_references,
  });
}

export function normalizeStrategicMemory(
  value: string,
  reference?: Pick<VerifiedReference, "format" | "revision">,
): string {
  const memory = parseStrategicMemory(value);
  return serializeMemory({
    ...memory,
    verifiedReferences: reference
      ? scopedReferences(memory.verifiedReferences, reference)
      : memory.verifiedReferences,
  });
}

function parseUpdate(value: JsonValue, scope: MemoryUpdateScope): ParsedUpdate {
  const schema =
    scope === "series"
      ? seriesUpdateSchema
      : scope === "next-round"
        ? nextRoundUpdateSchema
        : rematchUpdateSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields =
      scope === "series"
        ? "team_playbook, series_memory, and next_game_plan"
        : scope === "next-round"
          ? "team_playbook"
          : "team_playbook and series_memory";
    throw new Error(`notebook must be an object containing exactly ${fields}`);
  }
  return parsed.data;
}

export function applyStrategicMemoryUpdate(
  currentNotebook: string,
  update: JsonValue,
  scope: MemoryUpdateScope,
): string {
  const current = parseStrategicMemory(currentNotebook);
  const parsed = parseUpdate(update, scope);
  if (scope === "series")
    return serializeMemory({
      teamPlaybook: parsed.team_playbook,
      seriesMemory: parsed.series_memory ?? "",
      nextGamePlan: parsed.next_game_plan ?? "",
      verifiedReferences: current.verifiedReferences,
    });
  if (scope === "next-round")
    return serializeMemory({
      teamPlaybook: parsed.team_playbook,
      seriesMemory: "",
      nextGamePlan: "",
      verifiedReferences: current.verifiedReferences,
    });
  return serializeMemory({
    teamPlaybook: parsed.team_playbook,
    seriesMemory: parsed.series_memory ?? "",
    nextGamePlan: "",
    verifiedReferences: current.verifiedReferences,
  });
}

export function scopeStrategicMemory(
  notebook: string,
  referenceNotebook: string,
  scope: MemoryUpdateScope,
): string {
  const memory = parseStrategicMemory(notebook);
  const references = parseStrategicMemory(referenceNotebook).verifiedReferences;
  return serializeMemory({
    teamPlaybook: memory.teamPlaybook,
    seriesMemory: scope === "next-round" ? "" : memory.seriesMemory,
    nextGamePlan: "",
    verifiedReferences: references,
  });
}

export function rememberVerifiedReference(notebook: string, input: VerifiedReference): string {
  if (!REFERENCE_TOOLS.has(input.tool)) return notebook;
  const result = input.result.trim();
  if (!result) return notebook;
  const memory = parseStrategicMemory(notebook);
  const key = `${input.tool}:${JSON.stringify(input.arguments)}`;
  const references = scopedReferences(memory.verifiedReferences, input).filter(
    (reference) => `${reference.tool}:${JSON.stringify(reference.arguments)}` !== key,
  );
  const entry = { ...input, result };
  if (JSON.stringify([entry]).length > VERIFIED_REFERENCE_LIMIT)
    return serializeMemory({ ...memory, verifiedReferences: references });
  references.push(entry);
  while (
    references.length > VERIFIED_REFERENCE_COUNT_LIMIT ||
    JSON.stringify(references).length > VERIFIED_REFERENCE_LIMIT
  )
    references.shift();
  return serializeMemory({ ...memory, verifiedReferences: references });
}

export function renderStrategicMemory(value: string): string {
  const memory = parseStrategicMemory(value);
  return [
    "Team playbook:",
    memory.teamPlaybook || "(empty)",
    "Series memory:",
    memory.seriesMemory || "(empty)",
    "Next-game plan:",
    memory.nextGamePlan || "(empty)",
    "Verified references (harness-managed):",
    ...(memory.verifiedReferences.length
      ? memory.verifiedReferences.map((reference) => JSON.stringify(reference))
      : ["(empty)"]),
  ].join("\n");
}
