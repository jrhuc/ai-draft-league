import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { completeWithDexTools } from "../src/dex-lookups.js";
import { LLMEngine } from "../src/llm-engine.js";
import { ShowdownReference } from "../src/reference.js";
import type { JsonObject, ToolCall } from "../src/types.js";
import { asRecord, asRecords, text } from "../src/value.js";
import {
  acceptedAct,
  decision,
  notebook,
  request,
  ScriptedProvider,
} from "./engine-test-helpers.js";

const policy = { maxTokens: 4096, toolRounds: 2 };

const queries = [
  { name: "lookup_move", arguments: { name: "Protect" } },
  { name: "lookup_ability", arguments: { name: "Prankster" } },
  {
    name: "calculate_stats",
    arguments: { species: "Garchomp", nature: "Jolly", evs: { atk: 32, spe: 32, hp: 2 } },
  },
  {
    name: "estimate_damage",
    arguments: { attacker: "Garchomp", defender: "Incineroar", move: "Earthquake" },
  },
] as const satisfies ReadonlyArray<{ name: string; arguments: JsonObject }>;

test("mixed batched queries return the same mechanics as individual calls in one exchange", async () => {
  const reference = new ShowdownReference("gen9championsvgc2026regmb");
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: { input_tokens: 100, cost: 0.01 },
      toolCalls: [{ id: "batch", name: "batch_tools", arguments: { queries } }],
    },
    { text: '{"pick":"garchomp"}', usage: { input_tokens: 200, cost: 0.02 }, toolCalls: [] },
  ]);
  const trace: JsonObject[] = [];
  const completion = await completeWithDexTools({
    provider,
    reference,
    policy,
    spec: "scripted",
    system: "draft",
    messages: [{ role: "user", content: "Choose a pick." }],
    onLookup: (result) => trace.push(result),
  });
  assert.equal(completion.text, '{"pick":"garchomp"}');
  assert.equal(provider.calls.length, 2);
  assert.equal(completion.usage.input_tokens, 300);
  assert.equal(completion.usage.cost, 0.03);
  const results = provider.calls[1]!.messages.filter((message) => message.role === "tool");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.toolCallId, "batch");
  assert.deepEqual(
    JSON.parse(text(results[0]!.content)),
    queries.map((query) => ({
      name: query.name,
      result: reference.lookup(query.name, query.arguments),
    })),
  );
  assert.deepEqual(
    trace,
    queries.map((query) => ({ ...query, result: reference.lookup(query.name, query.arguments) })),
  );
});

test("wide native tool responses are handled without buying another tool round", async () => {
  const reference = new ShowdownReference("gen9championsvgc2026regmb");
  const names = [
    "Protect",
    "Earthquake",
    "Thunderbolt",
    "Surf",
    "Tailwind",
    "Trick Room",
    "Fake Out",
    "Helping Hand",
    "Shadow Ball",
    "Ice Beam",
    "Waterfall",
    "Rock Slide",
  ];
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: names.map((name, i) => ({
        id: `q-${i}`,
        name: "lookup_move",
        arguments: { name },
      })),
    },
    '{"sets":[]}',
  ]);
  await completeWithDexTools({
    provider,
    reference,
    policy,
    spec: "scripted",
    system: "build",
    messages: [{ role: "user", content: "Build." }],
  });
  assert.equal(provider.calls.length, 2);
  const results = provider.calls[1]!.messages.filter((message) => message.role === "tool");
  assert.deepEqual(
    results.map((message) => message.content),
    names.map((name) => reference.lookup("lookup_move", { name })),
  );
});

test("batch queries cannot reach unoffered tools and one tool failure does not lose other results", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        {
          id: "batch",
          name: "batch_tools",
          arguments: {
            queries: [
              { name: "search_board", arguments: {} },
              { name: "batch_tools", arguments: { queries: [queries[0]] } },
              { name: "read_memory_page", arguments: {} },
              queries[0],
            ],
          },
        },
      ],
    },
    '{"sets":[]}',
  ]);
  const reference = new ShowdownReference("gen9championsvgc2026regmb");
  await completeWithDexTools({
    provider,
    reference,
    policy,
    spec: "scripted",
    system: "build",
    messages: [],
    extraTools: [
      {
        definition: {
          name: "read_memory_page",
          description: "Read a page",
          parameters: { type: "object" },
        },
        run: () => {
          throw new Error("page unavailable");
        },
      },
    ],
  });
  const offeredBatch = provider.calls[0]!.options.tools!.find(
    (tool) => tool.name === "batch_tools",
  )!;
  assert.doesNotMatch(JSON.stringify(offeredBatch.parameters), /search_board|batch_tools/);
  const results = asRecords(JSON.parse(text(provider.calls[1]!.messages.at(-1)!.content)));
  assert.match(text(results[0]!.result), /Not executed/);
  assert.match(text(results[1]!.result), /Not executed/);
  assert.match(text(results[2]!.result), /page unavailable/);
  assert.equal(results[3]!.result, reference.lookup("lookup_move", { name: "Protect" }));
});

