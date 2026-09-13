import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import {
  withAgentHost,
  type AgentProgress,
  type AgentRuntime,
  type AgentTool,
} from "../src/agent-runtime.js";
import { readLiveRun } from "../src/live-watch.js";
import { LLMEngine } from "../src/llm-engine.js";
import { RandomEngine } from "../src/battle-agent.js";
import { SimBattle } from "../src/sim.js";
import { withRunStatus } from "../src/run-status.js";
import { runStage } from "../src/stage-agent.js";
import { loadPool } from "../src/teams.js";
import type { JsonObject } from "../src/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

interface Reply {
  input?: JsonObject;
  tool?: string;
  text?: string;
  tokens?: number;
  status?: number;
  finishReason?: string;
}

const openAiMessages = z.array(
  z.object({
    role: z.string(),
    content: z.string().nullish(),
    tool_calls: z
      .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
      .optional(),
  }),
);

function submissions(body: JsonObject | undefined, name: string): JsonObject[] {
  return openAiMessages
    .parse(body?.messages)
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.function.name === name)
    .map((call) => z.record(z.string(), z.json()).parse(JSON.parse(call.function.arguments)));
}

async function fixture(
  respond: (body: JsonObject, index: number) => Promise<Reply> | Reply,
  model = "test",
  provider: "openrouter" | "google" = "openrouter",
) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "league-agent-"));
  cleanup.push(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const requests: JsonObject[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: JsonObject = JSON.parse(Buffer.concat(chunks).toString());
    authorizations.push(request.headers.authorization);
    const index = requests.push(body);
    const reply = await respond(body, index);
    if (reply.status) {
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Provider temporarily unavailable" } }));
      return;
    }
    const offered = (names: string[]) =>
      reply.tool ?? names.find((name) => name.startsWith("submit_"))!;
    if (provider === "google") {
      const name = offered(
        z
          .array(z.object({ functionDeclarations: z.array(z.object({ name: z.string() })) }))
          .parse(body.tools)
          .flatMap((tool) => tool.functionDeclarations.map((tool) => tool.name)),
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: reply.input
                  ? [{ functionCall: { name, args: reply.input } }]
                  : [{ thought: true, text: reply.text ?? "Considering the choice" }],
              },
            },
          ],
        },
        {
          candidates: [{ finishReason: reply.finishReason ?? "STOP" }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
        },
      ])
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end();
      return;
    }
    const delta = reply.input
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_${index}`,
              type: "function",
              function: {
                name: offered(
                  z
                    .array(z.object({ function: z.object({ name: z.string() }) }))
                    .parse(body.tools)
                    .map((tool) => tool.function.name),
                ),
                arguments: JSON.stringify(reply.input),
              },
            },
          ],
        }
      : { content: reply.text ?? "Done" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: reply.input ? "tool_calls" : "stop" }],
        usage: {
          prompt_tokens: reply.tokens ?? 40,
          completion_tokens: 10,
          total_tokens: (reply.tokens ?? 40) + 10,
        },
      },
    ])
      response.write(
        `data: ${JSON.stringify({ id: `chat_${index}`, object: "chat.completion.chunk", created: 1, model: "test", ...chunk })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = z.object({ port: z.number() }).parse(server.address());
  const configure = (session: string) => {
    const directory = path.join(runDir, "agents", encodeURIComponent(session));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "agents", "opencode.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            package: `@opencode/ai/providers/${provider}`,
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" },
            models: {
              [model]: {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 128000, output: 32000 },
              },
            },
          },
        },
      }),
    );
  };
  configure("seat-0");
  const task = {
    session: "seat-0",
    task: "pick-1",
    model: `${provider}:${model}`,
    system: "Play Pokémon. Choose Pikachu.",
    prompt: "PRIVATE_FIRST_OBSERVATION",
    submission: {
      name: "submit_pick",
      description: "Submit a pick.",
      parameters: {
        type: "object",
        properties: { pick: { type: "string" } },
        required: ["pick"],
        additionalProperties: false,
      },
    },
    validate: (input: JsonObject) => {
      if (input.pick !== "Pikachu") throw new Error("Only Pikachu is legal.");
      return input.pick;
    },
    signal: AbortSignal.timeout(30000),
  };
  const host = <T>(
    run: (agents: AgentRuntime) => Promise<T>,
    onProgress?: (p: AgentProgress) => void,
  ) => withAgentHost(runDir, run, onProgress);
  return { runDir, requests, authorizations, task, configure, host };
}

