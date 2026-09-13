import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode/client";
import type { OpenCode, OpenCodeEvent } from "@opencode/sdk";
import { z } from "zod";

import "./opencode-loader.js";
import { LiveRun } from "./live-run.js";
import {
  modelUpstreamRoutes,
  parseSpec,
  openRouterRouting,
  type OpenRouterRouting,
  type ReasoningLevel,
} from "./providers.js";
import type { AgentActivity, AgentProgress, LiveGame } from "./public/live-protocol.js";
import type { JsonObject, ToolDefinition } from "./types.js";

export interface AgentTool {
  definition: ToolDefinition;
  run: (input: JsonObject) => string;
}

export interface AgentTask<T> {
  session: string;
  task: string;
  supersedes?: string;
  model: string;
  reasoning?: ReasoningLevel;
  system: string;
  prompt: string;
  tools?: AgentTool[];
  submission: ToolDefinition;
  /** Every submission tool the session registers; the active one replaces its namesake so the tool surface, and with it the provider cache prefix, stays identical across the session's tasks. */
  submissions?: ToolDefinition[];
  validate: (input: JsonObject) => T;
  signal?: AbortSignal;
  timed?: boolean;
}

export interface AgentResult<T> {
  value: T;
  sessionID: string;
  messageID: string;
  response: string;
  reasoning: string;
  usage: Record<string, number>;
  tools: Array<{ name: string; arguments: JsonObject; result: string }>;
  attempts: number;
  latencyMs: number;
  recoveryMs?: number;
}

export type AgentRunner = <T>(task: AgentTask<T>) => Promise<AgentResult<T>>;

export interface LiveProjection {
  game: (game: LiveGame) => void;
  invalidate: () => void;
}

export interface AgentRuntime {
  run: AgentRunner;
  live: LiveProjection;
}

export type { AgentProgress } from "./public/live-protocol.js";

type Host = OpenCode.Interface;
type Message = SessionMessageInfo;
type UserMessage = Extract<Message, { type: "user" }>;

const object = z.record(z.string(), z.json());
const SUBMISSION_REMINDERS = 2;
const REFERENCE_CALL_BUDGET = 400;
const CATALOG_INTRO = `Code Mode catalog: these are all the tools callable inside \`execute\` through \`tools\`, with their exact signatures. Run independent calls concurrently with \`Promise.all\` and return every result you need to read. A call the harness rejects returns its error message as its result instead of throwing, so the rest of the batch still completes. A task may make at most ${REFERENCE_CALL_BUDGET} reference calls in total; a loop over a whole board or roster spends that budget on rows you will never read.`;
const SUBMISSION_FAILURES = 5;
/** Anthropic refusal stops are stochastic on identical input; OpenCode reports them as a normal stop. */
const CONTENT_FILTER_RETRIES = 3;

const COMPACTION_SYSTEM = `When asked for a conversation checkpoint, follow these summary instructions only for that checkpoint:
Summarize this private Pokémon coaching conversation for continued play. Use the requested summary headings, including ## Objective.
Preserve the latest team_playbook, series_memory, and next_game_plan notebook fields verbatim, with their opponent and game scope. Preserve roster and registered sets, bring and lead choices, series score, current game and turn, remaining resources, and the current win condition.
Record revealed opponent moves, items, abilities, forms, speed-order evidence, and damage evidence with their source game/turn. Separate observations from hypotheses; preserve uncertainty and never invent hidden sets. Keep relevant opponent tendencies and rejected hypotheses.
Distinguish accepted submissions, simulator rejections, abandoned decisions, and proposed actions. Retain unresolved validation errors and the pending task. A tool submission is not proof the simulator accepted the action.
Preserve decisions and reasons that affect the next turn or game. Drop repeated dex output, superseded plans, and narration. Current observations override stale battle state. This is a checkpoint, not a new decision; do not call tools.`;

const ACTIVITIES = {
  "session.step.started": "generating",
  "session.step.ended": "generating",
  "session.step.failed": "generating",
  "session.reasoning.started": "reasoning",
  "session.reasoning.ended": "generating",
  "session.tool.input.started": "tool",
  "session.tool.success": "generating",
  "session.tool.failed": "generating",
  "session.retry.scheduled": "retry",
  "session.compaction.started": "compacting",
  "session.compaction.ended": "generating",
} satisfies Partial<Record<OpenCodeEvent["type"], AgentActivity>>;

