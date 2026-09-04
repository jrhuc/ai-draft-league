import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  applyMemoryUpdate,
  createBattleMemory,
  emptyBattleMemory,
  memoryTelemetry,
  nextOpponentMemory,
  rememberVerifiedReference,
  renderVerifiedReferenceMemory,
  serializeBattleMemory,
  storedNotebookText,
  TEAM_PLAYBOOK_CHAR_LIMIT,
  VERIFIED_REFERENCE_CHAR_LIMIT,
  VERIFIED_REFERENCE_ENTRY_LIMIT,
} from "../src/battle-memory.js";

test("battle memory round-trips scoped strategic state", () => {
  const current = emptyBattleMemory("format@revision");
  const update = applyMemoryUpdate(current, {
    team_playbook: "Preserve the fast mode for endgames.",
    series_memory: "The opponent protected its left slot on turn one.",
    next_game_plan: "Lead speed control and keep the closer in back.",
  });

  assert.equal(update.accepted, true);
  assert.deepEqual(
    createBattleMemory(serializeBattleMemory(update.memory), "format@revision"),
    update.memory,
  );
  assert.deepEqual(memoryTelemetry(update.memory), {
    team_playbook_characters: update.memory.teamPlaybook.length,
    series_memory_characters: update.memory.seriesMemory.length,
    next_game_plan_characters: update.memory.nextGamePlan.length,
    strategic_characters:
      update.memory.teamPlaybook.length +
      update.memory.seriesMemory.length +
      update.memory.nextGamePlan.length,
    verified_reference_characters: 0,
    verified_reference_entries: 0,
  });
});

test("over-budget strategic memory is rejected without clipping", () => {
  const current = applyMemoryUpdate(emptyBattleMemory("format@revision"), {
    team_playbook: "Keep the current mode.",
    series_memory: "Track the opposing lead.",
    next_game_plan: "Lead safely.",
  }).memory;
  const update = applyMemoryUpdate(current, {
    team_playbook: "x".repeat(TEAM_PLAYBOOK_CHAR_LIMIT + 1),
    series_memory: "replacement",
    next_game_plan: "replacement",
  });

  assert.equal(update.accepted, false);
  assert.strictEqual(update.memory, current);
  assert.match(update.error ?? "", /team_playbook is 3501\/3500 characters/);
  assert.doesNotMatch(serializeBattleMemory(update.memory), /\[clipped\]/);
});

test("next-opponent reset preserves team and verified mechanics only", () => {
  let memory = applyMemoryUpdate(emptyBattleMemory("format@revision"), {
    team_playbook: "Use the slow mode into speed control.",
    series_memory: "This opponent always led weather.",
    next_game_plan: "Counter-lead weather.",
  }).memory;
  memory = rememberVerifiedReference(
    memory,
    "lookup_ability",
    { name: "Prankster" },
    "Status moves have priority raised by 1, but Dark types are immune.",
  );

  const reset = nextOpponentMemory(memory);
  assert.equal(reset.teamPlaybook, memory.teamPlaybook);
  assert.equal(reset.seriesMemory, "");
  assert.equal(reset.nextGamePlan, "");
  assert.deepEqual(reset.verifiedReferences, memory.verifiedReferences);
});

test("verified reference memory is deduplicated, bounded, and revision-scoped", () => {
  let memory = emptyBattleMemory("format@revision-a");
  memory = rememberVerifiedReference(
    memory,
    "lookup_ability",
    { name: "Prankster" },
    "Status moves have priority raised by 1, but Dark types are immune.",
  );
  memory = rememberVerifiedReference(
    memory,
    "lookup_ability",
    { name: "Prankster" },
    "Dark types are immune to the boosted status move.",
  );
  for (let index = 0; index < VERIFIED_REFERENCE_ENTRY_LIMIT + 8; index += 1) {
    memory = rememberVerifiedReference(
      memory,
      "lookup_move",
      { name: `Move ${index}` },
      `Move ${index} has a concise authoritative effect.`,
    );
  }

  assert.ok(memory.verifiedReferences.length <= VERIFIED_REFERENCE_ENTRY_LIMIT);
  assert.ok(
    Number(memoryTelemetry(memory).verified_reference_characters) <= VERIFIED_REFERENCE_CHAR_LIMIT,
  );
  assert.equal(
    memory.verifiedReferences.filter((entry) => entry.tool === "lookup_ability").length,
    0,
  );
  assert.match(renderVerifiedReferenceMemory(memory), /lookup_move/);

  const restored = createBattleMemory(serializeBattleMemory(memory), "format@revision-b");
  assert.equal(restored.verifiedReferences.length, 0);
});

test("seeds are a plain team playbook or this module's own stored state", () => {
  const seeded = createBattleMemory("  Preserve the fast mode.  ", "format@revision");
  assert.equal(seeded.teamPlaybook, "Preserve the fast mode.");
  assert.equal(seeded.seriesMemory, "");
  assert.deepEqual(createBattleMemory(serializeBattleMemory(seeded), "format@revision"), seeded);
  assert.throws(() =>
    createBattleMemory("x".repeat(TEAM_PLAYBOOK_CHAR_LIMIT + 1), "format@revision"),
  );
  assert.throws(() => createBattleMemory('{"version":2}', "format@revision"));
  assert.equal(storedNotebookText(serializeBattleMemory(seeded)), "Preserve the fast mode.");
  assert.equal(storedNotebookText("plain note"), "plain note");
});

test("a bare-string notebook counts as supplied but is rejected", () => {
  const current = emptyBattleMemory("format@revision");
  const update = applyMemoryUpdate(current, "just a string");
  assert.equal(update.supplied, true);
  assert.equal(update.accepted, false);
  assert.strictEqual(update.memory, current);
  assert.match(update.error ?? "", /team_playbook/);
});