it("repairs native tool submissions, stops immediately, and continues the durable private conversation", async () => {
  const { runDir, requests, authorizations, task, configure, host } = await fixture(
    (_body, index) => ({ input: { pick: index === 1 ? "illegal" : "Pikachu" } }),
  );
  fs.writeFileSync(path.join(runDir, "AGENTS.md"), "FOREIGN_PROJECT_INSTRUCTIONS");
  const progress: AgentProgress[] = [];
  await host(
    async (agents) => {
      const first = await agents.run(task);
      expect(first.value).toBe("Pikachu");
      expect(first.attempts).toBe(2);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("Only Pikachu is legal");
      expect(JSON.stringify(requests[0])).not.toMatch(
        /FOREIGN_PROJECT_INSTRUCTIONS|Working directory|worktree|"name":"(?:shell|read|task|webfetch)"/,
      );
      await expect(agents.run({ ...task, prompt: "Changed state" })).rejects.toThrow(
        "input changed",
      );
      await expect(agents.run({ ...task, system: "Changed rules" })).rejects.toThrow(
        "input changed",
      );
      const recovered = await agents.run(task);
      expect(recovered.sessionID).toBe(first.sessionID);
      expect(first.latencyMs).toBeGreaterThan(0);
      expect(recovered.latencyMs).toBe(first.latencyMs);
      expect(recovered.recoveryMs).toBeGreaterThan(0);
      expect(recovered.tools).toEqual(first.tools);
      expect(recovered.usage).toEqual(first.usage);
      expect(requests).toHaveLength(2);
      const second = await agents.run({
        ...task,
        task: "pick-2",
        prompt: "NEXT_OBSERVATION",
        system: "UPDATED_COACHING_INSTRUCTIONS",
      });
      expect(second.sessionID).toBe(first.sessionID);
      expect(JSON.stringify(requests[2])).toContain("PRIVATE_FIRST_OBSERVATION");
      expect(submissions(requests[2], "submit_pick")).toEqual([
        { pick: "illegal" },
        { pick: "Pikachu" },
      ]);
      expect(JSON.stringify(requests[2])).toContain("UPDATED_COACHING_INSTRUCTIONS");
      configure("seat-1");
      const rival = await agents.run({
        ...task,
        session: "seat-1",
        prompt: "RIVAL_OBSERVATION",
      });
      expect(rival.sessionID).not.toBe(first.sessionID);
      expect(JSON.stringify(requests[3])).not.toContain("PRIVATE_FIRST_OBSERVATION");
      expect(authorizations).toEqual(Array(4).fill("Bearer test"));
      expect(requests[0]?.provider).toEqual({ allow_fallbacks: false });
    },
    (event) => progress.push(event),
  );
  expect(progress.some((event) => event.activity === "tool" && event.tool === "submit_pick")).toBe(
    true,
  );
  expect(progress.some((event) => (event.usage?.inputTokens ?? 0) > 0)).toBe(true);
  expect(progress.at(-1)).toMatchObject({ session: "seat-1", activity: "ended" });
  expect(JSON.stringify(progress)).not.toContain("PRIVATE_FIRST_OBSERVATION");
}, 60000);

