import { applyStrategicMemoryUpdate } from "./strategic-memory.js";
import type { JsonValue } from "./types.js";
import { clip, isText } from "./value.js";

interface EvidenceSupplied {
  rationale: boolean;
  notebookUpdate: boolean;
}

export interface StageEvidence {
  rationale: string;
  notebook: string;
  supplied: EvidenceSupplied;
}

interface StageEvidenceOptions {
  currentNotebook: string;
  rationaleLimit: number;
}

export function normalizeStageEvidence(
  rationale: JsonValue | undefined,
  notebook: JsonValue | undefined,
  options: StageEvidenceOptions,
): StageEvidence {
  const hasRationale = isText(rationale);
  const hasNotebook = notebook !== undefined;
  return {
    rationale: hasRationale ? clip(rationale.trim(), options.rationaleLimit) : "",
    notebook: hasNotebook
      ? applyStrategicMemoryUpdate(options.currentNotebook, notebook, "series")
      : options.currentNotebook,
    supplied: { rationale: hasRationale, notebookUpdate: hasNotebook },
  };
}

export function noStageEvidence(currentNotebook: string): StageEvidence {
  return {
    rationale: "",
    notebook: currentNotebook,
    supplied: { rationale: false, notebookUpdate: false },
  };
}
