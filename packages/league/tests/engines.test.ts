import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { z } from "zod";
import { serializeBattleMemory } from "../src/battle-memory.js";
import { LLMEngine } from "../src/llm-engine.js";
import { REFLECTION_SYSTEM, DRAFT_SERIES_REFLECTION_SYSTEM } from "../src/prompts.js";
import { commitRunArtifact, readRunArtifacts } from "../src/run-artifact-store.js";
import type { JsonObject } from "../src/types.js";
import { agentReply, scriptedAgent } from "./agent-test-helpers.js";
import { acceptedAct, request } from "./engine-test-helpers.js";

test("rejected joint actions and oversized notebooks are retried before anything commits", async () => {
  const script = scriptedAgent([
    { choices: [1, 1] },
    { choices: [1, 0], notebook: { series_memory: "x".repeat(3001) } },
    { choices: [1, 0], rationale: "Mega one", notebook: { series_memory: "Track speed" } },
  ]);
  const log: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    runAgent: script.run,
    decisionLog: log,
    initialNotebook: "Keep options open",
  });
  const battleRequest = request(2);
  battleRequest.active = battleRequest.active!.map((active) => ({ ...active!, canMegaEvo: true }));
  const submission = await engine.submit(battleRequest, {
    povLines: ["|turn|1"],
    submissionId: "action-1",
  });
  assert.equal(script.rejections.length, 2);
  assert.match(script.rejections[0]!, /only one Pokémon can Mega Evolve/);
  assert.match(script.rejections[1]!, /3000/);
  assert.equal(submission?.choice, "move 1 mega, move 1");
  assert.equal(log.length, 0);
  engine.resolveSubmission(submission!, "accepted");
  assert.equal(log[0]!.outcome, "accepted");
  assert.equal(log[0]!.parse_failures, 2);
  assert.equal(log[0]!.action, "move 1 mega, move 1");
  assert.deepEqual(
    engine.coachingState(),
    serializeBattleMemory({
      teamPlaybook: "Keep options open",
      seriesMemory: "Track speed",
      nextGamePlan: "",
    }),
  );
  assert.equal(engine.decisionStats().parse_failures, 2);
});

test("game conversations persist private observations and preserve cross-game history", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-engine-context-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = scriptedAgent([
    { choices: [0], notebook: { series_memory: "Expect Protect" } },
    { choices: [1] },
    { summary: "Won by conserving resources", adjustment: "Preserve speed control" },
    { choices: [0] },
  ]);
  const engine = new LLMEngine("p1", "scripted", {
    runAgent: script.run,
    briefing: "Private build plan",
    contextLog: (row) =>
      commitRunArtifact(directory, "context", z.string().parse(row.context_id), row),
  });
  engine.beginGame({ gameId: "game-1", seriesId: "series", gameNumber: 1 });
  await acceptedAct(engine, request(), {
    povLines: ["|turn|1", "|-activate|p2a: Rival|move: Protect"],
  });
  await acceptedAct(engine, request(), { povLines: ["|turn|2"] });
  await engine.endGame({ gameNumber: 1, seriesOver: false, outcome: { winner: "me", won: true } });
  engine.beginGame({ gameId: "game-2", seriesId: "series", gameNumber: 2 });
  await acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  const automatic = request();
  automatic.active![0]!.moves = automatic.active![0]!.moves.slice(0, 1);
  await acceptedAct(engine, automatic, { povLines: ["|turn|2"] });
  assert.equal(script.calls.length, 4);
  assert.equal(script.calls[0]!.session, script.calls[1]!.session);
  assert.equal(script.calls[0]!.session, script.calls[2]!.session);
  assert.notEqual(script.calls[0]!.session, script.calls[3]!.session);
  assert.match(script.calls[0]!.prompt, /Protect/);
  assert.doesNotMatch(script.calls[1]!.prompt, /Protect/);
  assert.match(script.calls[3]!.prompt, /Expect Protect/);
  assert.ok(script.calls.every((task) => task.system.includes("Private build plan")));
  assert.ok(script.calls[2]!.system.startsWith(REFLECTION_SYSTEM));
  assert.match(JSON.stringify(engine.readContext()), /Won by conserving resources/);
  const persisted = JSON.stringify(readRunArtifacts(directory, "context"));
  assert.match(persisted, /Won by conserving resources/);
  assert.match(persisted, /Expect Protect/);
});