it("keeps concurrent seats' credentials, tools, and observations private within one host", async () => {
  const release = Promise.withResolvers<void>();
  const { runDir, task, requests, configure, host } = await fixture(async () => {
    await release.promise;
    return { input: { pick: "Pikachu" } };
  });
  configure("seat-1");
  await withRunStatus(runDir, () =>
    host(async (agents) => {
      const running = Promise.all([
        agents.run({
          ...task,
          tools: [
            {
              definition: {
                name: "private_lookup",
                description: "Private lookup",
                parameters: { type: "object", properties: {} },
              },
              run: () => "private",
            },
          ],
        }),
        agents.run({
          ...task,
          session: "seat-1",
          prompt: "RIVAL_OBSERVATION",
        }),
      ]);
      try {
        await vi.waitFor(() => {
          const live = readLiveRun(runDir);
          expect(live?.agents).toHaveLength(2);
          expect(live?.agents.map((agent) => agent.session).sort()).toEqual(["seat-0", "seat-1"]);
          expect(JSON.stringify(live)).not.toMatch(
            /PRIVATE_FIRST_OBSERVATION|RIVAL_OBSERVATION/,
          );
        });
      } finally {
        release.resolve();
        await running;
      }
      const results = await running;
      expect(results[0].sessionID).not.toBe(results[1].sessionID);
    }),
  );
  const rival = requests.find((request) => JSON.stringify(request).includes("RIVAL_OBSERVATION"));
  expect(rival).toBeDefined();
  expect(JSON.stringify(rival)).not.toMatch(/PRIVATE_FIRST_OBSERVATION|private_lookup/);
  expect(requests).toHaveLength(2);
}, 60000);

it("stops recording reference calls once a task spends its budget", async () => {
  const { task, requests, host } = await fixture((_body, index) =>
    index === 1
      ? {
          tool: "execute",
          input: {
            code: 'const out = []; for (let i = 0; i < 405; i++) out.push(await tools.lookup_species({ species: "P" + i })); return out.slice(-2);',
          },
        }
      : { input: { pick: "Pikachu" } },
  );
  const lookup: AgentTool = {
    definition: {
      name: "lookup_species",
      description: "Look up a species.",
      parameters: {
        type: "object",
        properties: { species: { type: "string" } },
        required: ["species"],
        additionalProperties: false,
      },
    },
    run: (input) => `${z.string().parse(input.species)}: row`,
  };
  const result = await host((agents) => agents.run({ ...task, tools: [lookup] }));
  expect(result.value).toBe("Pikachu");
  expect(result.tools).toHaveLength(402);
  expect(result.tools[399]).toEqual({
    name: "lookup_species",
    arguments: { species: "P399" },
    result: "P399: row",
  });
  expect(result.tools[400]?.result).toContain("budget of 400 reference calls is spent");
  expect(result.tools[401]?.name).toBe("submit_pick");
  expect(JSON.stringify(requests[1])).toContain("budget of 400 reference calls is spent");
  expect(JSON.stringify(requests[1])).not.toContain("P399: row");
  expect(JSON.stringify(requests[0])).toContain("at most 400 reference calls");
}, 60000);


it("returns lookups and validation errors to the model and logs the stage line", async () => {
  const { runDir, task, requests, host } = await fixture((_body, index) => {
    if (index === 1)
      return {
        tool: "execute",
        input: { code: 'return await tools.lookup_species({ species: "Pikachu" });' },
      };
    return { input: { pick: index === 2 ? "Raichu" : "Pikachu" } };
  });
  const lookup: AgentTool = {
    definition: {
      name: "lookup_species",
      description: "Look up a species.",
      parameters: {
        type: "object",
        properties: { species: { type: "string" } },
        required: ["species"],
        additionalProperties: false,
      },
    },
    run: (input) => `${z.string().parse(input.species)}: Electric mouse`,
  };
  const logFile = path.join(runDir, "stage.jsonl");
  const result = await host((agents) =>
    runStage({ ...task, tools: [lookup], runner: agents.run, logFile }),
  );
  expect(result.value).toBe("Pikachu");
  expect(result.attempts).toBe(2);
  expect(result.tools).toEqual([
    {
      name: "lookup_species",
      arguments: { species: "Pikachu" },
      result: "Pikachu: Electric mouse",
    },
    { name: "submit_pick", arguments: { pick: "Raichu" }, result: "Only Pikachu is legal." },
    { name: "submit_pick", arguments: { pick: "Pikachu" }, result: expect.any(String) },
  ]);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[0])).toContain("tools.lookup_species(");
  const toolResults = (body: JsonObject | undefined) =>
    openAiMessages
      .parse(body?.messages)
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
  expect(toolResults(requests[1])).toHaveLength(1);
  expect(toolResults(requests[1])[0]).toContain("Pikachu: Electric mouse");
  const rejected = toolResults(requests[2]);
  expect(rejected).toHaveLength(2);
  expect(rejected[1]).toContain("Only Pikachu is legal.");
  const lines = fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    attempt: 2,
    task_id: "pick-1",
    tool_lookups: result.tools,
    session_id: result.sessionID,
    message_id: result.messageID,
  });
}, 60000);

