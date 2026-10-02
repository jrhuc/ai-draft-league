import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeStageEvidence } from "../src/stage-evidence.js";

test("stage evidence distinguishes absent fields from an explicit empty notebook", () => {
  const retained = normalizeStageEvidence(undefined, undefined, {
    currentNotebook: "Keep this plan.",
    notebookLimit: 100,
  });
  assert.deepEqual(retained, {
    rationale: "",
    notebook: "Keep this plan.",
    supplied: { rationale: false, notebookUpdate: false },
  });

  const cleared = normalizeStageEvidence("", "", {
    currentNotebook: "Keep this plan.",
    notebookLimit: 100,
  });
  assert.deepEqual(cleared, {
    rationale: "",
    notebook: "",
    supplied: { rationale: true, notebookUpdate: true },
  });
});

test("stage evidence trims a rationale and never clips it", () => {
  const rationale = "r".repeat(5000);
  const evidence = normalizeStageEvidence(` ${rationale}\n`, undefined, {
    currentNotebook: "",
    notebookLimit: 100,
  });
  assert.equal(evidence.rationale, rationale);
});