test("native calls and multiple batches share a query budget that resets for the next round", async () => {
  const query = (index: number) => ({ name: "read_memory_page", arguments: { index } });
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        { id: "first", ...query(0) },
        ...[1, 17].map((start) => ({
          id: `batch-${start}`,
          name: "batch_tools",
          arguments: { queries: Array.from({ length: 16 }, (_, i) => query(start + i)) },
        })),
      ],
    },
    { text: "", usage: {}, toolCalls: [{ id: "retry", ...query(32) }] },
    '{"sets":[]}',
  ]);
  const seen: number[] = [];
  await completeWithDexTools({
    provider,
    reference: new ShowdownReference("gen9championsvgc2026regmb"),
    policy,
    spec: "scripted",
    system: "build",
    messages: [],
    extraTools: [
      {
        definition: {
          name: "read_memory_page",
          description: "Read a page",
          parameters: { type: "object" },
        },
        run: (args) => {
          const index = Number(args.index);
          seen.push(index);
          return `page ${index}`;
        },
      },
    ],
  });
  assert.deepEqual(
    seen,
    Array.from({ length: 33 }, (_, i) => i),
  );
  const results = provider.calls[1]!.messages.filter((message) => message.role === "tool");
  const lastBatch = asRecords(JSON.parse(text(results.at(-1)!.content)));
  assert.match(text(lastBatch.at(-1)!.result), /Not executed/);
  assert.equal(provider.calls[2]!.messages.at(-2)!.content, "page 32");
});

test("empty, malformed and oversized batches execute no queries", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        { id: "empty", name: "batch_tools", arguments: { queries: [] } },
        {
          id: "bad",
          name: "batch_tools",
          arguments: { queries: [{ name: "lookup_move", arguments: "Protect" }] },
        },
        {
          id: "large",
          name: "batch_tools",
          arguments: { queries: Array.from({ length: 33 }, () => queries[0]) },
        },
      ],
    },
    '{"sets":[]}',
  ]);
  const trace: JsonObject[] = [];
  await completeWithDexTools({
    provider,
    reference: new ShowdownReference("gen9championsvgc2026regmb"),
    policy,
    spec: "scripted",
    system: "build",
    messages: [],
    onLookup: (row) => trace.push(row),
  });
  assert.equal(trace.length, 3);
  assert.ok(
    trace.every((row) => row.name === "batch_tools" && /Not executed/.test(text(row.result))),
  );
});

test("batched battle lookups retain verified memory and bind damage to visible state", async () => {
  const damage = {
    name: "estimate_damage",
    arguments: {
      attacker: "ally 1",
      defender: "foe 1",
      move: "Thunderbolt",
      defender_ability: "Volt Absorb",
      defender_stats: { hp: 1, spd: 1 },
    },
  };
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        {
          id: "batch",
          name: "batch_tools",
          arguments: { queries: [queries[0], queries[1], damage] },
        },
      ],
    },
    decision([0]),
    decision([0]),
  ]);
  const trace: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    traceLog: trace,
    decisionLog: [],
    closedSheets: true,
  });
  const battleRequest = request();
  battleRequest.side!.pokemon![0]!.stats = { atk: 75, def: 60, spa: 70, spd: 70, spe: 110 };
  await acceptedAct(engine, battleRequest, {
    povLines: [
      "|switch|p1a: Mon1|Pikachu, L50|100/100",
      "|switch|p2a: Garchomp|Garchomp, L50|100/100",
      "|turn|1",
    ],
  });
  const rows = asRecords(trace[0]!.tool_calls);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["lookup_move", "lookup_ability", "estimate_damage"],
  );
  assert.match(text(rows[2]!.result), /immune/);
  assert.doesNotMatch(text(rows[2]!.result), /Volt Absorb/);
  await acceptedAct(engine, battleRequest, { povLines: ["|turn|2"] });
  const nextPrompt = text(provider.calls[2]!.messages[0]!.content);
  assert.match(nextPrompt, /lookup_move.*Protect/);
  assert.match(nextPrompt, /lookup_ability.*Prankster/);
  assert.equal(
    asRecords(asRecord(JSON.parse(engine.coachingState())).verified_references).length,
    2,
  );
});

test("reflection batches preserve review scope and record each query", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        { id: "batch", name: "batch_tools", arguments: { queries: [queries[0], queries[3]] } },
      ],
    },
    JSON.stringify({
      summary: "Reviewed the outcome.",
      adjustment: "Recorded the evidence.",
      notebook: notebook(),
    }),
  ]);
  const trace: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, traceLog: trace, decisionLog: [] });
  await engine.endGame({
    gameNumber: 1,
    seriesOver: false,
    outcome: { winner: "opponent", turns: 1 },
  });
  assert.equal(provider.calls.length, 2);
  const rows = asRecords(trace[0]!.tool_calls);
  assert.match(text(rows[0]!.result), /Protect/);
  assert.match(text(rows[1]!.result), /Not executed/);
  assert.equal(trace[0]!.fallback, false);
});

