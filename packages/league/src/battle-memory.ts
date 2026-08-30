import { z } from "zod";
import type { JsonObject, JsonValue } from "./types.js";
import { isRecord } from "./value.js";

export const TEAM_PLAYBOOK_CHAR_LIMIT = 3500;
export const SERIES_MEMORY_CHAR_LIMIT = 3000;
export const NEXT_GAME_PLAN_CHAR_LIMIT = 1500;
export const DECISION_NOTE_LIMIT = 8000;
export const VERIFIED_REFERENCE_CHAR_LIMIT = 2000;
export const VERIFIED_REFERENCE_ENTRY_LIMIT = 24;

const referenceToolSchema = z.enum([
  "lookup_species",
  "lookup_move",
  "lookup_item",
  "lookup_ability",
]);
const memoryNotebookSchema = z.strictObject({
  team_playbook: z.string(),
  series_memory: z.string(),
  next_game_plan: z.string(),
});
const verifiedReferenceSchema = z.strictObject({
  tool: referenceToolSchema,
  arguments: z.record(z.string(), z.json()),
  result: z.string().min(1),
});
const storedMemorySchema = z.strictObject({
  version: z.literal(1),
  authority: z.string().min(1),
  team_playbook: z.string(),
  series_memory: z.string(),
  next_game_plan: z.string(),
  verified_references: z.array(verifiedReferenceSchema).max(VERIFIED_REFERENCE_ENTRY_LIMIT),
});

export type VerifiedReferenceTool = z.infer<typeof referenceToolSchema>;

export interface VerifiedReference {
  tool: VerifiedReferenceTool;
  arguments: JsonObject;
  result: string;
}

export interface BattleMemory {
  authority: string;
  teamPlaybook: string;
  seriesMemory: string;
  nextGamePlan: string;
  verifiedReferences: VerifiedReference[];
}

export interface MemoryUpdate {
  supplied: boolean;
  accepted: boolean;
  proposedCharacters: number;
  storedCharacters: number;
  memory: BattleMemory;
  error?: string;
}

export class MemoryUpdateError extends Error {
  constructor(readonly update: MemoryUpdate) {
    super(update.error ?? "invalid private notebook");
    this.name = "MemoryUpdateError";
  }
}

export function emptyBattleMemory(authority: string): BattleMemory {
  return {
    authority,
    teamPlaybook: "",
    seriesMemory: "",
    nextGamePlan: "",
    verifiedReferences: [],
  };
}

export function createBattleMemory(input: string | undefined, authority: string): BattleMemory {
  const value = input?.trim() ?? "";
  if (!value) return emptyBattleMemory(authority);
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return legacyBattleMemory(value, authority);
  }
  if (!isRecord(decoded)) return legacyBattleMemory(value, authority);
  if (decoded.version !== 1) throw new Error("invalid battle memory state");
  const parsed = storedMemorySchema.safeParse(decoded);
  if (!parsed.success) throw new Error("invalid battle memory state");
  const memory: BattleMemory = {
    authority,
    teamPlaybook: parsed.data.team_playbook.trim(),
    seriesMemory: parsed.data.series_memory.trim(),
    nextGamePlan: parsed.data.next_game_plan.trim(),
    verifiedReferences:
      parsed.data.authority === authority
        ? parsed.data.verified_references.map((entry) => ({
            tool: entry.tool,
            arguments: entry.arguments as JsonObject,
            result: entry.result.trim(),
          }))
        : [],
  };
  assertMemoryLimits(memory);
  return memory;
}

export function serializeBattleMemory(memory: BattleMemory): string {
  assertMemoryLimits(memory);
  return JSON.stringify({
    version: 1,
    authority: memory.authority,
    team_playbook: memory.teamPlaybook,
    series_memory: memory.seriesMemory,
    next_game_plan: memory.nextGamePlan,
    verified_references: memory.verifiedReferences,
  });
}