function hasActivity(type: OpenCodeEvent["type"]): type is keyof typeof ACTIVITIES {
  return Object.hasOwn(ACTIVITIES, type);
}

/**
 * One task's handshake with the plugin hooks running inside OpenCode: `admitted` releases tools and
 * generation once the session history is verified; `finished` tells the runner a submission was
 * accepted or the task failed; `stopped` holds the context hook until the runner has interrupted the
 * session, so the accepted tool result is durable before generation is refused.
 */
class ActiveTask {
  submitted = false;
  attempts = 0;
  readonly calls: AgentResult<unknown>["tools"] = [];
  failure?: Error;
  activity: AgentActivity = "starting";
  tool?: string;
  usage?: AgentProgress["usage"];
  readonly admitted = Promise.withResolvers<void>();
  readonly finished = Promise.withResolvers<void>();
  readonly stopped = Promise.withResolvers<void>();
  readonly routing: OpenRouterRouting | undefined;
  readonly system: string;
  readonly submissions: ToolDefinition[];
  readonly toolNames: string[];

  constructor(
    readonly task: AgentTask<unknown>,
    catalog: string,
  ) {
    this.routing =
      parseSpec(task.model).provider === "openrouter" ? openRouterRouting() : undefined;
    this.submissions = sessionSubmissions(task);
    this.system = [
      task.system,
      `${this.submissions.length === 1 ? `Submit using ${task.submission.name}.` : "Submit each task with the submission tool its instructions name."} Rejected submissions return validation errors; correct them and submit again.`,
      catalog,
      COMPACTION_SYSTEM,
    ]
      .filter(Boolean)
      .join("\n\n");
    this.toolNames = [
      ...(task.tools?.length ? ["execute"] : []),
      ...(task.tools ?? []).map((tool) => tool.definition.name),
      ...this.submissions.map((tool) => tool.name),
    ];
  }

  progress(activity = this.activity): AgentProgress {
    this.activity = activity;
    if (activity !== "tool") this.tool = undefined;
    const progress: AgentProgress = {
      session: this.task.session,
      task: this.task.task,
      model: this.task.model,
      activity,
    };
    if (this.tool !== undefined) progress.tool = this.tool;
    if (this.usage !== undefined) progress.usage = this.usage;
    return progress;
  }
}

class AgentSlot {
  active?: ActiveTask;
  ready = Promise.withResolvers<ActiveTask>();
  reload?: () => Promise<void>;

  begin(task: AgentTask<unknown>, catalog: string): ActiveTask {
    if (this.active) throw new Error(`Agent session already has an active task: ${task.session}`);
    const active = new ActiveTask(task, catalog);
    this.active = active;
    this.ready.resolve(active);
    return active;
  }

  end(): void {
    this.active?.stopped.resolve();
    this.active = undefined;
    this.ready = Promise.withResolvers<ActiveTask>();
  }
}

class AgentHost {
  readonly live: LiveRun;
  private host?: Promise<Host>;
  private readonly slots = new Map<string, AgentSlot>();
  private readonly sessions = new Map<string, string>();
  private readonly eventsController = new AbortController();
  private events?: Promise<void>;

  constructor(
    readonly runDir: string,
    private readonly onProgress?: (progress: AgentProgress) => void,
  ) {
    this.live = new LiveRun(runDir);
  }

  track(sessionID: string, session: string): void {
    this.sessions.set(sessionID, session);
  }

  slot(name: string): AgentSlot {
    let slot = this.slots.get(name);
    if (!slot) {
      slot = new AgentSlot();
      this.slots.set(name, slot);
    }
    return slot;
  }

  open(): Promise<Host> {
    this.host ??= this.create();
    return this.host;
  }

  private async create(): Promise<Host> {
    /** The resolver must be registered before loading the SDK's extensionless imports. */
    const { OpenCode: SDK } = await import("@opencode/sdk");
    const directory = path.resolve(this.runDir, "agents");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const host = await SDK.create({
      app: { name: "vgcleague" },
      database: { path: path.join(directory, "opencode.sqlite") },
      models: { snapshot: false },
      config: {
        directory,
        project: false,
        content: JSON.stringify({
          snapshots: false,
          warming: false,
          plugins: [],
          compaction: { keep: { tokens: 12000 }, buffer: 24000 },
        }),
      },
      fs: { filewatcher: false, fff: false },
      instances: {
        key: (session) => z.string().parse(session.metadata?.leagueSession),
        configure: async (name) => {
          const slot = this.slot(name);
          await slot.ready.promise;
          return { plugins: [await leaguePlugin(slot)] };
        },
      },
      log: { level: "error", emit: () => {} },
    });
    this.events = this.follow(host);
    return host;
  }