test("cancelled reflections do not make a provider call or commit fallback memory", async () => {
  const controller = new AbortController();
  const provider = new ScriptedProvider([]);
  const trace: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    signal: controller.signal,
    traceLog: trace,
    decisionLog: [],
    initialNotebook: "Keep this model-authored plan.",
  });
  const before = engine.coachingState();
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(
    engine.endGame({
      gameNumber: 1,
      seriesOver: false,
      outcome: { winner: "opponent", turns: 1 },
    }),
    /operator cancelled/,
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(trace.length, 0);
  assert.equal(engine.coachingState(), before);
});

test("cancellation stops a batch before its remaining queries execute", async () => {
  const controller = new AbortController();
  const calls: ToolCall[] = [{ id: "batch", name: "batch_tools", arguments: { queries } }];
  const provider = new ScriptedProvider([{ text: "", usage: {}, toolCalls: calls }]);
  const trace: JsonObject[] = [];
  await assert.rejects(
    completeWithDexTools({
      provider,
      reference: new ShowdownReference("gen9championsvgc2026regmb"),
      policy,
      spec: "scripted",
      system: "build",
      messages: [],
      signal: controller.signal,
      onLookup: (row) => {
        trace.push(row);
        controller.abort(new Error("operator cancelled"));
      },
    }),
    /operator cancelled/,
  );
  assert.equal(trace.length, 1);
  assert.equal(provider.calls.length, 1);
});

test("native and batched duplicate queries share cached results without losing per-query evidence", async () => {
  const query = {
    name: "read_memory_page",
    arguments: { name: "lessons", range: { from: 1, to: 2 } },
  };
  const reordered = {
    name: "read_memory_page",
    arguments: { range: { to: 2, from: 1 }, name: "lessons" },
  };
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: {},
      toolCalls: [
        { id: "native", ...query },
        { id: "batch", name: "batch_tools", arguments: { queries: [reordered] } },
      ],
    },
    { text: "", usage: {}, toolCalls: [{ id: "again", ...query }] },
    '{"sets":[]}',
  ]);
  let executions = 0;
  const trace: JsonObject[] = [];
  await completeWithDexTools({
    provider,
    reference: new ShowdownReference("gen9championsvgc2026regmb"),
    policy,
    spec: "scripted",
    system: "build",
    messages: [],
    extraTools: [
      {
        definition: {
          name: "read_memory_page",
          description: "Page",
          parameters: { type: "object" },
        },
        run: () => {
          executions += 1;
          return "Model-authored memory page.";
        },
      },
    ],
    onLookup: (call) => trace.push(call),
  });
  assert.equal(executions, 1);
  assert.equal(trace.length, 3);
  assert.ok(trace.every((call) => call.result === "Model-authored memory page."));
  assert.equal(provider.calls[1]!.messages.at(-2)!.toolCallId, "native");
  assert.equal(provider.calls[1]!.messages.at(-1)!.toolCallId, "batch");
  assert.equal(provider.calls[2]!.messages.at(-2)!.toolCallId, "again");
});

test("live damage queries are recalculated after the battle state changes", async () => {
  const call = {
    id: "damage",
    name: "estimate_damage",
    arguments: { attacker: "ally 1", defender: "foe 1", move: "Thunderbolt" },
  };
  const provider = new ScriptedProvider([
    { text: "", usage: {}, toolCalls: [call] },
    decision([0]),
    { text: "", usage: {}, toolCalls: [call] },
    decision([0]),
  ]);
  const trace: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, traceLog: trace, decisionLog: [] });
  const battleRequest = request();
  battleRequest.side!.pokemon![0]!.stats = { atk: 75, def: 60, spa: 70, spd: 70, spe: 110 };
  await acceptedAct(engine, battleRequest, {
    povLines: [
      "|switch|p1a: Mon1|Pikachu, L50|100/100",
      "|switch|p2a: Incineroar|Incineroar, L50|100/100",
      "|turn|1",
    ],
  });
  await acceptedAct(engine, battleRequest, { povLines: ["|-boost|p1a: Mon1|spa|2", "|turn|2"] });
  const first = text(asRecords(trace[0]!.tool_calls)[0]!.result);
  const second = text(asRecords(trace[1]!.tool_calls)[0]!.result);
  assert.match(first, /Thunderbolt/);
  assert.match(second, /Thunderbolt/);
  assert.doesNotMatch(first + second, /Tool error|Not executed/);
  assert.notEqual(first, second);
  assert.equal(
    asRecords(asRecord(JSON.parse(engine.coachingState())).verified_references).length,
    0,
  );
});