export function applyMemoryUpdate(current: BattleMemory, value: JsonValue | undefined): MemoryUpdate {
  const supplied = typeof value === "string" || isRecord(value);
  if (!supplied) return unchangedMemoryUpdate(current, false);
  const parsed =
    typeof value === "string"
      ? {
          success: true as const,
          data: {
            team_playbook: "",
            series_memory: value,
            next_game_plan: "",
          },
        }
      : memoryNotebookSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ...unchangedMemoryUpdate(current, true),
      error:
        'notebook must be {"team_playbook":"...","series_memory":"...","next_game_plan":"..."}',
    };
  }
  const fields = {
    teamPlaybook: parsed.data.team_playbook.trim(),
    seriesMemory: parsed.data.series_memory.trim(),
    nextGamePlan: parsed.data.next_game_plan.trim(),
  };
  const proposedCharacters =
    fields.teamPlaybook.length + fields.seriesMemory.length + fields.nextGamePlan.length;
  const violations = [
    fields.teamPlaybook.length > TEAM_PLAYBOOK_CHAR_LIMIT
      ? `team_playbook is ${fields.teamPlaybook.length}/${TEAM_PLAYBOOK_CHAR_LIMIT} characters`
      : "",
    fields.seriesMemory.length > SERIES_MEMORY_CHAR_LIMIT
      ? `series_memory is ${fields.seriesMemory.length}/${SERIES_MEMORY_CHAR_LIMIT} characters`
      : "",
    fields.nextGamePlan.length > NEXT_GAME_PLAN_CHAR_LIMIT
      ? `next_game_plan is ${fields.nextGamePlan.length}/${NEXT_GAME_PLAN_CHAR_LIMIT} characters`
      : "",
    proposedCharacters > DECISION_NOTE_LIMIT
      ? `strategic memory is ${proposedCharacters}/${DECISION_NOTE_LIMIT} characters`
      : "",
  ].filter(Boolean);
  if (violations.length) {
    return {
      ...unchangedMemoryUpdate(current, true),
      proposedCharacters,
      error: `notebook exceeds its budget: ${violations.join("; ")}`,
    };
  }
  const memory = { ...current, ...fields };
  return {
    supplied: true,
    accepted: true,
    proposedCharacters,
    storedCharacters: proposedCharacters,
    memory,
  };
}

export function memoryUpdateTelemetry(update: MemoryUpdate): JsonObject {
  return {
    supplied: update.supplied,
    accepted: update.accepted,
    proposed_characters: update.proposedCharacters,
    stored_characters: update.storedCharacters,
    error: update.error,
  };
}

export function memoryTelemetry(memory: BattleMemory): JsonObject {
  return {
    team_playbook_characters: memory.teamPlaybook.length,
    series_memory_characters: memory.seriesMemory.length,
    next_game_plan_characters: memory.nextGamePlan.length,
    strategic_characters: strategicMemoryCharacters(memory),
    verified_reference_characters: verifiedReferenceCharacters(memory.verifiedReferences),
    verified_reference_entries: memory.verifiedReferences.length,
  };
}

export function renderStrategicMemory(memory: BattleMemory): string {
  return [
    `Team playbook (${memory.teamPlaybook.length}/${TEAM_PLAYBOOK_CHAR_LIMIT}): ${memory.teamPlaybook || "(empty)"}`,
    `Series memory (${memory.seriesMemory.length}/${SERIES_MEMORY_CHAR_LIMIT}): ${memory.seriesMemory || "(empty)"}`,
    `Next-game plan (${memory.nextGamePlan.length}/${NEXT_GAME_PLAN_CHAR_LIMIT}): ${memory.nextGamePlan || "(empty)"}`,
  ].join("\n");
}

export function renderVerifiedReferenceMemory(memory: BattleMemory): string {
  if (!memory.verifiedReferences.length) return "(empty)";
  return memory.verifiedReferences.map(renderVerifiedReference).join("\n");
}

