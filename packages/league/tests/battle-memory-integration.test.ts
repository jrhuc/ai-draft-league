import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { TEAM_PLAYBOOK_CHAR_LIMIT } from "../src/battle-memory.js";
import { LLMEngine } from "../src/llm-engine.js";
import type { JsonObject } from "../src/types.js";
import { acceptedAct, decision, notebook, request, ScriptedProvider } from "./engine-test-helpers.js";

test("authoritative lookup results persist into later decision prompts", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: { input_tokens: 10, output_tokens: 2 },
      toolCalls: [
        { id: "ability", name: "lookup_ability", arguments: { name: "Prankster" } },
      ],
    },
    decision([0], "Use the authoritative ability text."),
    decision([0], "Apply the retained interaction."),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });

  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 1");
  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|2"] }), "move 1");

  const prompt = String(provider.calls[2]!.messages[0]!.content);
  assert.match(prompt, /lookup_ability\(\{"name":"Prankster"\}\)/);
  assert.match(prompt, /Dark types are immune/i);
  const state = JSON.parse(engine.coachingState()) as {
    verified_references: JsonObject[];
  };
  assert.equal(state.verified_references.length, 1);
});

test("over-budget decision memory is rejected without changing the action or stored state", async () => {
  const logs: JsonObject[] = [];
  const provider = new ScriptedProvider([
    JSON.stringify({
      choices: [1],
      rationale: "The second move is stronger.",
      notebook: notebook("replacement", "x".repeat(TEAM_PLAYBOOK_CHAR_LIMIT + 1), "replacement"),
    }),
  ]);
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    decisionLog: logs,
    initialNotebook: "Keep the existing plan.",
  });

  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 2");
  assert.equal(engine.coachingNote(), "Keep the existing plan.");
  assert.equal(logs[0]!.fallback, false);
  assert.equal(logs[0]!.parse_failures, 0);
  const memoryUpdate = logs[0]!.memory_update as JsonObject;
  assert.equal(memoryUpdate.accepted, false);
  assert.match(String(memoryUpdate.error), /team_playbook is 3501\/3500 characters/);
});

test("advancing tournament memory carries only transferable team knowledge", async () => {
  const logs: JsonObject[] = [];
  const provider = new ScriptedProvider([
    JSON.stringify({
      summary: "The fast mode closed the series.",
      adjustment: "Keep the mode available next round.",
      notebook: notebook(
        "This opponent protected turn one.",
        "The fast mode is a reliable closer.",
        "Lead into this opponent's weather mode.",
      ),
    }),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: logs });
  engine.beginGame({ gameId: "game-2", gameNumber: 2, seriesId: "series-1" });

  await engine.endGame({
    gameNumber: 2,
    seriesOver: true,
    tournamentStatus: "advancing",
    outcome: { winner: "p1-scripted", won: true, turns: 6 },
    seriesScore: { p1: 2, p2: 0 },
  });

  assert.equal(engine.coachingNote(), "The fast mode is a reliable closer.");
  const state = JSON.parse(engine.coachingState()) as {
    team_playbook: string;
    series_memory: string;
    next_game_plan: string;
  };
  assert.equal(state.team_playbook, "The fast mode is a reliable closer.");
  assert.equal(state.series_memory, "");
  assert.equal(state.next_game_plan, "");
  assert.equal(logs[0]!.opponent_scope_reset, true);
});

test("oversized reflection memory receives one bounded repair attempt", async () => {
  const logs: JsonObject[] = [];
  const provider = new ScriptedProvider([
    JSON.stringify({
      summary: "The first plan was too broad.",
      adjustment: "Compress the durable facts.",
      notebook: notebook("opponent detail", "x".repeat(TEAM_PLAYBOOK_CHAR_LIMIT + 1), "next plan"),
    }),
    JSON.stringify({
      summary: "The position was lost to speed control.",
      adjustment: "Preserve the speed-control answer.",
      notebook: notebook(
        "The opponent preserved its speed setter.",
        "Keep the priority attacker healthy.",
        "Lead the speed-control answer.",
      ),
    }),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: logs });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });

  await engine.endGame({
    gameNumber: 1,
    seriesOver: false,
    outcome: { winner: "opponent", won: false, turns: 8 },
    seriesScore: { p1: 0, p2: 1 },
  });

  assert.equal(provider.calls.length, 2);
  assert.equal(logs[0]!.fallback, false);
  assert.equal(logs[0]!.memory_repair_attempts, 1);
  assert.match(String((logs[0]!.rejected_memory_update as JsonObject).error), /3501\/3500/);
  assert.match(engine.coachingNote(), /Keep the priority attacker healthy/);
  assert.match(
    String(provider.calls[1]!.messages.at(-1)?.content),
    /Compress the three notebook fields/,
  );
});
