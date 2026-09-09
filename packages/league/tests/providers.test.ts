import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  ApiError,
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  nitroSpec,
  opencodeApi,
  parseRoutingPreferences,
  parseSpec,
  toolResultMessage,
  uniqueToolCalls,
  validateModelExecution,
  validateReasoning,
} from "../src/providers.js";
import type { Completion, JsonObject, JsonValue } from "../src/types.js";
import { asRecord, asRecords, text } from "../src/value.js";
import { completeWithDexTools } from "../src/dex-lookups.js";
import { ShowdownReference } from "../src/reference.js";

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestJson(init: RequestInit | undefined): JsonObject {
  const body = init?.body;
  if (body instanceof Object || body == null) return {};
  const parsed: JsonValue = JSON.parse(body);
  return asRecord(parsed);
}

function sseResponse(events: unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function chatStream(text: string, final: JsonObject = {}): Response {
  const base = { id: "gen_1", object: "chat.completion.chunk", created: 1, model: "stub" };
  return sseResponse([
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...final },
  ]);
}

test("duplicate IDs and malformed calls get one consistent wire reply and no unintended execution", async () => {
  const requests: JsonObject[] = [];
  let executions = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requests.push(requestJson(init));
    if (requests.length > 1) return chatStream('{"sets":[]}');
    return sseResponse([
      {
        id: "gen",
        object: "chat.completion.chunk",
        created: 1,
        model: "stub",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 3,
                  id: "valid",
                  type: "function",
                  function: { name: "read_memory_page", arguments: '{"name":"valid"}' },
                },
                {
                  index: 0,
                  id: "repeat",
                  type: "function",
                  function: { name: "read_memory_page", arguments: '{"name":"first"}' },
                },
                {
                  index: 1,
                  id: "repeat",
                  type: "function",
                  function: { name: "read_memory_page", arguments: '{"name":"second"}' },
                },
                {
                  index: 2,
                  id: "invalid",
                  type: "function",
                  function: { name: "read_memory_page", arguments: "{" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
  };
  const trace: JsonObject[] = [];
  await completeWithDexTools({
    provider: makeProvider(parseSpec("prime:tool-model"), { apiKey: "test-key", fetch }),
    reference: new ShowdownReference("gen9championsvgc2026regmc"),
    policy: { maxTokens: 4096, toolRounds: 2 },
    spec: "prime:tool-model",
    system: "Build",
    messages: [{ role: "user", content: "Build." }],
    extraTools: [
      {
        definition: {
          name: "read_memory_page",
          description: "Read",
          parameters: { type: "object" },
        },
        run: (args) => {
          executions += 1;
          return `Page ${text(args.name)}`;
        },
      },
    ],
    onLookup: (call) => trace.push(call),
  });
  assert.equal(executions, 1, JSON.stringify({ trace, requests: requests.length }));
  assert.equal(requests.length, 2);
  const messages = asRecords(requests[1]!.messages);
  const calls = messages.flatMap((message) => asRecords(message.tool_calls));
  const results = messages.filter((message) => message.role === "tool");
  assert.deepEqual(
    calls.map((call) => call.id),
    ["valid", "repeat", "invalid"],
  );
  assert.deepEqual(
    results.map((result) => result.tool_call_id),
    ["valid", "repeat", "invalid"],
  );
  assert.equal(asRecord(calls[0]!.function).arguments, '{"name":"valid"}');
  assert.equal(results[0]!.content, "Page valid");
  for (const result of results.slice(1))
    assert.match(text(result.content), /Not executed: invalid tool input/);
  assert.equal(trace.length, 3);
});

test("replay normalization preserves signed reasoning, call metadata, and its source response", () => {
  const metadata = {
    anthropic: { signature: "signed-reasoning" },
    google: { thoughtSignature: "signed-thought" },
    openai: { encryptedContent: "encrypted-reasoning" },
  };
  const completion: Completion = {
    text: "",
    usage: {},
    toolCalls: [
      { id: "", name: "lookup_move", arguments: { name: "Protect" } },
      { id: "call_0", name: "lookup_item", arguments: { name: "Focus Sash" } },
      { id: "call_0", name: "lookup_ability", arguments: { name: "Prankster" } },
    ],
    responseMessages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Preserve this exactly.", providerOptions: metadata },
          {
            type: "tool-call",
            toolCallId: "",
            toolName: "lookup_move",
            input: { name: "Protect" },
            providerOptions: { google: { thoughtSignature: "tool-signature" } },
          },
          {
            type: "tool-call",
            toolCallId: "call_0",
            toolName: "lookup_item",
            input: { name: "Focus Sash" },
          },
          {
            type: "tool-call",
            toolCallId: "call_0",
            toolName: "lookup_ability",
            input: { name: "Prankster" },
          },
        ],
      },
    ],
  };
  const original = structuredClone(completion);
  const replay = assistantToolMessage(completion);
  assert.deepEqual(completion, original);
  const assistant = replay.raw![0]!;
  assert.ok(assistant.role === "assistant" && Array.isArray(assistant.content));
  assert.deepEqual(assistant.content[0], {
    type: "reasoning",
    text: "Preserve this exactly.",
    providerOptions: metadata,
  });
  const calls = assistant.content.filter((part) => part.type === "tool-call");
  assert.deepEqual(
    calls.map((call) => call.toolCallId),
    replay.toolCalls!.map((call) => call.id),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.providerOptions, { google: { thoughtSignature: "tool-signature" } });
  assert.equal(calls[1]!.toolName, "lookup_item");
});