it.each([{ pick: 42 }, { pick: "illegal" }])(
  "stops repeated schema or domain rejections and can resume after correction: %j",
  async (input) => {
    const { task, requests, host } = await fixture((_body, index) => ({
      input: index <= 5 ? input : { pick: "Pikachu" },
    }));
    await host(async (agents) => {
      await expect(agents.run(task)).rejects.toThrow("submit_pick failed validation 5 times");
      expect(requests).toHaveLength(5);
      const resumed = await agents.run(task);
      expect(resumed.value).toBe("Pikachu");
      expect(resumed.attempts).toBe(6);
      expect(requests).toHaveLength(6);
      expect((await agents.run(task)).messageID).toBe(resumed.messageID);
      expect(requests).toHaveLength(6);
    });
  },
  60000,
);

it("registers every session submission tool and rejects calls to the inactive one", async () => {
  const { requests, task, host } = await fixture((_body, index) =>
    index === 1
      ? { tool: "submit_review", input: { summary: "too early" } }
      : { tool: "submit_pick", input: { pick: "Pikachu" } },
  );
  const review = {
    name: "submit_review",
    description: "Submit a review.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  };
  await host(async (agents) => {
    const result = await agents.run({ ...task, submissions: [task.submission, review] });
    expect(result.value).toBe("Pikachu");
    expect(result.attempts).toBe(1);
    expect(result.tools.map((tool) => tool.name)).toEqual(["submit_review", "submit_pick"]);
    expect(result.tools[0]?.result).toContain("not this task's submission tool");
    const offered = z
      .array(z.object({ function: z.object({ name: z.string() }) }))
      .parse(requests[0]?.tools)
      .map((tool) => tool.function.name)
      .sort();
    expect(offered).toEqual(["submit_pick", "submit_review"]);
    expect(JSON.stringify(requests[0])).toContain(
      "Submit each task with the submission tool its instructions name",
    );
    expect(JSON.stringify(requests[1])).toContain("not this task's submission tool");
    await expect(
      agents.run({ ...task, task: "pick-2", prompt: "NEXT", submissions: [review] }),
    ).rejects.toThrow("not one of the session's submission tools");
  });
}, 60000);

it("preserves nullable object submissions through the SDK and rejects string null", async () => {
  const { task, requests, host } = await fixture((_body, index) => ({
    input: { offer: index === 1 ? "null" : null },
  }));
  const schema: JsonObject = {
    type: ["object", "null"],
    properties: { to: { type: "integer" } },
    required: ["to"],
    additionalProperties: false,
  };
  const result = await host((agents) =>
    agents.run({
      ...task,
      submission: {
        name: "submit_offer",
        description: "Submit an offer or pass with null.",
        parameters: {
          type: "object",
          properties: { offer: schema },
          required: ["offer"],
          additionalProperties: false,
        },
      },
      validate: (input) =>
        z.object({ offer: z.object({ to: z.number() }).nullable() }).parse(input),
    }),
  );
  expect(result.value).toEqual({ offer: null });
  expect(result.attempts).toBe(2);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0]?.tools)).toContain(JSON.stringify(schema));
}, 60000);

it("uses upstream retries off-clock and vetoes retries while Showdown's timer is active", async () => {
  const { task, requests, host } = await fixture((_body, index) =>
    index === 2 ? { input: { pick: "Pikachu" } } : { status: 503 },
  );
  await host(async (agents) => {
    expect((await agents.run(task)).value).toBe("Pikachu");
    expect(requests).toHaveLength(2);
    await expect(agents.run({ ...task, task: "timed-pick", timed: true })).rejects.toThrow();
    expect(requests).toHaveLength(3);
  });
}, 60000);

