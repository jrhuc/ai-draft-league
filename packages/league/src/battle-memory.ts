import { z } from "zod";
import type { JsonObject, JsonValue } from "./types.js";

export const TEAM_PLAYBOOK_CHAR_LIMIT = 3500;
export const SERIES_MEMORY_CHAR_LIMIT = 3000;
export const NEXT_GAME_PLAN_CHAR_LIMIT = 1500;
export const DECISION_NOTE_LIMIT = 8000;

export const notebookSchema = z
  .strictObject({
    team_playbook: z
      .string()
      .max(TEAM_PLAYBOOK_CHAR_LIMIT)
      .optional()
      .describe("Transferable facts about piloting your team; kept across opponents."),
    series_memory: z
      .string()
      .max(SERIES_MEMORY_CHAR_LIMIT)
      .optional()
      .describe("Facts and tendencies specific to this opponent; cleared on a new opponent."),
    next_game_plan: z
      .string()
      .max(NEXT_GAME_PLAN_CHAR_LIMIT)
      .optional()
      .describe("Immediate plan and contingencies for the next game; cleared on a new opponent."),
  })
  .describe(
    "Private notebook update. Each supplied string replaces that field; omitted fields stay unchanged; an empty string clears a field.",
  );

export interface BattleMemory {
  teamPlaybook: string;
  seriesMemory: string;
  nextGamePlan: string;
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
  }
}

export function emptyBattleMemory(): BattleMemory {
  return { teamPlaybook: "", seriesMemory: "", nextGamePlan: "" };
}

export function createBattleMemory(seed?: string): BattleMemory {
  const value = seed?.trim() ?? "";
  const update = applyMemoryUpdate(
    emptyBattleMemory(),
    value.startsWith("{") ? JSON.parse(value) : { team_playbook: value },
  );
  if (!update.accepted) throw new MemoryUpdateError(update);
  return update.memory;
}

export function serializeBattleMemory(memory: BattleMemory): string {
  return JSON.stringify({
    team_playbook: memory.teamPlaybook,
    series_memory: memory.seriesMemory,
    next_game_plan: memory.nextGamePlan,
  });
}

export function storedNotebookText(seed: string): string {
  return renderNotebook(createBattleMemory(seed));
}

export function applyMemoryUpdate(
  current: BattleMemory,
  value: JsonValue | undefined,
): MemoryUpdate {
  const storedCharacters =
    current.teamPlaybook.length + current.seriesMemory.length + current.nextGamePlan.length;
  const unchanged = {
    supplied: value !== undefined,
    accepted: value === undefined,
    proposedCharacters: 0,
    storedCharacters,
    memory: current,
  };
  if (value === undefined) return unchanged;
  const parsed = notebookSchema.safeParse(value);
  if (!parsed.success)
    return {
      ...unchanged,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  const memory = {
    teamPlaybook: parsed.data.team_playbook?.trim() ?? current.teamPlaybook,
    seriesMemory: parsed.data.series_memory?.trim() ?? current.seriesMemory,
    nextGamePlan: parsed.data.next_game_plan?.trim() ?? current.nextGamePlan,
  };
  const proposedCharacters =
    memory.teamPlaybook.length + memory.seriesMemory.length + memory.nextGamePlan.length;
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
    proposed_characters: update.proposedCharacters,
    stored_characters: update.storedCharacters,
  };
}

export function memoryTelemetry(memory: BattleMemory): JsonObject {
  return {
    team_playbook_characters: memory.teamPlaybook.length,
    series_memory_characters: memory.seriesMemory.length,
    next_game_plan_characters: memory.nextGamePlan.length,
    strategic_characters:
      memory.teamPlaybook.length + memory.seriesMemory.length + memory.nextGamePlan.length,
  };
}

export function renderStrategicMemory(memory: BattleMemory): string {
  return [
    `Team playbook (${memory.teamPlaybook.length}/${TEAM_PLAYBOOK_CHAR_LIMIT}): ${memory.teamPlaybook || "(empty)"}`,
    `Series memory (${memory.seriesMemory.length}/${SERIES_MEMORY_CHAR_LIMIT}): ${memory.seriesMemory || "(empty)"}`,
    `Next-game plan (${memory.nextGamePlan.length}/${NEXT_GAME_PLAN_CHAR_LIMIT}): ${memory.nextGamePlan || "(empty)"}`,
  ].join("\n");
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
