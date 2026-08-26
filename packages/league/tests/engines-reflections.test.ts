import assert from "node:assert/strict";
import test from "node:test";
import { LLMEngine } from "../src/llm-engine.js";
import { ApiError } from "../src/providers.js";
import type { JsonObject } from "../src/types.js";
import {
  acceptedAct,
  decision,
  emptyStats,
  oneMoveStats,
  request,
  ScriptedProvider,
} from "./engine-test-helpers.js";

test("closed-sheet engines describe damage tools and rules without open sheets", async () => {
  const provider = new ScriptedProvider([{ text: decision([0]), usage: {}, toolCalls: [] }]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [], closedSheets: true });
  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 1");
  const call = provider.calls[0]!;
  assert.match(call.system, /Team sheets are closed/);
  assert.doesNotMatch(call.system, /open team sheets/i);
  const damageTool = call.options.tools?.find((tool) => tool.name === "estimate_damage");
  assert.match(String(damageTool?.description), /what the battle has revealed/);
  assert.doesNotMatch(String(damageTool?.description), /open team sheets/i);
});

test("readable decisions, technical traces, and post-game reflections stay separate", async () => {
  const provider = new ScriptedProvider([
    decision([1], "Second is safer into the shown board.", "Preserve Mon1 for the endgame."),
    JSON.stringify({
      summary: "Won by preserving the endgame attacker.",
      adjustment: "Keep tracking opposing speed order.",
      notebook: "Mon1 is the preferred endgame; verify opposing speed order.",
    }),
  ]);
  const decisions: JsonObject[] = [];
  const traces: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    decisionLog: decisions,
    traceLog: traces,
    initialNotebook: "Matchup build: preserve Mon1.",
  });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });
  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 2");
  assert.match(String(provider.calls[0]!.messages[0]!.content), /Matchup build: preserve Mon1/);
  await engine.endGame({
    gameNumber: 1,
    outcome: {
      winner: "p1-scripted",
      won: true,
      turns: 1,
      errors: 0,
      model_choice_fallbacks: 2,
      simulator_substitutions: 1,
      timer_autodefaults: 3,
    },
    seriesScore: { p1: 1, p2: 0 },
  });

  assert.equal(decisions[0]!.kind, "decision");
  assert.equal(decisions[0]!.rationale, "Second is safer into the shown board.");
  assert.equal(decisions[0]!.notebook, "Preserve Mon1 for the endgame.");
  assert.ok(!("raw_response" in decisions[0]!));
  assert.ok(!("menus" in decisions[0]!));
  assert.equal(decisions[1]!.kind, "game_reflection");
  assert.equal(decisions[1]!.series_over, false);
  assert.match(String(decisions[1]!.adjustment), /speed order/);
  assert.equal(traces[0]!.kind, "decision_trace");
  assert.ok("prompt" in traces[0]! && "raw_response" in traces[0]! && "menus" in traces[0]!);
  assert.equal(traces[1]!.kind, "reflection_trace");
  assert.match(provider.calls[1]!.system, /reviewing one completed game/);
  assert.match(
    String(provider.calls[1]!.messages[0]!.content),
    /Model-choice defaults: 2\. Simulator substitutions: 1\. Timer autodefaults: 3\./,
  );
  assert.equal(
    engine.coachingNote(),
    "Mon1 is the preferred endgame; verify opposing speed order.",
  );
  assert.deepEqual(engine.decisionStats(), {
    ...oneMoveStats,
    reflections: 1,
  });
});