  private async follow(host: Host): Promise<void> {
    try {
      for await (const event of host.events.subscribe({ signal: this.eventsController.signal })) {
        this.progress(event);
      }
    } catch {
      if (!this.eventsController.signal.aborted) console.error("Agent progress stream stopped");
    }
  }

  private progress(event: OpenCodeEvent): void {
    if (!("sessionID" in event.data)) return;
    const sessionID = z.string().safeParse(event.data.sessionID);
    if (!sessionID.success) return;
    const session = this.sessions.get(sessionID.data);
    const active = session ? this.slots.get(session)?.active : undefined;
    if (!active) return;
    if (event.type === "session.usage.updated") {
      const { tokens } = event.data;
      active.usage = {
        cost: event.data.cost,
        inputTokens: tokens.input + tokens.cache.read + tokens.cache.write,
        outputTokens: tokens.output + tokens.reasoning,
      };
      this.emit(active.progress());
      return;
    }
    if (!hasActivity(event.type)) return;
    const activity = ACTIVITIES[event.type];
    if (event.type === "session.tool.input.started") active.tool = event.data.name;
    this.emit(active.progress(activity));
  }

  emit(progress: AgentProgress): void {
    this.live.agent(progress);
    this.onProgress?.(progress);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.eventsController.abort();
    try {
      if (this.host) await (await this.host).close();
    } finally {
      await this.events;
      this.live.flush();
    }
  }
}

export async function withAgentHost<T>(
  runDir: string,
  run: (agents: AgentRuntime) => Promise<T>,
  onProgress?: (progress: AgentProgress) => void,
): Promise<T> {
  await using host = new AgentHost(path.resolve(runDir), onProgress);
  return await run({ run: (task) => executeTask(task, host), live: host.live });
}

function isUserTask(message: Message, task: string): message is UserMessage {
  return message.type === "user" && message.metadata?.task === task;
}

function taskMessages(messages: readonly Message[], task: string): Message[] {
  const start = messages.findIndex((message) => isUserTask(message, task));
  if (start < 0) return [];
  const end = messages.findIndex(
    (message, index) =>
      index > start && message.type === "user" && message.metadata?.task !== undefined,
  );
  return messages.slice(start, end < 0 ? undefined : end);
}

function taskAccepted(messages: readonly Message[], task: string): boolean {
  return taskMessages(messages, task).some(
    (message) =>
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          part.state.metadata?.accepted === true,
      ),
  );
}

function acceptedResult<T>(
  task: AgentTask<T>,
  sessionID: string,
  messages: readonly Message[],
  submitted?: { value: T },
): AgentResult<T> | undefined {
  const usage: Record<string, number> = {};
  const reasoning: string[] = [];
  const tools: AgentResult<T>["tools"] = [];
  let accepted: { value: T; messageID: string; response: string; latencyMs: number } | undefined;
  let attempts = 0;
  const history = taskMessages(messages, task.task);
  for (const message of history) {
    if (message.type !== "assistant" && message.type !== "compaction") continue;
    if ("tokens" in message && message.tokens) {
      const tokens = message.tokens;
      for (const [key, value] of Object.entries({
        input_tokens: tokens.input + tokens.cache.read + tokens.cache.write,
        output_tokens: tokens.output + tokens.reasoning,
        reasoning_tokens: tokens.reasoning,
        cached_input_tokens: tokens.cache.read,
        cost: message.cost ?? 0,
      }))
        usage[key] = (usage[key] ?? 0) + value;
    }
    if (message.type !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "reasoning") reasoning.push(part.text);
      if (
        part.type !== "tool" ||
        part.state.status === "streaming" ||
        part.state.status === "running"
      )
        continue;
      const input = object.parse(part.state.input);
      const content =
        part.state.status === "error"
          ? part.state.error.message
          : (part.state.content ?? [])
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n");
      tools.push({ name: part.name, arguments: input, result: content });
      if (part.name !== task.submission.name) continue;
      attempts += 1;
      if (
        part.state.status === "completed" &&
        part.state.metadata?.accepted === true &&
        !accepted
      ) {
        accepted = {
          value: submitted ? submitted.value : task.validate(input),
          messageID: message.id,
          response: JSON.stringify(input),
          latencyMs: z.number().parse(part.time.completed) - history[0]!.time.created,
        };
      }
    }
    if (accepted) break;
  }
  return accepted
    ? { ...accepted, sessionID, reasoning: reasoning.join("\n\n"), usage, tools, attempts }
    : undefined;
}

