import {
  applyMemoryUpdate,
  type BattleMemory,
  type MemoryUpdate,
} from "./battle-memory.js";
import type { JsonValue } from "./types.js";
import { clip, isText } from "./value.js";

interface EvidenceSupplied {
  rationale: boolean;
  notebookUpdate: boolean;
}

export interface StageEvidence {
  rationale: string;
  memory: BattleMemory;
  memoryUpdate: MemoryUpdate;
  supplied: EvidenceSupplied;
}

interface StageEvidenceOptions {
  currentMemory: BattleMemory;
  rationaleLimit: number;
}

export function normalizeStageEvidence(
  rationale: JsonValue | undefined,
  notebook: JsonValue | undefined,
  options: StageEvidenceOptions,
): StageEvidence {
  const hasRationale = isText(rationale);
  const memoryUpdate = applyMemoryUpdate(options.currentMemory, notebook);
  return {
    rationale: hasRationale ? clip(rationale.trim(), options.rationaleLimit) : "",
    memory: memoryUpdate.memory,
    memoryUpdate,
    supplied: { rationale: hasRationale, notebookUpdate: memoryUpdate.supplied },
  };
}

export function noStageEvidence(currentMemory: BattleMemory): StageEvidence {
  const memoryUpdate = applyMemoryUpdate(currentMemory, undefined);
  return {
    rationale: "",
    memory: currentMemory,
    memoryUpdate,
    supplied: { rationale: false, notebookUpdate: false },
  };
}