export function renderNotebook(memory: BattleMemory): string {
  const sections = [
    memory.teamPlaybook ? ["Team playbook", memory.teamPlaybook] : undefined,
    memory.seriesMemory ? ["Series memory", memory.seriesMemory] : undefined,
    memory.nextGamePlan ? ["Next-game plan", memory.nextGamePlan] : undefined,
  ].filter((section): section is string[] => section !== undefined);
  if (!sections.length) return "";
  if (sections.length === 1) return sections[0]![1]!;
  return sections.map(([name, contents]) => `${name}:\n${contents}`).join("\n\n");
}

export function nextOpponentMemory(memory: BattleMemory): BattleMemory {
  return { ...memory, seriesMemory: "", nextGamePlan: "" };
}

export function rememberVerifiedReference(
  memory: BattleMemory,
  tool: string,
  args: JsonObject,
  result: string,
): BattleMemory {
  const parsedTool = referenceToolSchema.safeParse(tool);
  const trimmed = result.trim();
  if (
    !parsedTool.success ||
    !trimmed ||
    /^(?:Not executed|Tool error|Unknown )/i.test(trimmed)
  )
    return memory;
  const entry: VerifiedReference = {
    tool: parsedTool.data,
    arguments: JSON.parse(stableJson(args)) as JsonObject,
    result: trimmed,
  };
  if (renderVerifiedReference(entry).length > VERIFIED_REFERENCE_CHAR_LIMIT) return memory;
  const key = verifiedReferenceKey(entry);
  const verifiedReferences = memory.verifiedReferences.filter(
    (existing) => verifiedReferenceKey(existing) !== key,
  );
  verifiedReferences.push(entry);
  while (
    verifiedReferences.length > VERIFIED_REFERENCE_ENTRY_LIMIT ||
    verifiedReferenceCharacters(verifiedReferences) > VERIFIED_REFERENCE_CHAR_LIMIT
  )
    verifiedReferences.shift();
  return { ...memory, verifiedReferences };
}

function legacyBattleMemory(value: string, authority: string): BattleMemory {
  const memory = { ...emptyBattleMemory(authority), seriesMemory: value };
  assertMemoryLimits(memory);
  return memory;
}

function unchangedMemoryUpdate(memory: BattleMemory, supplied: boolean): MemoryUpdate {
  return {
    supplied,
    accepted: !supplied,
    proposedCharacters: 0,
    storedCharacters: strategicMemoryCharacters(memory),
    memory,
  };
}

function assertMemoryLimits(memory: BattleMemory): void {
  const update = applyMemoryUpdate(memory, {
    team_playbook: memory.teamPlaybook,
    series_memory: memory.seriesMemory,
    next_game_plan: memory.nextGamePlan,
  });
  if (!update.accepted) throw new MemoryUpdateError(update);
  if (memory.verifiedReferences.length > VERIFIED_REFERENCE_ENTRY_LIMIT)
    throw new Error("verified reference entry limit exceeded");
  if (verifiedReferenceCharacters(memory.verifiedReferences) > VERIFIED_REFERENCE_CHAR_LIMIT)
    throw new Error("verified reference character limit exceeded");
}

function strategicMemoryCharacters(memory: BattleMemory): number {
  return memory.teamPlaybook.length + memory.seriesMemory.length + memory.nextGamePlan.length;
}

function verifiedReferenceCharacters(entries: VerifiedReference[]): number {
  return entries.reduce((total, entry, index) => total + renderVerifiedReference(entry).length + index, 0);
}

function renderVerifiedReference(entry: VerifiedReference): string {
  return `${entry.tool}(${stableJson(entry.arguments)}): ${entry.result}`;
}

function verifiedReferenceKey(entry: VerifiedReference): string {
  return `${entry.tool}:${stableJson(entry.arguments)}`;
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!isRecord(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}