it("recovers Gemini malformed calls through native retries and vetoes them on the clock", async () => {
  const { task, requests, host } = await fixture(
    (_body, index) =>
      index === 2
        ? { input: { pick: "Pikachu" } }
        : { text: "Considering Pikachu", finishReason: "MALFORMED_FUNCTION_CALL" },
    "gemini-fixture",
    "google",
  );
  const progress: AgentProgress[] = [];
  await host(
    async (agents) => {
      const result = await agents.run(task);
      expect(result.value).toBe("Pikachu");
      expect(result.attempts).toBe(1);
      expect(result.reasoning).toContain("Considering Pikachu");
      expect(requests).toHaveLength(2);
      expect(progress.some((event) => event.activity === "retry")).toBe(true);
      await expect(agents.run({ ...task, task: "timed-pick", timed: true })).rejects.toThrow(
        "MALFORMED_FUNCTION_CALL",
      );
      expect(requests).toHaveLength(3);
    },
    (event) => progress.push(event),
  );
}, 60000);

it.each([
  { reason: "MALFORMED_FUNCTION_CALL", attempts: 5 },
  { reason: "MISSING_THOUGHT_SIGNATURE", attempts: 1 },
])(
  "bounds native Gemini retries for $reason",
  async ({ reason, attempts }) => {
    const { task, requests, host } = await fixture(
      () => ({ finishReason: reason }),
      "gemini-fixture",
      "google",
    );
    await expect(host((agents) => agents.run(task))).rejects.toThrow(reason);
    expect(requests).toHaveLength(attempts);
  },
  60000,
);

it("pins OpenRouter without fallback and lowers Claude system cache hints through upstream", async () => {
  vi.stubEnv("VGC_OPENROUTER_PIN", "Anthropic");
  const { task, requests, host } = await fixture(
    () => ({ input: { pick: "Pikachu" } }),
    "anthropic/claude-fixture",
  );
  await host((agents) => agents.run(task));
  expect(requests[0]?.provider).toEqual({ order: ["Anthropic"], allow_fallbacks: false });
  expect(JSON.stringify(requests[0]?.messages)).toContain('"cache_control":{"type":"ephemeral"}');
}, 60000);

it("replays accepted native actions through Showdown after an interruption before simulator submission", async () => {
  const { task, requests, host } = await fixture((body, index) => {
    const prompt = openAiMessages
      .parse(body.messages)
      .findLast((message) => message.role === "user")!.content!;
    if (index === 1)
      return {
        input: { choices: [0, 1, 2, 3], notebook: { series_memory: "Saved preview plan" } },
      };
    if (index === 2) return { input: { choices: [0, 0] } };
    const forfeit = /^\s+(\d+)\. Forfeit/m.exec(prompt);
    if (!forfeit) throw new Error("No concession menu");
    return { input: { choices: [Number(forfeit[1]), 0] } };
  });
  const pool = loadPool();
  const players = {
    p1: { name: "Pilot", team: pool.teams[0]!.packed },
    p2: { name: "Random", team: pool.teams[1]!.packed },
  };
  const seed: [number, number, number, number] = [11, 22, 33, 44];
  const simulator = () => new SimBattle(pool.format, players, seed, undefined, "off");
  const decisions: JsonObject[] = [];
  const traces: JsonObject[] = [];
  await host(async (agents) => {
    let interrupt = true;
    const engines = () => {
      const result = {
        p1: new LLMEngine("p1", task.model, {
          format: pool.format,
          decisionLog: decisions,
          traceLog: traces,
          runAgent: async (input) => {
            const result = await agents.run(input);
            if (interrupt && input.task === "decision-2")
              throw new Error("crash before simulator submission");
            return result;
          },
        }),
        p2: new RandomEngine("p2", 41),
      };
      for (const engine of Object.values(result))
        engine.beginGame({ gameId: "recovery", gameNumber: 2, seriesId: "series" });
      return result;
    };
    await expect(simulator().run(engines())).rejects.toThrow("crash before simulator submission");
    const original = traces[0]!;
    expect(requests).toHaveLength(2);
    interrupt = false;
    decisions.length = 0;
    const outcome = await simulator().run(engines());
    expect(requests).toHaveLength(3);
    expect(outcome.winner).toBe("Random");
    expect(decisions.every((row) => row.outcome === "accepted")).toBe(true);
    expect(decisions.at(-1)?.action).toBe("forfeit");
    expect(decisions[0]?.latency_ms).toBe(Math.round(Number(original.latency_ms)));
    expect(traces[1]?.latency_ms).toBe(original.latency_ms);
    expect(traces[1]?.recovery_ms).toBeGreaterThan(0);
    expect(traces[1]?.message_id).toBe(original.message_id);
    const replayed = await simulator().run(engines());
    expect(replayed.log.filter((line) => !line.startsWith("|t:|"))).toEqual(
      outcome.log.filter((line) => !line.startsWith("|t:|")),
    );
    expect(requests).toHaveLength(3);
  });
}, 60000);

