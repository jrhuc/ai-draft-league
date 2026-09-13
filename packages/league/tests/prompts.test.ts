import { decisionTools, parseDecision } from "../src/llm-engine-support.js";
import { applyMemoryUpdate, emptyBattleMemory } from "../src/battle-memory.js";
import { notebook } from "./engine-test-helpers.js";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  battleSystemPrompt,
  DRAFT_SERIES_REFLECTION_TASK,
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_TASK,
  renderDecision,
  SERIES_REFLECTION_TASK,
} from "../src/prompts.js";

const SYSTEM = battleSystemPrompt({ sheets: "open", timed: false });
const TIMED_SYSTEM = battleSystemPrompt({ sheets: "open", timed: true });

function assertFormatAuthority(prompt: string): void {
  assert.equal(prompt.split(FORMAT_AUTHORITY_NOTICE).length - 1, 1);
}

test("system prompt names the tools and reserves timer policy for timed play", () => {
  assert.equal(
    FORMAT_AUTHORITY_NOTICE,
    "Pokémon Champions and this regulation may postdate your training data. Treat the rules in this prompt and the pinned Pokémon Showdown simulator as authoritative. Do not import mechanics from other Pokémon games or formats. If a mechanic is absent from the rules and legal actions, treat it as unavailable rather than trying to correct the format.",
  );
  assert.match(SYSTEM, /compare_action_order/);
  assert.match(SYSTEM, /zero-based menu index/);
  assert.match(SYSTEM, /independent tool calls together in one reply/);
  assert.doesNotMatch(SYSTEM, /exhaustive KO certainty/);
  assert.doesNotMatch(SYSTEM, /battle timer/);
  assert.match(TIMED_SYSTEM, /battle timer/);
  assert.match(SYSTEM, /submit_action/);
  assert.match(TIMED_SYSTEM, /submit_action/);
  for (const prompt of [SYSTEM, TIMED_SYSTEM]) assertFormatAuthority(prompt);
});

test("reflection instructions ride on the battle system prompt instead of replacing it", () => {
  for (const task of [REFLECTION_TASK, SERIES_REFLECTION_TASK, DRAFT_SERIES_REFLECTION_TASK]) {
    assert.ok(!task.includes(FORMAT_AUTHORITY_NOTICE));
    assert.match(task, /submit_review/);
  }
});

test("decision submissions hold one choice per displayed slot", () => {
  const menu = [{ label: "Protect", part: "move 1", kind: "move" as const }];
  assert.throws(
    () => parseDecision({ choices: [0] }, [menu, menu], emptyBattleMemory()),
    /exactly 2 entries/,
  );
  assert.deepEqual(parseDecision({ choices: [0, 0] }, [menu, menu], emptyBattleMemory()).choices, [
    0, 0,
  ]);
});

test("closed-sheet system prompt never claims open team sheets", () => {
  const closed = battleSystemPrompt({ sheets: "closed", timed: false });
  assert.match(closed, /Team sheets are closed/);
  assert.doesNotMatch(closed, /open team sheets/i);
  const damage = (sheets: "open" | "closed") =>
    decisionTools(sheets).find((tool) => tool.name === "estimate_damage")!.description;
  assert.match(damage("closed"), /unrevealed is treated as neutral across legal ranges/);
  assert.doesNotMatch(damage("open"), /unrevealed/);
  assertFormatAuthority(closed);
  assert.match(battleSystemPrompt({ sheets: "closed", timed: true }), /battle timer/);
});

test("decision prompt leads with merged state and keeps mechanics compact", () => {
  const prompt = renderDecision({
    seriesContext: "Series abc; game 1; score you 0, opponent 0",
    state: "Turn: 1\n- Swampert; types Water/Ground; moves Earthquake [Ground/Physical/100/spread]",
    matchups: ["- Swampert Earthquake: Farigiraf neutral (1x)"],
    transcript: ["Turn 1 begins."],
    memory: applyMemoryUpdate(emptyBattleMemory(), notebook("notes")).memory,
    slotNames: ["Swampert"],
    menus: [[{ label: "Protect", part: "move 1", kind: "move" }]],
  });
  assert.ok(
    prompt.indexOf("Authoritative battle state and roster reference:") <
      prompt.indexOf("Active matchup reference"),
  );
  assert.ok(prompt.indexOf("Active matchup reference") < prompt.indexOf("Choose for Swampert"));
  assert.match(prompt, /Series memory \(5\/3000\): notes/);
  assert.doesNotMatch(prompt, /at most \d+ characters/);
  assert.doesNotMatch(prompt, /"choices"|"notebook"/);
});

test("team preview renders one shared ordered menu", () => {
  const menu = [
    { label: "Pick Gengar", part: "1", kind: "team" as const },
    { label: "Pick Politoed", part: "2", kind: "team" as const },
    { label: "Pick Swampert", part: "3", kind: "team" as const },
  ];
  const prompt = renderDecision({
    state: "Turn: 0",
    memory: emptyBattleMemory(),
    slotNames: ["pick 1", "pick 2", "pick 3", "pick 4"],
    menus: [menu, menu, menu, menu],
  });

  assert.equal(prompt.match(/Pick Gengar/g)?.length, 1);
  assert.match(prompt, /choices 1-2 lead; choices 3-4 back/);
  assert.doesNotMatch(prompt, /"choices"/);
});
