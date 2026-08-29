import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  DECISION_MAX_TOKENS_CEILING,
  LLMEngine,
  REFLECTION_MAX_TOKENS,
} from "../src/llm-engine.js";
import type { CompleteOptions, Completion, JsonObject } from "../src/types.js";
import { asRecord, asRecords, text } from "../src/value.js";
import { acceptedAct, decision, request, ScriptedProvider } from "./engine-test-helpers.js";

const lengthTruncated = (options: CompleteOptions): Completion => ({
  text: "",
  usage: { input_tokens: 10, output_tokens: options.maxTokens ?? 0 },
  toolCalls: [],
  finishReason: "length",
});

test("decision token budgets track generation pace against the remaining turn time", async () => {
  const provider = new ScriptedProvider([
    decision([1]),
    decision([1]),
    decision([1]),
    decision([1]),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  const timedFor = (turnSeconds: number) => {
    const timed = request();
    timed.timer = { turnSeconds, seconds: 400 };
    return timed;
  };
  assert.equal(await acceptedAct(engine, timedFor(90), { povLines: [] }), "move 2");
  assert.equal(await acceptedAct(engine, timedFor(40), { povLines: [] }), "move 2");
  assert.equal(await acceptedAct(engine, timedFor(10), { povLines: [] }), "move 2");
  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 2");
  assert.deepEqual(
    provider.calls.map((call) => call.options.maxTokens),
    [5376, 2304, 1024, DECISION_MAX_TOKENS_CEILING],
  );
  assert.match(
    String(provider.calls[0]!.messages[0]!.content),
    /capped at 5376 tokens — what your generation speed fits into the turn/,
  );

  const deepProvider = new ScriptedProvider([decision([1])]);
  const deep = new LLMEngine("p1", "scripted", {
    provider: deepProvider,
    decisionLog: [],
    reasoning: "xhigh",
  });
  assert.equal(await acceptedAct(deep, timedFor(10), { povLines: [] }), "move 2");
  assert.equal(
    deepProvider.calls[0]!.options.maxTokens,
    16_384,
    "deep reasoning keeps its configured floor",
  );
  assert.match(
    String(deepProvider.calls[0]!.messages[0]!.content),
    /capped at 16384 tokens\. A reply cut off/,
    "floor-governed caps do not claim to track pace",
  );
});

test("reasoning truncation without time to retry yields to the battle timer with a clear summary", async () => {
  const decisions: JsonObject[] = [];
  const logged = Promise.withResolvers<void>();
  const engine = new LLMEngine("p1", "prime:reasoning-model", {
    provider: new ScriptedProvider([lengthTruncated]),
    traceLog: (row) => {
      decisions.push(row);
      logged.resolve();
    },
  });
  const timed = request();
  timed.timer = { turnSeconds: 10, seconds: 420 };
  const pending = acceptedAct(engine, timed, { povLines: [] });
  await logged.promise;
  assert.equal(decisions[0]!.failure_kind, "truncation");
  assert.equal(decisions[0]!.error, "reasoning exhausted the 1024-token response budget");
  assert.equal(
    decisions[0]!.error_summary,
    "Prime Inference API spent the whole response budget on reasoning and returned no answer.",
  );
  engine.abandonDecision();
  assert.equal(await pending, "");
});

test("untimed truncation records a legal fallback with the truncation summary", async () => {
  const provider = new ScriptedProvider([
    lengthTruncated,
    lengthTruncated,
    lengthTruncated,
    lengthTruncated,
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "prime:test-model", { provider, decisionLog: decisions });
  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 1");
  assert.equal(provider.calls[0]!.options.maxTokens, DECISION_MAX_TOKENS_CEILING);
  assert.equal(decisions[0]!.fallback, true);
  assert.deepEqual(decisions[0]!.evidence_supplied, { rationale: false, notebook_update: false });
  assert.equal(
    decisions[0]!.error,
    `reasoning exhausted the ${DECISION_MAX_TOKENS_CEILING}-token response budget`,
  );
  assert.equal(
    decisions[0]!.error_summary,
    "Prime Inference API spent the whole response budget on reasoning and returned no answer.",
  );
});

test("a decision cut off mid-reasoning blames the budget, not the model formatting", async () => {
  /** What an over-reasoning model actually returns: pages of deliberation, no closing JSON, and a provider
   * that never sets finishReason: 'length'. */
  const rambled = (options: CompleteOptions): Completion => ({
    text: 'Turn 6. I need to weigh Garchomp and Whimsicott. "choices" will follow once I finish',
    usage: { input_tokens: 10, output_tokens: options.maxTokens ?? 0 },
    toolCalls: [],
  });
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "openrouter:qwen/qwen3.5-flash-02-23", {
    provider: new ScriptedProvider([rambled, rambled, rambled, rambled]),
    decisionLog: decisions,
  });

  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 1");
  assert.equal(decisions[0]!.fallback, true);
  assert.equal(
    decisions[0]!.error,
    `reasoning exhausted the ${DECISION_MAX_TOKENS_CEILING}-token response budget before a choice was submitted`,
    "a truncated ramble must not be logged as a JSON format failure",
  );
});

test("a truncated retry is not fed its own overrun reasoning", async () => {
  const long = "x".repeat(5_000);
  const rambled = (options: CompleteOptions): Completion => ({
    text: `Turn 6 deliberation ${long}`,
    usage: { input_tokens: 10, output_tokens: options.maxTokens ?? 0 },
    toolCalls: [],
  });
  const provider = new ScriptedProvider([rambled, rambled, rambled, rambled]);
  const engine = new LLMEngine("p1", "fake:model", { provider, decisionLog: [] });
  await acceptedAct(engine, request(), { povLines: [] });

  const retry = provider.calls[1]!.messages;
  const replayed = retry.map((message) => String(message.content ?? "")).join("\n");
  assert.ok(!replayed.includes(long), "the overrun reasoning must not be replayed into the retry");
  assert.match(replayed, /cut off before a choice was submitted/);
  assert.match(replayed, /ran past its \d+-token budget/, "the retry names the real problem");
});

test("an early length-stopped ramble is summarized before the model is reprompted", async () => {
  const long = "q".repeat(5_000);
  const provider = new ScriptedProvider([
    {
      text: `unfinished reasoning ${long}`,
      usage: { input_tokens: 10, output_tokens: 4096 },
      toolCalls: [],
      finishReason: "length",
    },
    decision([1], "I still choose the second move.", "keep the plan"),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "fake:model", { provider, decisionLog: decisions });
  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 2");
  const replayed = provider.calls[1]!.messages.map((message) => String(message.content ?? "")).join(
    "\n",
  );
  assert.ok(!replayed.includes(long));
  assert.match(replayed, /stopped your previous response for length after 4096 output tokens/);
  assert.match(
    replayed,
    new RegExp(`below the requested ${DECISION_MAX_TOKENS_CEILING}-token cap`),
  );
  assert.doesNotMatch(replayed, /ran past its .*token budget/);
  assert.equal(decisions[0]!.rationale, "I still choose the second move.");
  assert.deepEqual(decisions[0]!.evidence_supplied, { rationale: true, notebook_update: true });
});

test("a genuine format failure is still reported as one", async () => {
  const malformed = (): Completion => ({
    text: "I choose to attack the left one.",
    usage: { input_tokens: 10, output_tokens: 200 },
    toolCalls: [],
  });
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([malformed(), malformed(), malformed(), malformed()]),
    decisionLog: decisions,
  });

  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 1");
  assert.equal(decisions[0]!.fallback, true);
  assert.doesNotMatch(
    text(decisions[0]!.error),
    /response budget/,
    "well inside the budget is a real parse failure",
  );
});

test("reflections use a reasoning-safe token budget", async () => {
  const provider = new ScriptedProvider([
    JSON.stringify({
      summary: "Lost the rain matchup.",
      adjustment: "Lead differently.",
      notebook: "notes",
    }),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "prime:test-model", { provider, decisionLog: decisions });
  await engine.endGame({
    gameNumber: 1,
    seriesOver: false,
    outcome: { winner: "opponent", won: false, turns: 8 },
    seriesScore: { p1: 0, p2: 1 },
  });
  assert.equal(provider.calls[0]!.options.maxTokens, REFLECTION_MAX_TOKENS);
  assert.equal(decisions[0]!.kind, "game_reflection");
  assert.equal(decisions[0]!.fallback, false);
});

test("tool calls returned after toolChoice none never execute or count", async () => {
  const provider = new ScriptedProvider([
    {
      text: decision([1], "Commit without more research.", "final plan"),
      usage: { output_tokens: 8 },
      toolCalls: [{ id: "late-1", name: "lookup_move", arguments: { name: "Protect" } }],
    },
  ]);
  const decisions: JsonObject[] = [];
  const traces: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    decisionLog: decisions,
    traceLog: traces,
  });
  const timed = request();
  timed.timer = { turnSeconds: 10, seconds: 420 };
  assert.equal(await acceptedAct(engine, timed, { povLines: [] }), "move 2");
  assert.equal(provider.calls[0]!.options.toolChoice, "none");
  assert.deepEqual(traces[0]!.tool_calls, []);
  assert.deepEqual(decisions[0]!.tool_lookups, []);
  assert.equal(engine.decisionStats().tool_lookups, 0);
  assert.equal(decisions[0]!.rationale, "Commit without more research.");
  assert.deepEqual(decisions[0]!.evidence_supplied, { rationale: true, notebook_update: true });
});