it("prompts a model that replied without submitting once more, then accepts its submission", async () => {
  const { task, requests, host } = await fixture((_body, index) =>
    index === 1 ? { text: "I would pick Pikachu." } : { input: { pick: "Pikachu" } },
  );
  const result = await host((agents) => agents.run(task));
  expect(result.value).toBe("Pikachu");
  expect(result.attempts).toBe(1);
  expect(requests).toHaveLength(2);
  expect(
    openAiMessages
      .parse(requests[1]?.messages)
      .some((message) => message.content === "I would pick Pikachu."),
  ).toBe(true);
}, 60000);

it("only advances past an unfinished task when the simulator explicitly supersedes it", async () => {
  const { task, requests, host } = await fixture((_body, index) =>
    index <= 3 ? { text: "No submission yet" } : { input: { pick: "Pikachu" } },
  );
  await host(async (agents) => {
    await expect(agents.run(task)).rejects.toThrow("No accepted");
    expect(requests).toHaveLength(3);
    await expect(agents.run({ ...task, task: "pick-2" })).rejects.toThrow("incomplete");
    expect(
      (
        await agents.run({
          ...task,
          task: "pick-2",
          supersedes: "pick-1",
          prompt: "The simulator timed out the prior action. Choose for the new turn.",
        })
      ).value,
    ).toBe("Pikachu");
    await expect(agents.run(task)).rejects.toThrow("earlier incomplete");
  });
}, 60000);

