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
  let nextNotebook = options.currentNotebook;
  if (options.notebookLimit === undefined && notebook !== undefined)
    nextNotebook = applyStrategicMemoryUpdate(options.currentNotebook, notebook, "series");
  else if (options.notebookLimit !== undefined && isText(notebook))
    nextNotebook = clip(notebook.trim(), options.notebookLimit);
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