test("untimed tool batches allow wide verification across many rounds", async () => {
  const batch = (ids: number[], name: string) => ({
    text: "",
    usage: { input_tokens: 1 },
    toolCalls: ids.map((id) => ({ id: String(id), name: "lookup_move", arguments: { name } })),
  });
  const provider = new ScriptedProvider([
    batch([1, 2, 3], "Earthquake"),
    batch([4, 5, 6, 7, 8], "Protect"),
    batch([9], "Tailwind"),
    batch([10], "Surf"),
    { text: decision([1], "spread", "spread"), usage: { output_tokens: 1 }, toolCalls: [] },
  ]);
  const traces: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [], traceLog: traces });
  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 2");
  assert.equal(provider.calls.length, 5);
  assert.equal(provider.calls[0]!.options.maxTokens, DECISION_MAX_TOKENS_CEILING);
  for (const call of provider.calls) {
    assert.equal(call.options.toolChoice, "auto", "four rounds sit well under the untimed cap");
  }
  const toolTrace = asRecords(traces[0]!.tool_calls);
  assert.equal(toolTrace.length, 10, "the raised untimed cap executes the whole five-call batch");
  assert.equal(traces[0]!.tool_rounds, 4);
});

test("timed tool batches stay capped at two rounds of two calls", async () => {
  const batch = (ids: number[]) => ({
    text: "",
    usage: { input_tokens: 1 },
    toolCalls: ids.map((id) => ({
      id: String(id),
      name: "lookup_move",
      arguments: { name: "Earthquake" },
    })),
  });
  const provider = new ScriptedProvider([
    batch([1, 2, 3]),
    batch([4, 5, 6]),
    { text: decision([1], "spread", "spread"), usage: { output_tokens: 1 }, toolCalls: [] },
  ]);
  const traces: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [], traceLog: traces });
  assert.equal(
    await acceptedAct(
      engine,
      { ...request(), timer: { seconds: 400, turnSeconds: 40 } },
      { povLines: [] },
    ),
    "move 2",
  );
  assert.equal(provider.calls.length, 3);
  assert.equal(provider.calls[2]!.options.toolChoice, "none");
  const toolTrace = asRecords(traces[0]!.tool_calls);
  assert.equal(
    toolTrace.length,
    6,
    "two executed plus one explicitly-refused call per timed round",
  );
  assert.ok(
    toolTrace.some((entry) => /Not executed/.test(text(entry.result))),
    "dropped calls are answered, not silently discarded",
  );
});

