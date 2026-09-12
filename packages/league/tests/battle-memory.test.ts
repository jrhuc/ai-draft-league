import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  applyMemoryUpdate,
  createBattleMemory,
  nextOpponentMemory,
  serializeBattleMemory,
} from "../src/battle-memory.js";

test("notebooks retain omitted fields, explicitly clear fields, and round-trip", () => {
  const initial = createBattleMemory("Team strategy");
  const updated = applyMemoryUpdate(initial, {
    series_memory: "Opponent plan",
    next_game_plan: "Lead",
  }).memory;
  assert.deepEqual(createBattleMemory(serializeBattleMemory(updated)), updated);
  assert.deepEqual(applyMemoryUpdate(updated, undefined).memory, updated);
  assert.deepEqual(applyMemoryUpdate(updated, { series_memory: "" }).memory, {
    ...updated,
    seriesMemory: "",
  });
  assert.deepEqual(nextOpponentMemory(updated), initial);
});

test("invalid or oversized notebook updates preserve the original without clipping", () => {
  const initial = createBattleMemory("Team strategy");
  for (const input of [
    "bare text",
    { unknown: "bad" },
    { team_playbook: 42 },
    { series_memory: "x".repeat(3001) },
  ]) {
    const update = applyMemoryUpdate(initial, input);
    assert.equal(update.accepted, false);
    assert.deepEqual(update.memory, initial);
  }
  assert.throws(() => createBattleMemory("x".repeat(3501)), /3500/);
});