type TaskPlan<T> = { kind: "recovered"; result: AgentResult<T> } | { kind: "resume" | "fresh" };

/** Decides from the durable session what this task needs; throws when the history contradicts it. */
function planTask<T>(
  task: AgentTask<T>,
  prompt: string,
  sessionID: string,
  messages: readonly Message[],
  inbox: readonly SessionInboxInfo[],
): TaskPlan<T> {
  const prior = messages.find((message) => isUserTask(message, task.task));
  const pending = inbox.find((item) => item.type === "user");
  if (
    pending?.type === "user" &&
    (pending.payload.metadata?.task !== task.task ||
      pending.payload.text !== prompt ||
      pending.payload.metadata?.system !== task.system)
  )
    throw new Error(`Pending agent task input changed: ${task.task}`);
  if (prior && (prior.text !== prompt || prior.metadata?.system !== task.system))
    throw new Error(`Agent task input changed: ${task.task}`);
  const recovered = acceptedResult(task, sessionID, messages);
  if (recovered) return { kind: "recovered", result: recovered };
  const latest = messages.findLast(
    (message) => message.type === "user" && message.metadata?.task !== undefined,
  );
  const latestTask = latest ? z.string().parse(latest.metadata?.task) : undefined;
  if (
    latestTask !== undefined &&
    latest!.id !== prior?.id &&
    latestTask !== task.supersedes &&
    !taskAccepted(messages, latestTask)
  )
    throw new Error(`Previous agent task is incomplete: ${latestTask}`);
  if (prior && latest?.id !== prior.id)
    throw new Error(`Cannot resume an earlier incomplete task: ${task.task}`);
  return { kind: prior || pending ? "resume" : "fresh" };
}

/** Rendered with the runtime's own signature generator; OpenCode's inline listing truncates descriptions. */
function sessionSubmissions(task: AgentTask<unknown>): ToolDefinition[] {
  const declared = task.submissions ?? [task.submission];
  if (!declared.some((tool) => tool.name === task.submission.name))
    throw new Error(`${task.submission.name} is not one of the session's submission tools`);
  return declared.map((tool) => (tool.name === task.submission.name ? task.submission : tool));
}

async function codeModeCatalog(tools: readonly AgentTool[]): Promise<string> {
  if (tools.length === 0) return "";
  const { CodeMode, Tool } = await import("@opencode/codemode");
  const runtime = CodeMode.make({
    tools: Object.fromEntries(
      tools.map((tool) => [
        tool.definition.name,
        // SAFETY: runtime.catalog only renders signatures and never invokes execute.
        Tool.make({
          description: tool.definition.description,
          input: tool.definition.parameters,
          output: { type: ["string", "null"] },
          execute: (() => {
            throw new Error("catalog only");
          }) as never,
        }),
      ]),
    ),
  });
  return [
    CATALOG_INTRO,
    ...runtime.catalog.map((entry) => `${entry.description}\n${entry.signature}`),
  ].join("\n\n");
}

