import { z } from "zod";
import type { JsonObject, JsonValue } from "./types.js";
import { isRecord, isText } from "./value.js";

export const TEAM_PLAYBOOK_CHAR_LIMIT = 3500;
export const SERIES_MEMORY_CHAR_LIMIT = 3000;
export const NEXT_GAME_PLAN_CHAR_LIMIT = 1500;
export const DECISION_NOTE_LIMIT = 8000;
export const VERIFIED_REFERENCE_CHAR_LIMIT = 4000;
export const VERIFIED_REFERENCE_ENTRY_LIMIT = 24;

const referenceToolSchema = z.enum([
  "lookup_species",
  "lookup_move",
  "lookup_item",
  "lookup_ability",
]);
const notebookSchema = z.strictObject({
  team_playbook: z.string(),
  series_memory: z.string(),
  next_game_plan: z.string(),
});
const verifiedReferenceSchema = z.strictObject({
  tool: referenceToolSchema,
  arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
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
  /** Format and Showdown revision the verified references were looked up against. */
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

/**
 * A seed is either this module's own stored state (recognised by its leading
 * brace) or a plain team playbook written by an earlier stage such as
 * teambuilding. Verified references only survive under the same authority.
 */
export function createBattleMemory(seed: string | undefined, authority: string): BattleMemory {
  const value = seed?.trim() ?? "";
  if (!value) return emptyBattleMemory(authority);
  if (!value.startsWith("{")) {
    const update = applyMemoryUpdate(emptyBattleMemory(authority), {
      team_playbook: value,
      series_memory: "",
      next_game_plan: "",
    });
    if (!update.accepted) throw new MemoryUpdateError(update);
    return update.memory;
  }
  const stored = storedMemorySchema.parse(JSON.parse(value));
  const memory: BattleMemory = {
    authority,
    teamPlaybook: stored.team_playbook.trim(),
    seriesMemory: stored.series_memory.trim(),
    nextGamePlan: stored.next_game_plan.trim(),
    verifiedReferences:
      stored.authority === authority
        ? stored.verified_references.map((entry) => ({ ...entry, result: entry.result.trim() }))
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

/** The readable notebook behind a stored state, for prompts that quote a finished series. */
export function storedNotebookText(seed: string): string {
  const value = seed.trim();
  if (!value.startsWith("{")) return value;
  const stored = storedMemorySchema.parse(JSON.parse(value));
  return renderNotebook(createBattleMemory(value, stored.authority));
}

export function applyMemoryUpdate(
  current: BattleMemory,
  value: JsonValue | undefined,
): MemoryUpdate {
  const supplied = isRecord(value) || isText(value);
  if (!supplied) return unchangedMemoryUpdate(current, false);
  const parsed = notebookSchema.safeParse(value);
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
  return {
    supplied: true,
    accepted: true,
    proposedCharacters,
    storedCharacters: proposedCharacters,
    memory: { ...current, ...fields },
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
  const sections: Array<[string, string]> = [];
  if (memory.teamPlaybook) sections.push(["Team playbook", memory.teamPlaybook]);
  if (memory.seriesMemory) sections.push(["Series memory", memory.seriesMemory]);
  if (memory.nextGamePlan) sections.push(["Next-game plan", memory.nextGamePlan]);
  if (sections.length === 1) return sections[0]![1];
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
  if (!parsedTool.success || !trimmed || /^(?:Not executed|Unknown tool|No \w+ data)/.test(trimmed))
    return memory;
  const entry: VerifiedReference = {
    tool: parsedTool.data,
    arguments: stableArguments(args),
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
  return entries.map(renderVerifiedReference).join("\n").length;
}

function renderVerifiedReference(entry: VerifiedReference): string {
  return `${entry.tool}(${JSON.stringify(entry.arguments)}): ${entry.result}`;
}

function verifiedReferenceKey(entry: VerifiedReference): string {
  return `${entry.tool}:${JSON.stringify(entry.arguments)}`;
}

function stableArguments(args: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}
