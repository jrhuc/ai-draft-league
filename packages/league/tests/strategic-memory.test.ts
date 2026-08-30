import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  applyStrategicMemoryUpdate,
  normalizeStrategicMemory,
  parseStrategicMemory,
  rememberVerifiedReference,
  scopeStrategicMemory,
} from "../src/strategic-memory.js";

const update = {
  team_playbook: "Team lesson.",
  series_memory: "Opponent fact.",
  next_game_plan: "Game plan.",
};

test("strategic memory expires scopes at their lifecycle boundaries", () => {
  const current = applyStrategicMemoryUpdate("", update, "series");

  assert.deepEqual(parseStrategicMemory(scopeStrategicMemory(current, current, "series")), {
    teamPlaybook: "Team lesson.",
    seriesMemory: "Opponent fact.",
    nextGamePlan: "",
    verifiedReferences: [],
  });
  assert.deepEqual(parseStrategicMemory(scopeStrategicMemory(current, current, "rematch")), {
    teamPlaybook: "Team lesson.",
    seriesMemory: "Opponent fact.",
    nextGamePlan: "",
    verifiedReferences: [],
  });
  assert.deepEqual(parseStrategicMemory(scopeStrategicMemory(current, current, "next-round")), {
    teamPlaybook: "Team lesson.",
    seriesMemory: "",
    nextGamePlan: "",
    verifiedReferences: [],
  });
});

test("strategic memory rejects oversized replacements instead of clipping them", () => {
  assert.throws(
    () => applyStrategicMemoryUpdate("", { ...update, team_playbook: "x".repeat(3501) }, "series"),
    /team_playbook is 3501 characters; limit 3500/,
  );
});

test("verified references retain only the active format revision", () => {
  const first = rememberVerifiedReference("", {
    tool: "lookup_ability",
    arguments: { name: "Prankster" },
    format: "format",
    revision: "old",
    result: "Old result.",
  });
  assert.equal(
    parseStrategicMemory(normalizeStrategicMemory(first, { format: "format", revision: "current" }))
      .verifiedReferences.length,
    0,
  );
  const current = rememberVerifiedReference(first, {
    tool: "lookup_ability",
    arguments: { name: "Prankster" },
    format: "format",
    revision: "current",
    result: "Current result.",
  });
  const memory = parseStrategicMemory(current);

  assert.deepEqual(memory.verifiedReferences, [
    {
      tool: "lookup_ability",
      arguments: { name: "Prankster" },
      format: "format",
      revision: "current",
      result: "Current result.",
    },
  ]);
});