async function leaguePlugin(slot: AgentSlot) {
  /** The resolver must be registered before loading the SDK's extensionless imports. */
  const { Plugin } = await import("@opencode/plugin");
  const initial = await slot.ready.promise;
  const spec = parseSpec(initial.task.model);
  const routing = initial.routing;
  return Plugin.define({
    id: "league",
    async setup(ctx) {
      const routes = modelUpstreamRoutes();
      if (routes.size)
        await ctx.catalog.transform((editor) => {
          for (const [from, upstream] of routes) {
            const route = parseSpec(from);
            const target = editor.model.get(route.provider, upstream);
            if (!target)
              throw new Error(
                `VGC_MODEL_UPSTREAM target ${route.provider}:${upstream} is not in the catalog`,
              );
            editor.model.update(route.provider, route.model, (model) => {
              model.modelID = target.modelID;
              model.cost = target.cost;
            });
          }
        });
      let validated = false;
      let cacheSystem = false;
      await ctx.agent.transform((editor) => {
        const active = slot.active ?? initial;
        for (const agent of editor.list())
          if (String(agent.id) !== "compaction") editor.remove(String(agent.id));
        editor.update("league", (agent) => {
          agent.system = active.system;
          agent.permissions = [
            { action: "*", resource: "*", effect: "deny" },
            ...active.toolNames.map((action) => ({
              action,
              resource: "*",
              effect: "allow" as const,
            })),
          ];
        });
        editor.default("league");
      });
      await ctx.tool.transform((editor) => {
        const active = slot.active ?? initial;
        const { task, admitted } = active;
        const record = (name: string, args: JsonObject, run: () => string): string => {
          try {
            const result = run();
            active.calls.push({ name, arguments: args, result });
            return result;
          } catch (error) {
            const result = error instanceof Error ? error.message : String(error);
            active.calls.push({ name, arguments: args, result });
            throw error;
          }
        };
        for (const tool of editor.list()) editor.remove(tool.id);
        for (const tool of task.tools ?? [])
          editor.add({
            name: tool.definition.name,
            description: tool.definition.description,
            input: tool.definition.parameters,
            execute: async (input) => {
              await admitted.promise;
              task.signal?.throwIfAborted();
              const args = object.parse(input);
              if (active.calls.length >= REFERENCE_CALL_BUDGET) {
                const content = `Error: this task's budget of ${REFERENCE_CALL_BUDGET} reference calls is spent; decide from the results you already have.`;
                if (active.calls.length === REFERENCE_CALL_BUDGET)
                  active.calls.push({ name: tool.definition.name, arguments: args, result: content });
                return { content };
              }
              let content: string;
              try {
                content = record(tool.definition.name, args, () => {
                  if (active.submitted)
                    throw new Error("This task already has an accepted submission.");
                  return tool.run(args);
                });
              } catch (error) {
                content = `Error: ${error instanceof Error ? error.message : String(error)}`;
              }
              return { content };
            },
          });
        for (const submission of active.submissions)
          editor.add({
            name: submission.name,
            description: submission.description,
            input: submission.parameters,
            options: { codemode: false },
            execute: async (input) => {
              await admitted.promise;
              task.signal?.throwIfAborted();
              const args = object.parse(input);
              if (submission.name !== task.submission.name)
                return {
                  content: record(
                    submission.name,
                    args,
                    () =>
                      `Error: ${submission.name} is not this task's submission tool; submit with ${task.submission.name}.`,
                  ),
                };
              if (active.submitted)
                return {
                  content: record(
                    submission.name,
                    args,
                    () => "This task already has an accepted submission. End your reply.",
                  ),
                };
              const content = record(submission.name, args, () => {
                task.validate(args);
                return "Submission accepted. End your reply; await the next observation.";
              });
              active.submitted = true;
              return { content, metadata: { accepted: true } };
            },
          });
      });
      await ctx.session.hook("context", async (event) => {
        const active = await slot.ready.promise;
        const { task } = active;
        await active.admitted.promise;
        task.signal?.throwIfAborted();
        if (!validated) {
          const models = await ctx.catalog.model.list();
          const model = models.data.find(
            (model) => model.providerID === spec.provider && model.id === spec.model,
          );
          if (!model?.capabilities.tools)
            throw new Error(`OpenCode has no available tool-capable model ${task.model}`);
          if (task.reasoning && !model.variants.some((variant) => variant.id === task.reasoning))
            throw new Error(`${task.model} does not offer variant ${task.reasoning}`);
          cacheSystem = model.modelID.includes("claude");
          validated = true;
        }
        if (!active.submitted && active.attempts >= SUBMISSION_FAILURES)
          active.failure = new Error(
            `${task.submission.name} failed validation ${active.attempts} times`,
          );
        if (active.submitted || active.failure) {
          active.finished.resolve();
          await active.stopped.promise;
          throw active.failure ?? new Error("Submission accepted");
        }
        if (routing) event.options.provider = routing;
        event.system = [
          cacheSystem
            ? { type: "text", text: active.system, cache: { type: "ephemeral" } }
            : { type: "text", text: active.system },
        ];
      });
      await ctx.tool.hook("execute.before", (event) => {
        const active = slot.active;
        if (active && event.tool === active.task.submission.name) active.attempts += 1;
      });
      await ctx.session.hook("http.request", async () => {
        const active = await slot.ready.promise;
        await active.admitted.promise;
        active.task.signal?.throwIfAborted();
      });
      await ctx.session.hook("retry", (event) => {
        if (slot.active?.submitted || slot.active?.task.timed || slot.active?.task.signal?.aborted)
          event.decision = { retry: false };
        else if (
          event.error.type === "provider.invalid-output" &&
          event.error.message === "Gemini stopped with MALFORMED_FUNCTION_CALL"
        )
          event.decision = { retry: true, delay: 0 };
      });
      slot.reload = async () => {
        await ctx.agent.reload();
        await ctx.tool.reload();
      };
    },
  });
}