test("compatible batches replay each tool result and contiguous reasoning through the SDK wire", async () => {
  const requests: JsonObject[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requests.push(requestJson(init));
    if (requests.length === 2) return chatStream('{"pick":"garchomp"}');
    const base = { id: "gen_batch", object: "chat.completion.chunk", created: 1, model: "stub" };
    return sseResponse([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: "Read " },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "both facts.", tool_calls: [] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "batch-1",
                  type: "function",
                  function: {
                    name: "batch_tools",
                    arguments: JSON.stringify({
                      queries: [
                        { name: "lookup_move", arguments: { name: "Protect" } },
                        { name: "lookup_ability", arguments: { name: "Prankster" } },
                      ],
                    }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  };
  const reference = new ShowdownReference("gen9championsvgc2026regmc");
  const completion = await completeWithDexTools({
    provider: makeProvider(parseSpec("prime:tool-model"), { apiKey: "test-key", fetch }),
    reference,
    policy: { maxTokens: 4096, toolRounds: 2 },
    spec: "prime:tool-model",
    system: "Draft",
    messages: [{ role: "user", content: "Choose." }],
  });
  assert.equal(requests.length, 2);
  assert.equal(completion.text, '{"pick":"garchomp"}');
  assert.equal(completion.reasoning, "Read both facts.");
  const messages = requests[1]!.messages;
  assert.ok(Array.isArray(messages));
  const result = messages.map(asRecord).find((message) => message.role === "tool")!;
  assert.equal(result.tool_call_id, "batch-1");
  assert.deepEqual(JSON.parse(text(result.content)), [
    { name: "lookup_move", result: reference.lookup("lookup_move", { name: "Protect" }) },
    { name: "lookup_ability", result: reference.lookup("lookup_ability", { name: "Prankster" }) },
  ]);
});

test("provider specs are exactly OpenRouter, Prime Inference, the Vercel AI Gateway, OpenCode, and random", () => {
  assert.deepEqual(parseSpec("openrouter:anthropic/claude-sonnet-4:nitro"), {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4:nitro",
  });
  assert.deepEqual(parseSpec("prime:Qwen/Qwen3-32B"), {
    provider: "prime",
    model: "Qwen/Qwen3-32B",
  });
  assert.deepEqual(parseSpec("gateway:anthropic/claude-sonnet-4.5"), {
    provider: "gateway",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.deepEqual(parseSpec("opencode-go:grok-code"), {
    provider: "opencode-go",
    model: "grok-code",
  });
  assert.deepEqual(parseSpec("opencode-zen:claude-fable-5"), {
    provider: "opencode-zen",
    model: "claude-fable-5",
  });
  assert.deepEqual(parseSpec("random"), { provider: "random", model: "random" });
  assert.throws(
    () => validateReasoning(parseSpec("prime:model"), "high"),
    /no advertised configurable reasoning/,
  );
  assert.doesNotThrow(() => validateReasoning(parseSpec("opencode-go:kimi-k3"), "high"));
  assert.throws(
    () => validateReasoning(parseSpec("gateway:model"), "high"),
    /no advertised configurable reasoning/,
  );
  assert.doesNotThrow(() => validateReasoning(parseSpec("openrouter:model"), "high"));
  // SAFETY: exercises the runtime guard against a level the type forbids.
  assert.throws(
    () => validateReasoning(parseSpec("openrouter:model"), "off" as never),
    /invalid reasoning level/,
  );

  for (const value of [
    "openrouter:",
    "prime:",
    "prime:-model",
    "gateway:",
    "gateway:-model",
    "opencode-go:",
    "opencode-zen:-model",
    "openrouter:model name",
    "unknown:model",
    "random:anything",
  ]) {
    assert.throws(() => parseSpec(value), value);
  }
});

test("run-scoped credentials are isolated by exact model spec", async () => {
  assert.throws(
    () =>
      validateModelExecution(["openrouter:model-a", "prime:model-b"], {
        apiKeys: { "openrouter:model-a": "openrouter-key" },
      }),
    /API key missing for prime:model-b/,
  );

  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousPrime = process.env.PRIME_API_KEY;
  process.env.OPENROUTER_API_KEY = "openrouter-only";
  delete process.env.PRIME_API_KEY;
  try {
    await assert.rejects(
      makeProvider(parseSpec("prime:model")).complete("system", []),
      /Missing PRIME_API_KEY/,
    );
    delete process.env.OPENROUTER_API_KEY;
    process.env.PRIME_API_KEY = "prime-only";
    await assert.rejects(
      makeProvider(parseSpec("openrouter:model")).complete("system", []),
      /Missing OPENROUTER_API_KEY/,
    );
  } finally {
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
    if (previousPrime === undefined) delete process.env.PRIME_API_KEY;
    else process.env.PRIME_API_KEY = previousPrime;
  }
});

test("OpenRouter disables fallback and optionally pins exactly one upstream", () => {
  assert.deepEqual(parseRoutingPreferences({}), { allow_fallbacks: false });
  assert.deepEqual(parseRoutingPreferences({ VGC_OPENROUTER_PIN: "deepinfra" }), {
    order: ["deepinfra"],
    allow_fallbacks: false,
  });
  assert.throws(
    () => parseRoutingPreferences({ VGC_OPENROUTER_PIN: "deepinfra,together" }),
    /exactly one upstream provider/,
  );
});

test("OpenRouter executes the model spec while recording its pinned upstream as routing metadata", async () => {
  const previousPin = process.env.VGC_OPENROUTER_PIN;
  process.env.VGC_OPENROUTER_PIN = "deepinfra";
  let url = "";
  let authorization = "";
  let body: JsonObject = {};
  const fetch: typeof globalThis.fetch = async (input, init) => {
    url = requestUrl(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    body = requestJson(init);
    return chatStream("ok", {
      provider: "DeepInfra",
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.00123 },
    });
  };
  try {
    const completion = await makeProvider(parseSpec("openrouter:z-ai/glm-5:nitro"), {
      apiKey: "openrouter-key",
      reasoning: "medium",
      fetch,
    }).complete("system", [{ role: "user", content: "hello" }]);

    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(authorization, "Bearer openrouter-key");
    assert.equal(body.model, "z-ai/glm-5:nitro");
    assert.deepEqual(body.provider, { order: ["deepinfra"], allow_fallbacks: false });
    assert.deepEqual(body.usage, { include: true });
    assert.equal(body.reasoning_effort, "medium");
    assert.equal(completion.provider, "DeepInfra");
    assert.deepEqual(completion.usage, { input_tokens: 4, output_tokens: 2, cost: 0.00123 });
    assert.equal(completion.finishReason, "stop");
  } finally {
    if (previousPin === undefined) delete process.env.VGC_OPENROUTER_PIN;
    else process.env.VGC_OPENROUTER_PIN = previousPin;
  }
});

test("OpenRouter marks Anthropic system and first-user cache breakpoints, other vendors untouched", async () => {
  let body: JsonObject = {};
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = requestJson(init);
    return chatStream("ok");
  };
  const messages = [
    { role: "user" as const, content: "board" },
    { role: "user" as const, content: "pick" },
  ];
  await makeProvider(parseSpec("openrouter:anthropic/claude-opus-5"), {
    apiKey: "openrouter-key",
    fetch,
  }).complete("rules", messages);
  assert.deepEqual(body.messages, [
    {
      role: "system",
      content: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "board", cache_control: { type: "ephemeral" } }],
    },
    { role: "user", content: "pick" },
  ]);

  await makeProvider(parseSpec("openrouter:z-ai/glm-5"), {
    apiKey: "openrouter-key",
    fetch,
  }).complete("rules", messages);
  assert.deepEqual(body.messages, [
    { role: "system", content: "rules" },
    { role: "user", content: "board" },
    { role: "user", content: "pick" },
  ]);
});

test("Prime uses only its fixed OpenAI-compatible chat endpoint and plain response metadata", async () => {
  let url = "";
  let authorization = "";
  let body: JsonObject = {};
  const fetch: typeof globalThis.fetch = async (input, init) => {
    url = requestUrl(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    body = requestJson(init);
    return chatStream("prime reply", {
      provider: "must-not-surface",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cost: 99 },
    });
  };

  const completion = await makeProvider(parseSpec("prime:test-model"), {
    apiKey: "prime-key",
    fetch,
  }).complete("system", [{ role: "user", content: "hello" }], { maxTokens: 2222 });

  assert.equal(url, "https://api.pinference.ai/api/v1/chat/completions");
  assert.equal(authorization, "Bearer prime-key");
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 2222);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal("provider" in body, false);
  assert.equal(completion.provider, undefined);
  assert.deepEqual(completion.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal(completion.text, "prime reply");
});

test("the Vercel AI Gateway uses only its fixed OpenAI-compatible chat endpoint", async () => {
  let url = "";
  let authorization = "";
  let body: JsonObject = {};
  const fetch: typeof globalThis.fetch = async (input, init) => {
    url = requestUrl(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    body = requestJson(init);
    return chatStream("gateway reply", {
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  };

  const completion = await makeProvider(parseSpec("gateway:anthropic/claude-sonnet-4.5"), {
    apiKey: "gateway-key",
    fetch,
  }).complete("system", [{ role: "user", content: "hello" }], { maxTokens: 1111 });

  assert.equal(url, "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(authorization, "Bearer gateway-key");
  assert.equal(body.model, "anthropic/claude-sonnet-4.5");
  assert.equal(body.max_tokens, 1111);
  assert.equal(completion.text, "gateway reply");
  assert.deepEqual(completion.usage, { input_tokens: 5, output_tokens: 2 });
});

test("the common compatible stream preserves tools, structured finish reason, and replay messages", async () => {
  let body: JsonObject = {};
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = requestJson(init);
    const base = { id: "gen_tool", object: "chat.completion.chunk", created: 1, model: "stub" };
    return sseResponse([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup_move", arguments: '{"name":"Pro' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'tect"}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      },
    ]);
  };

  const completion = await makeProvider(parseSpec("prime:tool-model"), {
    apiKey: "prime-key",
    fetch,
  }).complete("system", [{ role: "user", content: "check Protect" }], {
    toolChoice: "required",
    tools: [
      {
        name: "lookup_move",
        description: "Look up a move",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
  });

  assert.match(JSON.stringify(body.tools), /lookup_move/);
  assert.equal(body.tool_choice, "required");
  assert.equal(completion.finishReason, "tool-calls");
  assert.deepEqual(completion.toolCalls, [
    { id: "call_1", name: "lookup_move", arguments: { name: "Protect" } },
  ]);
  assert.ok(
    completion.responseMessages?.length,
    "the SDK assistant response is retained for replay",
  );
  const replay = assistantToolMessage(completion);
  assert.deepEqual(replay.toolCalls, completion.toolCalls);
  assert.deepEqual(replay.raw, completion.responseMessages);
  assert.deepEqual(toolResultMessage("call_1", "Protect is a status move"), {
    role: "tool",
    toolCallId: "call_1",
    content: "Protect is a status move",
  });
  assert.deepEqual(
    uniqueToolCalls([...completion.toolCalls, completion.toolCalls[0]!]),
    completion.toolCalls,
  );
});

test("infra-class failures retry with backoff until the provider heals", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response('{"error":{"message":"upstream sad"}}', { status: 503 });
    return chatStream("healed");
  };
  const completion = await makeProvider(parseSpec("prime:retry-model"), {
    apiKey: "prime-key",
    retry: { attempts: 5, baseMs: 1, capMs: 2 },
    fetch,
  }).complete("system", [{ role: "user", content: "hello" }]);
  assert.equal(calls, 3);
  assert.equal(completion.text, "healed");
});

test("failFast and terminal failures skip infra retries", async () => {
  let calls = 0;
  const failing: typeof globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":{"message":"upstream sad"}}', { status: 503 });
  };
  await assert.rejects(
    makeProvider(parseSpec("prime:fail-fast-model"), {
      apiKey: "prime-key",
      retry: { attempts: 5, baseMs: 1, capMs: 2 },
      fetch: failing,
    }).complete("system", [{ role: "user", content: "hello" }], { failFast: true }),
  );
  assert.equal(calls, 1);

  let terminalCalls = 0;
  const unauthorized: typeof globalThis.fetch = async () => {
    terminalCalls += 1;
    return new Response('{"error":{"message":"bad key"}}', { status: 401 });
  };
  await assert.rejects(
    makeProvider(parseSpec("prime:terminal-model"), {
      apiKey: "prime-key",
      retry: { attempts: 5, baseMs: 1, capMs: 2 },
      fetch: unauthorized,
    }).complete("system", [{ role: "user", content: "hello" }]),
  );
  assert.equal(terminalCalls, 1);
});

test("compatible HTTP and in-band stream failures preserve retry classification without leaking keys", async () => {
  const failed = makeProvider(parseSpec("prime:failed-model"), {
    apiKey: "prime-secret",
    retry: { attempts: 1 },
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "service unavailable prime-secret" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    failed.complete("system", [{ role: "user", content: "hello" }]),
    (cause: unknown) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.status, 503);
      assert.doesNotMatch(cause.message, /prime-secret/);
      assert.match(cause.message, /\[redacted\]/);
      assert.deepEqual(classifyProviderFailure(cause, "prime:failed-model"), {
        kind: "upstream",
        summary: "Prime Inference API is temporarily unavailable (503).",
        terminal: false,
      });
      return true;
    },
  );

  const inBand = makeProvider(parseSpec("openrouter:failed-model"), {
    apiKey: "openrouter-key",
    retry: { attempts: 1 },
    fetch: async () => sseResponse([{ error: { code: 502, message: "upstream worker failed" } }]),
  });
  await assert.rejects(
    inBand.complete("system", [{ role: "user", content: "hello" }]),
    (cause: unknown) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.status, 502);
      return true;
    },
  );
});

test("adapter redacts thrown transport and malformed stream failures", async () => {
  const suppliedKey = "supplied-provider-secret";
  const environmentKey = "environment-provider-secret";
  const previous = process.env.PRIME_API_KEY;
  process.env.PRIME_API_KEY = environmentKey;
  const failures: Array<{ label: string; fetch: typeof globalThis.fetch }> = [
    {
      label: "Error transport",
      fetch: async () => {
        throw new Error(`transport exposed ${suppliedKey} and ${environmentKey}`);
      },
    },
    {
      label: "primitive transport",
      fetch: async () => {
        throw suppliedKey;
      },
    },
    {
      label: "malformed stream",
      fetch: async () =>
        new Response(
          `data: {"secret":"${suppliedKey}"

`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    },
  ];
  try {
    for (const failure of failures) {
      const provider = makeProvider(parseSpec("prime:redaction-test"), {
        apiKey: suppliedKey,
        retry: { attempts: 1 },
        fetch: failure.fetch,
      });
      await assert.rejects(
        provider.complete("system", [{ role: "user", content: "hello" }]),
        (cause: unknown) => {
          assert.ok(cause instanceof Error, failure.label);
          assert.doesNotMatch(
            cause.message,
            new RegExp(`${suppliedKey}|${environmentKey}`),
            failure.label,
          );
          return true;
        },
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PRIME_API_KEY;
    else process.env.PRIME_API_KEY = previous;
  }
});

test("nitro routing changes only OpenRouter specs", () => {
  assert.equal(nitroSpec("openrouter:model"), "openrouter:model:nitro");
  assert.equal(nitroSpec("openrouter:model:floor"), "openrouter:model:floor");
  assert.equal(nitroSpec("prime:model"), "prime:model");
  assert.equal(nitroSpec("random"), "random");
});

test("OpenRouter forwards an explicit reasoning token budget with text headroom", async () => {
  let body: JsonObject = {};
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = requestJson(init);
    return chatStream("ok", { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  };
  await makeProvider(parseSpec("openrouter:test/model"), {
    apiKey: "k",
    reasoning: "high",
    fetch,
  }).complete("system", [{ role: "user", content: "hello" }], {
    maxTokens: 16384,
    reasoningMaxTokens: 12288,
  });
  assert.equal(body.max_tokens, 16384);
  assert.deepEqual(body.reasoning, { max_tokens: 12288 });
  assert.equal(body.reasoning_effort, undefined);
});

test("OpenCode models are routed to the one API shape that serves them", async () => {
  assert.equal(opencodeApi("opencode-go", "kimi-k3"), "chat");
  assert.equal(opencodeApi("opencode-go", "glm-5.3"), "chat");
  assert.equal(opencodeApi("opencode-go", "deepseek-v4-flash"), "chat");
  assert.equal(opencodeApi("opencode-go", "grok-4.5"), "responses");
  assert.equal(opencodeApi("opencode-go", "gpt-5.6-luna"), "responses");
  assert.equal(opencodeApi("opencode-go", "muse-spark-1.2-contributor"), "responses");
  assert.equal(opencodeApi("opencode-go", "minimax-m3"), "messages");
  assert.equal(opencodeApi("opencode-zen", "minimax-m3"), "chat");
  assert.equal(opencodeApi("opencode-go", "qwen3.8-max"), "messages");
  assert.equal(opencodeApi("opencode-zen", "claude-fable-5"), "messages");
  assert.equal(opencodeApi("opencode-zen", "gemini-3.5-flash"), "google");

  const requests: Array<{ url: string; body: JsonObject }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: requestUrl(input), body: requestJson(init) });
    return new Response('{"error":"stub"}', { status: 500 });
  };
  for (const model of ["kimi-k3", "muse-spark-1.2-contributor", "minimax-m3"]) {
    await assert.rejects(
      makeProvider(parseSpec(`opencode-go:${model}`), {
        apiKey: "opencode-key",
        reasoning: "high",
        retry: { attempts: 1 },
        fetch,
      }).complete("system", [{ role: "user", content: "hello" }]),
    );
  }
  assert.deepEqual(
    [...new Set(requests.map((request) => request.url))],
    [
      "https://opencode.ai/zen/go/v1/chat/completions",
      "https://opencode.ai/zen/go/v1/responses",
      "https://opencode.ai/zen/go/v1/messages",
    ],
  );
  assert.deepEqual(
    [...new Set(requests.map((request) => request.body.model))],
    ["kimi-k3", "muse-spark-1.2-contributor", "minimax-m3"],
  );
  const kimi = requests.find((request) => request.body.model === "kimi-k3")!;
  const muse = requests.find((request) => request.body.model === "muse-spark-1.2-contributor")!;
  const minimax = requests.find((request) => request.body.model === "minimax-m3")!;
  assert.equal(kimi.body.reasoning_effort, "high");
  assert.deepEqual(muse.body.reasoning, { effort: "high" });
  assert.ok(minimax.body.thinking !== undefined || minimax.body.output_config !== undefined);
});
