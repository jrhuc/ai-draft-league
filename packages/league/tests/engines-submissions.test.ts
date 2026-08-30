import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { LLMEngine } from "../src/llm-engine.js";
import { REFLECTION_SYSTEM } from "../src/prompts.js";
import type { BattleRequest, Completion, JsonObject, Provider } from "../src/types.js";
import { text } from "../src/value.js";
import {
  acceptedAct,
  decision,
  emptyStats,
  notebookUpdate,
  oneMoveStats,
  request,
  ScriptedProvider,
} from "./engine-test-helpers.js";

function megaRequest(): BattleRequest {
  const base = request(2);
  base.active = base.active!.map((active) => ({ ...active!, canMegaEvo: true }));
  return base;
}

test("a double-Mega joint choice is retried with the conflict explained, not silently defaulted", async () => {
  const provider = new ScriptedProvider([
    decision([1, 1], "mega both"),
    decision([1, 0], "mega one"),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  assert.equal(
    await acceptedAct(engine, megaRequest(), { povLines: ["|turn|1"] }),
    "move 1 mega, move 1",
  );
  assert.equal(provider.calls.length, 2);
  assert.match(
    String(provider.calls[1]!.messages.at(-1)!.content),
    /only one Pokémon can Mega Evolve/,
  );
  assert.equal(decisions[0]!.fallback, false);
  assert.equal(decisions[0]!.rationale, "mega one");
  assert.ok(!("requested_choices" in decisions[0]!));
});

test("a persistent illegal joint choice becomes a flagged legal fallback", async () => {
  const stubborn = () => decision([1, 1], "mega both again");
  const provider = new ScriptedProvider([stubborn(), stubborn(), stubborn(), stubborn()]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  assert.equal(
    await acceptedAct(engine, megaRequest(), { povLines: ["|turn|1"] }),
    "move 1, move 1",
  );
  assert.equal(decisions[0]!.fallback, true);
  assert.match(text(decisions[0]!.rationale), /defaulted to the first legal option/);
  assert.equal(decisions[0]!.parse_failures, 4);
});

test("abandoned decisions cannot mutate memory or statistics", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider: Provider = {
    async complete() {
      started.resolve();
      await release.promise;
      return { text: decision([0], "late result", "should not stick"), usage: {}, toolCalls: [] };
    },
  };
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  const action = acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  await started.promise;
  engine.abandonDecision();
  release.resolve();
  assert.equal(await action, "");
  assert.deepEqual(engine.decisionStats(), emptyStats);
});

test("a stale abandoned decision cannot commit or clobber the next request", async () => {
  const started = Promise.withResolvers<void>();
  let call = 0;
  const provider: Provider = {
    complete(_system, _messages, options) {
      call += 1;
      if (call > 1)
        return Promise.resolve({
          text: decision([1], "second decision"),
          usage: { output_tokens: 5 },
          toolCalls: [],
        });
      started.resolve();
      return new Promise<Completion>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    },
  };
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  const first = acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  await started.promise;
  engine.abandonDecision();
  const second = acceptedAct(engine, request(), { povLines: [] });
  assert.equal(await first, "");
  assert.equal(await second, "move 2");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.action, "move 2");
  assert.equal(decisions[0]!.rationale, "second decision");
  assert.equal(decisions[0]!.fallback, false);
  assert.deepEqual(engine.decisionStats(), oneMoveStats);
});

test("abandoning a decision aborts its provider request", async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const provider: Provider = {
    complete(_system, _messages, options) {
      started.resolve();
      return new Promise<Completion>((_resolve, reject) => {
        const signal = options?.signal;
        assert.ok(signal);
        const onAbort = () => {
          aborted.resolve();
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  const action = acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  await started.promise;

  engine.abandonDecision();

  await aborted.promise;
  assert.equal(await action, "");
  assert.deepEqual(engine.decisionStats(), emptyStats);
});

test("an event briefing reaches the provider on decisions and reflections", async () => {
  const briefing = "This bracket replays the top 8 of Some Real Open.";
  const briefed = new ScriptedProvider([
    decision([0], "briefed", ""),
    JSON.stringify({ summary: "s", adjustment: "a", notebook: notebookUpdate("n") }),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider: briefed, decisionLog: [], briefing });
  await acceptedAct(engine, request(), { povLines: ["|turn|1"] });
  await engine.endGame({
    gameNumber: 1,
    seriesOver: false,
    outcome: { winner: "opponent", won: false, turns: 9 },
    seriesScore: { p1: 0, p2: 1 },
  });

  assert.equal(briefed.calls.length, 2, "one decision and one reflection");
  for (const call of briefed.calls) {
    assert.ok(call.system.includes(briefing), "every call carries the briefing");
    assert.ok(
      call.system.indexOf(briefing) > 0,
      "the briefing follows the shared system prompt, not replaces it",
    );
  }
  assert.ok(
    briefed.calls[1]!.system.startsWith(REFLECTION_SYSTEM),
    "the reflection keeps its own system prompt",
  );

  const plain = new ScriptedProvider([decision([0], "plain", "")]);
  await acceptedAct(
    new LLMEngine("p1", "scripted", { provider: plain, decisionLog: [] }),
    request(),
    {
      povLines: ["|turn|1"],
    },
  );
  assert.doesNotMatch(plain.calls[0]!.system, /replays the top/, "a blind seat gets no briefing");
});
