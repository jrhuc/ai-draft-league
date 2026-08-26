import type { JsonValue } from "./types.js";
import { clip } from "./value.js";

export interface EvidenceSupplied {
  rationale: boolean;
  notebookUpdate: boolean;
}

export interface StageEvidence {
  rationale: string;
  notebook: string;
  supplied: EvidenceSupplied;
}

export interface StageEvidenceOptions {
  currentNotebook: string;
  rationaleLimit: number;
  notebookLimit: number;
}
/** Optional evidence is distinguished by field presence: an absent notebook retains prior context,
 * while a supplied empty string deliberately clears it. */
export function normalizeStageEvidence(
  rationale: JsonValue | undefined,
  notebook: JsonValue | undefined,
  options: StageEvidenceOptions,
): StageEvidence {
  const hasRationale = typeof rationale === "string";
  const hasNotebook = typeof notebook === "string";
  return {
    rationale: hasRationale ? clip(rationale.trim(), options.rationaleLimit) : "",
    notebook: hasNotebook ? clip(notebook.trim(), options.notebookLimit) : options.currentNotebook,
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