test("one action-order call may accompany two standard calls in the single tool round", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        {
          id: "1",
          name: "estimate_damage",
          arguments: { attacker: "Gengar-Mega", defender: "Garchomp", move: "Shadow Ball" },
        },
        { id: "2", name: "lookup_move", arguments: { name: "Shadow Ball" } },
        {
          id: "3",
          name: "compare_action_order",
          arguments: {
            first: "ally 1",
            first_move: "Shadow Ball",
            second: "foe 1",
            second_move: "Earthquake",
          },
        },
      ],
    },
    { text: decision([0]), usage: {}, toolCalls: [] },
  ]);
  const traces: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [], traceLog: traces });
  const orderedRequest = request();
  orderedRequest.active![0]!.moves = [
    { move: "Shadow Ball", id: "shadowball", pp: 10, maxpp: 10, target: "normal", disabled: false },
    { move: "Protect", id: "protect", pp: 10, maxpp: 10, target: "self", disabled: false },
  ];
  orderedRequest.side!.pokemon![0]!.details = "Gengar-Mega, L50";
  orderedRequest.side!.pokemon![0]!.stats = { spe: 170 };
  orderedRequest.side!.pokemon![0]!.moves = ["shadowball", "protect"];
  const action = acceptedAct(engine, orderedRequest, {
    povLines: [
      "|showteam|p2|Garchomp||LifeOrb|RoughSkin|Earthquake|Jolly|||||50",
      "|switch|p1a: Mon1|Gengar-Mega, L50|165/165",
      "|switch|p2a: Garchomp|Garchomp, L50|100/100",
    ],
  });
  assert.equal(await action, "move 1");
  assert.ok(provider.calls[0]!.options.tools?.some((tool) => tool.name === "compare_action_order"));
  const damageTool = provider.calls[0]!.options.tools?.find(
    (tool) => tool.name === "estimate_damage",
  );
  const damageProperties = asRecord(damageTool?.parameters.properties);
  assert.deepEqual(Object.keys(damageProperties).sort(), [
    "attacker",
    "defender",
    "helping_hand",
    "is_critical_hit",
    "move",
  ]);
  const replayed = provider.calls[1]!.messages.filter(
    (message) => message.role === "assistant",
  ).flatMap((message) => message.toolCalls ?? []);
  assert.deepEqual(
    replayed.map((call) => call.name),
    ["estimate_damage", "lookup_move", "compare_action_order"],
  );
  const toolTrace = asRecords(traces[0]!.tool_calls);
  assert.equal(toolTrace.length, 3);
  assert.match(text(toolTrace[2]!.result), /Gengar-Mega is guaranteed to act first/);
});
