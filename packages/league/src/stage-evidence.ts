import type { JsonValue } from "./types.js";
import { isText } from "./value.js";

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
  notebookLimit: number;
}
/** Optional evidence is distinguished by field presence: an absent notebook retains prior context,
 * while a supplied empty string deliberately clears it. */
export function normalizeStageEvidence(
  rationale: JsonValue | undefined,
  notebook: JsonValue | undefined,
  options: StageEvidenceOptions,
): StageEvidence {
  const hasRationale = isText(rationale);
  const hasNotebook = isText(notebook);
  if (hasNotebook && notebook.trim().length > options.notebookLimit)
    throw new Error(`notebook exceeds ${options.notebookLimit} characters`);
  return {
    rationale: hasRationale ? rationale.trim() : "",
    notebook: hasNotebook ? notebook.trim() : options.currentNotebook,
    supplied: { rationale: hasRationale, notebookUpdate: hasNotebook },
  };
}