async function executeTask<T>(task: AgentTask<T>, owner: AgentHost): Promise<AgentResult<T>> {
  const started = performance.now();
  task.signal?.throwIfAborted();
  const directory = path.resolve(owner.runDir, "agents", encodeURIComponent(task.session));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const spec = parseSpec(task.model);
  const slot = owner.slot(task.session);
  const catalog = await codeModeCatalog(task.tools ?? []);
  let submitted: { value: T } | undefined;
  const active = slot.begin(
    {
      ...task,
      validate(input) {
        const value = task.validate(input);
        submitted = { value };
        return value;
      },
    },
    catalog,
  );
  owner.emit(active.progress());
  const { admitted, finished } = active;
  let host: Host | undefined;
  let sessionID: string | undefined;
  try {
    host = await owner.open();
    const location = { directory };
    await host.plugin.awaitActivation({ location });
    const sessions = await host.sessions.list({ directory });
    const session =
      sessions.data[0] ??
      (await host.sessions.create({
        location,
        title: task.session,
        agent: "league",
        model: { providerID: spec.provider, id: spec.model, variant: task.reasoning },
        metadata: {
          leagueSession: task.session,
          model: task.model,
          reasoning: task.reasoning ?? null,
          routing: active.routing ?? null,
        },
      }));
    sessionID = session.id;
    owner.track(session.id, task.session);
    if (
      session.metadata?.model !== task.model ||
      session.metadata?.reasoning !== (task.reasoning ?? null) ||
      !isDeepStrictEqual(session.metadata?.routing, active.routing ?? null)
    )
      throw new Error(`Agent session configuration changed: ${task.session}`);
    await host.sessions.interrupt({ sessionID: session.id, continue: false });
    await slot.reload?.();
    const plan = planTask(
      task,
      task.prompt,
      session.id,
      (await host.sessions.export({ sessionID: session.id })).messages,
      await host.sessions.inbox.list({ sessionID: session.id }),
    );
    if (plan.kind === "recovered")
      return { ...plan.result, recoveryMs: performance.now() - started };
    task.signal?.throwIfAborted();
    admitted.resolve();
    if (plan.kind === "resume")
      await host.sessions.synthetic({
        sessionID: session.id,
        text: "Continue the pending task and submit it using its submission tool.",
        resume: true,
      });
    else
      await host.sessions.prompt({
        sessionID: session.id,
        text: task.prompt,
        metadata: { task: task.task, system: task.system },
        resume: true,
      });
    let filtered = 0;
    for (let reminders = 0; ; reminders += 1) {
      try {
        await Promise.race([
          host.sessions.wait({ sessionID: session.id }, { signal: task.signal }),
          finished.promise,
        ]);
      } finally {
        await host.sessions.interrupt({ sessionID: session.id, continue: false });
      }
      task.signal?.throwIfAborted();
      if (active.failure) throw active.failure;
      const completed = await host.sessions.export({ sessionID: session.id });
      const accepted = acceptedResult(task, session.id, completed.messages, submitted);
      if (accepted) return active.calls.length ? { ...accepted, tools: [...active.calls] } : accepted;
      const last = taskMessages(completed.messages, task.task).findLast(
        (message) => message.type === "assistant",
      );
      if (last && "error" in last && last.error) {
        if (last.error.type !== "provider.content-filter" || filtered >= CONTENT_FILTER_RETRIES)
          throw new Error(last.error.message);
        filtered += 1;
        reminders -= 1;
        await host.sessions.synthetic({
          sessionID: session.id,
          text: "Continue the pending task and submit it using its submission tool.",
          resume: true,
        });
        continue;
      }
      if (reminders >= SUBMISSION_REMINDERS)
        throw new Error(
          `No accepted ${task.submission.name} submission after ${reminders} reminders`,
        );
      await host.sessions.synthetic({
        sessionID: session.id,
        text: `No ${task.submission.name} submission was accepted. A text reply is not a submission: call ${task.submission.name} now, correcting any validation error it returned.`,
        resume: true,
      });
    }
  } finally {
    try {
      if (host && sessionID) await host.sessions.interrupt({ sessionID, continue: false });
    } finally {
      slot.end();
      owner.emit(active.progress("ended"));
    }
  }
}