test("abandoning an in-flight decision aborts it without allowing stale state to commit", async () => {
  const pending = Promise.withResolvers<JsonObject>();
  const script = scriptedAgent([
    () => pending.promise,
    { choices: [1], notebook: { team_playbook: "Current" } },
  ]);
  const engine = new LLMEngine("p1", "scripted", { runAgent: script.run });
  const stale = acceptedAct(engine, request(), { povLines: [] });
  engine.abandonDecision();
  assert.equal(script.calls[0]!.signal?.aborted, true);
  const current = acceptedAct(engine, request(), { povLines: [] });
  pending.resolve({ choices: [0], notebook: { team_playbook: "Stale" } });
  assert.equal(await current, "move 2");
  assert.equal(await stale, "");
  assert.equal(engine.coachingNote(), "Current");
  assert.equal(engine.decisionStats().decisions, 1);
});

test("clock and simulator rejections reach the agent and runtime failures propagate", async () => {
  const script = scriptedAgent([new Error("upstream unavailable")]);
  const engine = new LLMEngine("p1", "scripted", { runAgent: script.run });
  await assert.rejects(
    acceptedAct(
      engine,
      { ...request(), timer: { turnSeconds: 8, seconds: 42 } },
      { povLines: [], error: "trapped" },
    ),
    /upstream unavailable/,
  );
  assert.match(script.calls[0]!.prompt, /8 seconds this turn; 42 seconds in the bank/);
  assert.match(script.calls[0]!.prompt, /trapped/);
  assert.equal(engine.decisionStats().decisions, 0);
});

test("a timer-ended game reviews the outcome after superseding its abandoned decision", async () => {
  const script = scriptedAgent([new Error("clock expired"), { summary: "Timed out" }]);
  const engine = new LLMEngine("p1", "scripted", { runAgent: script.run });
  const pending = acceptedAct(engine, request(), { povLines: [] });
  engine.abandonDecision();
  await pending;
  const adaptation = engine.prepareGameEnd({
    gameNumber: 1,
    seriesOver: true,
    outcome: { won: false, winner: "opponent", timer_autodefaults: 1 },
  });
  assert.equal(adaptation.supersedes, "decision-1");
  await engine.completeGameEnd(adaptation);
  assert.equal(script.calls[1]!.supersedes, "decision-1");
});

test("closed sheets expose only closed-sheet tools and automatic actions buy no inference", async () => {
  const script = scriptedAgent([{ choices: [0] }]);
  const engine = new LLMEngine("p1", "scripted", { runAgent: script.run, closedSheets: true });
  const automatic = request();
  automatic.active![0]!.moves = automatic.active![0]!.moves.slice(0, 1);
  await acceptedAct(engine, automatic, { povLines: [] });
  assert.equal(script.calls.length, 0);
  await acceptedAct(engine, request(), { povLines: [] });
  assert.match(script.calls[0]!.system, /closed/);
  const damage = script.calls[0]!.tools!.find(
    (tool) => tool.definition.name === "estimate_damage",
  )!;
  assert.match(damage.definition.description, /revealed/);
  assert.doesNotMatch(damage.definition.description, /open team sheets/);
});

test("draft-final reflection keeps preparation context and next-opponent memory resets its scope", async () => {
  const script = scriptedAgent([
    {
      summary: "Review",
      notebook: {
        team_playbook: "Transferable",
        series_memory: "Opponent",
        next_game_plan: "Lead",
      },
    },
  ]);
  const log: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    runAgent: script.run,
    draftRoster: "Entire private roster",
    decisionLog: log,
    initialNotebook: JSON.stringify({ series_memory: "Old opponent", next_game_plan: "Old plan" }),
  });
  await engine.endGame({
    gameNumber: 1,
    seriesOver: true,
    outcome: { winner: "me", won: true },
    tournamentStatus: "advancing",
  });
  assert.ok(script.calls[0]!.system.startsWith(DRAFT_SERIES_REFLECTION_SYSTEM));
  assert.match(script.calls[0]!.prompt, /Entire private roster/);
  const reset = serializeBattleMemory({
    teamPlaybook: "Transferable",
    seriesMemory: "",
    nextGamePlan: "",
  });
  assert.equal(engine.coachingState(), reset);
  assert.equal(log[0]!.kind, "game_reflection");
  assert.equal(log[0]!.memory_state, reset);
  assert.equal(log[0]!.opponent_scope_reset, true);
});

test("the private history tool includes accepted decisions across game boundaries", async () => {
  const engine = new LLMEngine("p1", "scripted", {
    runAgent: async (task) => {
      if (task.task === "reflection") {
        const history = task.tools!.find((tool) => tool.definition.name === "read_battle_history")!;
        assert.match(history.run({ game_number: 1 }), /Private reasoning/);
        return agentReply(task, { summary: "Reviewed" });
      }
      return agentReply(task, { choices: [0], rationale: "Private reasoning" });
    },
  });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series" });
  await acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  await engine.endGame({ gameNumber: 1, seriesOver: false, outcome: { won: true } });
});
