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
  notebookLimit?: number;
}

export function normalizeStageEvidence(
  rationale: JsonValue | undefined,
  notebook: JsonValue | undefined,
  options: StageEvidenceOptions,
): StageEvidence {
  const hasRationale = isText(rationale);
  const hasNotebook =
    options.notebookLimit === undefined ? notebook !== undefined : isText(notebook);
  const nextNotebook =
    !hasNotebook || notebook === undefined
      ? options.currentNotebook
      : options.notebookLimit === undefined
        ? applyStrategicMemoryUpdate(options.currentNotebook, notebook, "series")
        : clip((notebook as string).trim(), options.notebookLimit);
  return {
    rationale: hasRationale ? clip(rationale.trim(), options.rationaleLimit) : "",
    notebook: nextNotebook,
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