it("cancels inference and refuses changed or later tasks until the interrupted input resumes", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cleanup.push(() => release.resolve());
  const { task, requests, host } = await fixture(async (_body, index) => {
    if (index === 1) {
      started.resolve();
      await release.promise;
    }
    return { input: { pick: "Pikachu" } };
  });
  await host(async (agents) => {
    const controller = new AbortController();
    const pending = agents.run({ ...task, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    controller.abort(new Error("clock expired"));
    await rejected;
    await expect(agents.run({ ...task, task: "pick-2" })).rejects.toThrow("incomplete");
    await expect(agents.run({ ...task, prompt: "Different battle" })).rejects.toThrow(
      "input changed",
    );
    expect(requests).toHaveLength(1);
    release.resolve();
    expect((await agents.run(task)).value).toBe("Pikachu");
    expect(requests).toHaveLength(2);
  });
}, 60000);

it("lets OpenCode compact a full conversation and preserves accepted submissions for recovery", async () => {
  const sentinels = [
    "PLAYBOOK_SENTINEL_71a",
    "SERIES_MEMORY_SENTINEL_2c9",
    "NEXT_GAME_PLAN_SENTINEL_4b3",
    "REVEALED_SET_SENTINEL_9e0",
    "UNCERTAINTY_SENTINEL_5d8",
    "SUBMITTED_NOT_ACCEPTED_SENTINEL_1a6",
  ];
  const compactions: string[][] = [];
  const progress: AgentProgress[] = [];
  const { task, requests, host } = await fixture((body, index) => {
    if (progress.at(-1)?.activity === "compacting") {
      const seen = sentinels.filter((sentinel) => JSON.stringify(body).includes(sentinel));
      compactions.push(seen);
      return {
        text: `## Objective\n- COMPACTED_PRIVATE_PLAN\n\n## Important Context\n${seen.map((sentinel) => `- ${sentinel}`).join("\n")}`,
      };
    }
    return { input: { pick: "Pikachu" }, tokens: index === 1 ? 125000 : 40 };
  });
  const prompt = [
    "Notebook team_playbook: PLAYBOOK_SENTINEL_71a",
    "Notebook series_memory: SERIES_MEMORY_SENTINEL_2c9",
    "Notebook next_game_plan: NEXT_GAME_PLAN_SENTINEL_4b3",
    "Revealed (game 1 turn 2): opponent Incineroar carries REVEALED_SET_SENTINEL_9e0",
    "Hypothesis, unconfirmed: UNCERTAINTY_SENTINEL_5d8",
    "Submitted last turn but rejected by the simulator: SUBMITTED_NOT_ACCEPTED_SENTINEL_1a6",
  ].join("\n");
  await host(
    async (agents) => {
      const first = await agents.run({ ...task, prompt });
      const second = await agents.run({ ...task, task: "pick-2", prompt: "Continue the plan" });
      expect(second.sessionID).toBe(first.sessionID);
      expect(compactions).toEqual([sentinels]);
      expect(requests).toHaveLength(3);
      const resumed = JSON.stringify(requests[2]);
      expect(resumed).toContain("COMPACTED_PRIVATE_PLAN");
      for (const sentinel of sentinels) expect(resumed).toContain(sentinel);
      const recovered = await agents.run({ ...task, prompt });
      expect(recovered.value).toBe("Pikachu");
      expect(recovered.messageID).toBe(first.messageID);
      expect(requests).toHaveLength(3);
    },
    (event) => progress.push(event),
  );
}, 60000);

it("admits suspended native sessions only after checking the resumed league task", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { runDir, task, requests, host } = await fixture(async (_body, index) => {
    if (index === 1) {
      started.resolve();
      await release.promise;
      return { text: "Interrupted request" };
    }
    return { input: { pick: "Pikachu" } };
  });
  const { OpenCode } = await import("@opencode/sdk");
  const { Plugin } = await import("@opencode/plugin");
  const directory = path.join(runDir, "agents", task.session);
  const suspended = await OpenCode.create({
    database: { path: path.join(runDir, "agents", "opencode.sqlite") },
    config: {
      directory: path.dirname(directory),
      project: false,
      content: '{"snapshots":false,"warming":false}',
    },
    fs: { filewatcher: false, fff: false },
    plugins: [
      Plugin.define({
        id: "league",
        async setup(ctx) {
          await ctx.agent.transform((editor) =>
            editor.update("league", (agent) => {
              agent.system = task.system;
            }),
          );
        },
      }),
    ],
    log: { level: "error", emit: () => {} },
  });
  cleanup.push(async () => {
    release.resolve();
    await suspended.close();
  });
  const session = await suspended.sessions.create({
    location: { directory },
    agent: "league",
    title: task.session,
    model: { providerID: "openrouter", id: "test" },
    metadata: {
      leagueSession: task.session,
      model: task.model,
      reasoning: null,
      routing: { allow_fallbacks: false },
    },
  });
  await suspended.sessions.prompt({
    sessionID: session.id,
    text: task.prompt,
    metadata: { task: task.task, system: task.system },
  });
  await started.promise;
  await suspended.close();
  release.resolve();
  await host(async (agents) => {
    await expect(agents.run({ ...task, prompt: "Changed during suspension" })).rejects.toThrow(
      "input changed",
    );
    expect(requests).toHaveLength(1);
    expect((await agents.run(task)).value).toBe("Pikachu");
    expect(requests).toHaveLength(2);
  });
}, 60000);