test("the deciding game reflects on the finished series instead of a next game", async () => {
  const provider = new ScriptedProvider([
    JSON.stringify({
      summary: "Lost the series to superior speed control.",
      adjustment: "Bring the Tailwind setter in a rematch.",
      notebook: "Opponent leans on Tailwind turns 1-2.",
    }),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p2", "scripted", { provider, decisionLog: decisions });
  await engine.endGame({
    gameNumber: 2,
    outcome: { winner: "opponent", won: false, turns: 9 },
    seriesScore: { p1: 2, p2: 0 },
  });
  assert.equal(decisions[0]!.kind, "game_reflection");
  assert.equal(decisions[0]!.series_over, true);
  assert.match(provider.calls[0]!.system, /series that is now over/);
  assert.match(provider.calls[0]!.system, /future series/);
  assert.match(
    String(provider.calls[0]!.messages[0]!.content),
    /The series is over: you lost it 0-2 \(you are p2\)\./,
  );
});

test("provider failures during reflection fall back instead of stopping the series", async () => {
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "openrouter:google/gemini-test", {
    provider: new ScriptedProvider([
      new ApiError(
        429,
        "openrouter:google/gemini-test 429: exceeded your current quota; requests per day",
      ),
    ]),
    decisionLog: decisions,
  });

  await engine.endGame({
    gameNumber: 1,
    outcome: { winner: "opponent", won: false, turns: 8 },
    seriesScore: { p1: 0, p2: 1 },
  });
  assert.equal(decisions[0]!.kind, "game_reflection");
  assert.equal(decisions[0]!.fallback, true);
  assert.equal(decisions[0]!.failure_kind, "quota");
  assert.match(String(decisions[0]!.summary), /model reflection unavailable/);
});

test("game transcripts reset while notebook and score persist, with a marked character cap", async () => {
  const provider = new ScriptedProvider([
    decision([0], "game one", "durable series note"),
    decision([0], "game two", "durable series note"),
    decision([0], "after oversized event", "durable series note"),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  engine.beginGame({
    gameId: "game-1",
    gameNumber: 1,
    seriesId: "series-1",
    seriesScore: { p1: 1, p2: 0 },
  });
  engine.observe(["|move|p2a: OldMon|Ancient Memory|p1a: Mon1"]);
  await acceptedAct(engine, request(), { povLines: [] });

  engine.beginGame({ gameId: "game-2", gameNumber: 2, seriesId: "series-1" });
  await acceptedAct(engine, request(), { povLines: [] });
  const nextGamePrompt = String(provider.calls[1]!.messages[0]!.content);
  assert.doesNotMatch(nextGamePrompt, /Ancient Memory|\[Game 1 begins/);
  assert.match(nextGamePrompt, /\[Game 2 begins; series score you 1, opponent 0\]/);
  assert.match(nextGamePrompt, /Private notebook: durable series note/);
  assert.match(nextGamePrompt, /Series series-1; game 2; score you 1, opponent 0/);

  engine.observe([`|move|p2a: NewMon|${"x".repeat(26_000)}LATEST|p1a: Mon1`]);
  await acceptedAct(engine, request(), { povLines: [] });
  const cappedPrompt = String(provider.calls[2]!.messages[0]!.content);
  const timelineMarker = "Compact private battle timeline (your POV):\n";
  const timeline = cappedPrompt
    .slice(cappedPrompt.indexOf(timelineMarker) + timelineMarker.length)
    .split("\n\nChoose for ")[0]!;
  assert.ok(timeline.length <= 24_100, `timeline stayed near the cap (${timeline.length})`);
  assert.match(timeline, /^\[Earlier turns are omitted from this timeline\.\]/);
  assert.match(timeline, /LATEST into Mon1\.$/);
});

test("turn timeline uses one percentage-only line per turn", async () => {
  const provider = new ScriptedProvider([decision([0], "first"), decision([0], "second")]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });

  await acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  engine.observe([
    "|move|p2a: Foe|Tackle|p1a: Mon1",
    "|-damage|p1a: Mon1|50/100",
    "|-heal|p2a: Foe|75/100",
    "|turn|2",
  ]);
  await acceptedAct(engine, request(), { povLines: [] });

  const prompt = String(provider.calls[1]!.messages[0]!.content);
  const timeline = prompt
    .split("Compact private battle timeline (your POV):\n")[1]!
    .split("\n\nChoose for ")[0]!;
  assert.match(
    timeline,
    /Turn 1: Decision: move 1; Foe used Tackle into Mon1; Mon1 HP became 50%; Foe HP became 75% after healing\./,
  );
  assert.match(timeline, /Turn 2:$/m);
  assert.equal(timeline.split("\n").filter((line) => line.startsWith("Turn 1:")).length, 1);
  assert.doesNotMatch(prompt, /50\/100|75\/100/);
});

test("readable logs suppress unchanged notebooks and tendency counters remain post-hoc", async () => {
  const protectRequest = request();
  protectRequest.active![0]!.moves = [
    { move: "Protect", id: "protect", pp: 10, maxpp: 10, target: "self", disabled: false },
    { move: "Second", id: "second", pp: 10, maxpp: 10, target: "self", disabled: false },
  ];
  protectRequest.side!.pokemon![0]!.moves = ["protect", "second"];
  const logs: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([
      decision([0], "Scout once.", "Preserve the attacker."),
      decision([0], "Accept the consecutive-use risk.", "Preserve the attacker."),
    ]),
    decisionLog: logs,
  });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });
  await acceptedAct(engine, protectRequest, { povLines: ["|turn|1"] });
  await acceptedAct(engine, protectRequest, { povLines: ["|turn|2"] });

  assert.equal(logs[0]!.notebook, "Preserve the attacker.");
  assert.ok(!("notebook" in logs[1]!));
  assert.deepEqual(engine.decisionStats(), {
    ...emptyStats,
    decisions: 2,
    move_selections: 2,
    protect_selections: 2,
    consecutive_protect_selections: 1,
    repeated_joint_actions: 1,
  });
});

test("team-preview adaptation counters compare public bring and lead choices", async () => {
  const preview = request();
  preview.teamPreview = true;
  preview.maxChosenTeamSize = 4;
  preview.side!.pokemon = Array.from({ length: 6 }, (_, index) => ({
    ident: `p1: Mon${index + 1}`,
    details: `Species${index + 1}, L50`,
    condition: "100/100",
    active: false,
  }));
  delete preview.active;
  const engine = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([decision([0, 1, 2, 3]), decision([1, 2, 3, 4])]),
    decisionLog: [],
  });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });
  await acceptedAct(engine, preview, { povLines: [] });
  engine.beginGame({ gameId: "game-2", gameNumber: 2, seriesId: "series-1" });
  await acceptedAct(engine, preview, { povLines: [] });
  assert.deepEqual(engine.decisionStats(), {
    ...emptyStats,
    decisions: 2,
    team_previews: 2,
    bring_changes: 1,
    lead_changes: 1,
  });
});

test("the closing review of a decided series is marked series_over", async () => {
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider(["", ""]),
    decisionLog: decisions,
  });
  engine.beginGame({
    gameId: "game-2",
    gameNumber: 2,
    seriesId: "series-1",
    seriesScore: { p1: 1, p2: 0 },
  });
  await engine.endGame({
    gameNumber: 2,
    outcome: { winner: "p1-scripted", won: true, turns: 9 },
    seriesScore: { p1: 2, p2: 0 },
  });
  assert.equal(decisions[0]!.kind, "game_reflection");
  assert.equal(decisions[0]!.series_over, true);
  assert.equal(decisions[0]!.fallback, true);
});
