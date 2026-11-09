import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool as ModelTool,
  type AgentTurnDecision,
} from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  getSupportedThinkingLevels,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type TextContent,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  CodemodeSandbox,
  renderDeclarations,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { z } from "zod";

import { LiveRun } from "./live-run.js";
import {
  modelUpstreamRoutes,
  openRouterRouting,
  parseSpec,
  type OpenRouterRouting,
  type ReasoningLevel,
} from "./providers.js";
import type { AgentActivity, AgentProgress, LiveGame } from "./public/live-protocol.js";
import { rejectUndeclared, withoutClosedObjects } from "./tool-input.js";
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
  tools: ToolCallRecord[];
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

type ToolCallRecord = { name: string; arguments: JsonObject; result: string };

const object = z.record(z.string(), z.json());
const SUBMISSION_REMINDERS = 2;
const SUBMISSION_FAILURES = 5;
const MODEL_RETRIES = 4;
const RETRY_BASE_MS = 1000;
const REFERENCE_CALL_BUDGET = 400;
const COMPACTION_RESERVE_TOKENS = 24000;
const COMPACTION_KEEP_TOKENS = 12000;
const PROMPT_SECTION = "league";
const SUBMISSION_ACCEPTED = "Submission accepted. End your reply; await the next observation.";
const CONTINUE = "Continue the pending task and submit it using its submission tool.";
const CHECKPOINT = "Earlier conversation, compacted into this checkpoint:";
const CATALOG_INTRO = `Code Mode catalog: these are all the tools callable inside \`execute\` through \`tools\`, with their exact signatures. Run independent calls concurrently with \`Promise.all\` and return every result you need to read. A call the harness rejects returns its error message as its result instead of throwing, so the rest of the batch still completes. A task may make at most ${REFERENCE_CALL_BUDGET} reference calls in total; the call that exceeds it throws and ends the program, so a loop over a whole board or roster wastes the budget on rows you will never read.`;
const EXECUTE_DESCRIPTION =
  "Run a JavaScript async function body that calls the Code Mode catalog as `await tools.<name>(args)`. Print with `text(value)` or return a value; only the printed output and the return value come back.";
const COMPACTION_PROMPT = `Write a checkpoint of this private Pokémon coaching conversation so play can continue from it alone. Use the headings ## Objective, ## Important Context, and ## Pending Task.
Preserve the latest team_playbook, series_memory, and next_game_plan notebook fields verbatim, with their opponent and game scope. Preserve roster and registered sets, bring and lead choices, series score, current game and turn, remaining resources, and the current win condition.
Record revealed opponent moves, items, abilities, forms, speed-order evidence, and damage evidence with their source game/turn. Separate observations from hypotheses; preserve uncertainty and never invent hidden sets. Keep relevant opponent tendencies and rejected hypotheses.
Distinguish accepted submissions, simulator rejections, abandoned decisions, and proposed actions. Retain unresolved validation errors and the pending task. A tool submission is not proof the simulator accepted the action.
Preserve decisions and reasons that affect the next turn or game. Drop repeated dex output, superseded plans, and narration. Current observations override stale battle state. This is a checkpoint, not a new decision; do not call tools.`;
/** Gemini's malformed function calls and Anthropic's refusals are stochastic on identical input, so they are resampled. */
const RESAMPLED_STOPS = new Set(["MALFORMED_FUNCTION_CALL", "refusal"]);

const routingSchema = z.object({
  order: z.array(z.string()).optional(),
  allow_fallbacks: z.boolean(),
});
const headerSchema = z.object({
  kind: z.literal("session"),
  id: z.string(),
  model: z.string(),
  reasoning: z.string().nullable(),
  routing: routingSchema.nullable(),
});
const taskEntrySchema = z.object({
  kind: z.literal("task"),
  task: z.string(),
  prompt: z.string(),
  system: z.string(),
  at: z.number(),
});
const compactionEntrySchema = z.object({
  kind: z.literal("compaction"),
  summary: z.string(),
  kept: z.number().int().nonnegative(),
  usage: z.record(z.string(), z.number()),
  at: z.number(),
});
const messageEntrySchema = z.object({
  kind: z.literal("message"),
  id: z.string(),
  message: z.looseObject({ role: z.enum(["system", "user", "assistant", "toolResult"]) }),
});
const entrySchema = z.discriminatedUnion("kind", [
  taskEntrySchema,
  compactionEntrySchema,
  messageEntrySchema,
]);
const acceptedSchema = z.object({ accepted: z.literal(true) });
const rejectedSchema = z.object({ rejected: z.literal(true) });
const lookupsSchema = z.object({
  calls: z.array(z.object({ name: z.string(), arguments: object, result: z.string() })),
});

type TaskEntry = z.infer<typeof taskEntrySchema>;
type CompactionEntry = z.infer<typeof compactionEntrySchema>;
type MessageEntry = { kind: "message"; id: string; message: AgentMessage };
type Entry = TaskEntry | CompactionEntry | MessageEntry;

interface SessionConfig {
  model: string;
  reasoning: string | null;
  routing: OpenRouterRouting | null;
}

/** One private conversation, persisted as an append-only JSONL transcript that every recovery reads. */
class Session {
  readonly entries: Entry[] = [];

  private constructor(
    readonly file: string,
    readonly id: string,
    readonly config: SessionConfig,
  ) {}

  static open(file: string, config: SessionConfig): Session {
    if (!fs.existsSync(file)) {
      const session = new Session(file, randomUUID(), config);
      fs.writeFileSync(
        file,
        `${JSON.stringify({ kind: "session", id: session.id, ...config })}\n`,
        {
          mode: 0o600,
        },
      );
      return session;
    }
    const contents = fs.readFileSync(file, "utf8");
    const complete = contents.slice(0, contents.lastIndexOf("\n") + 1);
    if (complete.length < contents.length) fs.truncateSync(file, Buffer.byteLength(complete));
    const [header, ...rows] = complete.split("\n").filter(Boolean);
    const { id, model, reasoning, routing } = headerSchema.parse(JSON.parse(header ?? "null"));
    const session = new Session(file, id, { model, reasoning, routing });
    for (const row of rows) session.entries.push(parseEntry(row));
    return session;
  }

  append(entry: Entry): void {
    this.entries.push(entry);
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
}

function parseEntry(line: string): Entry {
  const entry = entrySchema.parse(JSON.parse(line));
  if (entry.kind !== "message") return entry;
  // SAFETY: message rows are written only by Session.append from finalized pi-agent-core messages.
  return { ...entry, message: entry.message as AgentMessage };
}

/** The messages the model sees: failed replies are dropped and each compaction replaces what it summarized. */
function transcript(entries: readonly Entry[]): AgentMessage[] {
  let messages: AgentMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "message" && !failed(entry.message)) messages.push(entry.message);
    if (entry.kind === "compaction") {
      const cut = messages.length - entry.kept;
      const head = getCurrentSystemMessage(messages.slice(0, cut));
      if (!head) throw new Error("Agent session has no system prompt to compact under");
      messages = [
        head,
        user(`${CHECKPOINT}\n\n${entry.summary}`, entry.at),
        ...messages.slice(cut),
      ];
    }
  }
  return messages;
}

function failed(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted")
  );
}

function user(content: string, timestamp = Date.now()): UserMessage {
  return { role: "user", content, timestamp };
}

function contentText(content: readonly (TextContent | ImageContent)[]): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function contextTokens(messages: readonly AgentMessage[]): number {
  const last = messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  return last
    ? last.usage.input + last.usage.cacheRead + last.usage.cacheWrite + last.usage.output
    : 0;
}

/** How many trailing messages stay verbatim: at most the keep budget, starting at an assistant reply so no tool result is orphaned. */
function keptCount(messages: readonly AgentMessage[]): number {
  let tokens = 0;
  let kept = 0;
  for (let index = messages.length - 1; index > 0; index -= 1) {
    tokens += JSON.stringify(messages[index]).length / 4;
    if (tokens > COMPACTION_KEEP_TOKENS) break;
    if (messages[index]!.role === "assistant") kept = messages.length - index;
  }
  return kept;
}

function usageRecord(usage: Usage) {
  return {
    input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    output_tokens: usage.output,
    reasoning_tokens: usage.reasoning ?? 0,
    cached_input_tokens: usage.cacheRead,
    cost: usage.cost.total,
  };
}

function addUsage(total: Record<string, number>, usage: Record<string, number>): void {
  for (const [key, value] of Object.entries(usage)) total[key] = (total[key] ?? 0) + value;
}

interface TaskState {
  entry: TaskEntry;
  prompted: boolean;
  usage: Record<string, number>;
  reasoning: string[];
  tools: ToolCallRecord[];
  attempts: number;
  /** Submissions the validator saw and rejected, in order; a stateful validator is rebuilt from them. */
  rejected: JsonObject[];
  accepted?: { input: JsonObject; messageID: string; latencyMs: number };
}

/** Everything one task did, read back from the transcript up to its accepted submission. */
function taskState(entries: readonly Entry[], task: string, submission: string) {
  let state: TaskState | undefined;
  const calls = new Map<string, { input: JsonObject; messageID: string }>();
  for (const entry of entries) {
    if (entry.kind === "task") {
      if (state) break;
      if (entry.task === task)
        state = {
          entry,
          prompted: false,
          usage: {},
          reasoning: [],
          tools: [],
          attempts: 0,
          rejected: [],
        };
      continue;
    }
    if (!state) continue;
    if (entry.kind === "compaction") {
      addUsage(state.usage, entry.usage);
      continue;
    }
    const { message } = entry;
    if (message.role === "user") state.prompted = true;
    if (message.role === "assistant") {
      addUsage(state.usage, usageRecord(message.usage));
      for (const part of message.content) {
        if (part.type === "thinking") state.reasoning.push(part.thinking);
        if (part.type === "toolCall")
          calls.set(part.id, { input: object.parse(part.arguments), messageID: entry.id });
      }
    }
    if (message.role !== "toolResult") continue;
    const lookups = lookupsSchema.safeParse(message.details);
    if (lookups.success) {
      state.tools.push(...lookups.data.calls);
      continue;
    }
    const call = calls.get(message.toolCallId);
    state.tools.push({
      name: message.toolName,
      arguments: call?.input ?? {},
      result: contentText(message.content),
    });
    if (message.toolName === submission) state.attempts += 1;
    if (call && rejectedSchema.safeParse(message.details).success) state.rejected.push(call.input);
    if (call && acceptedSchema.safeParse(message.details).success) {
      state.accepted = {
        input: call.input,
        messageID: call.messageID,
        latencyMs: message.timestamp - state.entry.at,
      };
      break;
    }
  }
  return state;
}

/** Rendered with the runtime's own signature generator into the system prompt, where descriptions are never truncated. */
function sessionSubmissions(task: AgentTask<unknown>): ToolDefinition[] {
  const declared = task.submissions ?? [task.submission];
  if (!declared.some((tool) => tool.name === task.submission.name))
    throw new Error(`${task.submission.name} is not one of the session's submission tools`);
  return declared.map((tool) => (tool.name === task.submission.name ? task.submission : tool));
}

/** OpenRouter variant suffixes such as `:nitro` share their base model's catalog entry. */
function resolveModel(models: Models, task: AgentTask<unknown>): Model<Api> {
  const { provider, model } = parseSpec(task.model);
  const id = modelUpstreamRoutes().get(task.model) ?? model;
  const found =
    models.getModel(provider, id) ?? models.getModel(provider, id.replace(/:[a-z]+$/, ""));
  if (!found)
    throw new Error(
      `The pi-ai catalog has no ${provider} model ${id}; map it to a listed model with VGC_MODEL_UPSTREAM`,
    );
  if (task.reasoning && !getSupportedThinkingLevels(found).includes(task.reasoning))
    throw new Error(`${task.model} does not offer reasoning level ${task.reasoning}`);
  return { ...found, id };
}

class AgentHost {
  readonly live: LiveRun;
  private readonly sessions = new Map<string, Session>();
  private readonly active = new Set<string>();

  constructor(
    readonly runDir: string,
    readonly models: Models,
    private readonly onProgress?: (progress: AgentProgress) => void,
  ) {
    this.live = new LiveRun(runDir);
  }

  claim(name: string): void {
    if (this.active.has(name)) throw new Error(`Agent session already has an active task: ${name}`);
    this.active.add(name);
  }

  release(name: string): void {
    this.active.delete(name);
  }

  session(name: string, config: SessionConfig): Session {
    let session = this.sessions.get(name);
    if (!session) {
      const directory = path.join(this.runDir, "agents");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      session = Session.open(path.join(directory, `${encodeURIComponent(name)}.jsonl`), config);
      this.sessions.set(name, session);
    }
    if (!isDeepStrictEqual(session.config, config))
      throw new Error(`Agent session configuration changed: ${name}`);
    return session;
  }

  emit(progress: AgentProgress): void {
    this.live.agent(progress);
    this.onProgress?.(progress);
  }
}

export async function withAgentHost<T>(
  runDir: string,
  run: (agents: AgentRuntime) => Promise<T>,
  onProgress?: (progress: AgentProgress) => void,
  models?: Models,
): Promise<T> {
  const catalog = models ?? (await import("@earendil-works/pi-ai/providers/all")).builtinModels();
  const host = new AgentHost(path.resolve(runDir), catalog, onProgress);
  try {
    return await run({ run: (task) => executeTask(task, host), live: host.live });
  } finally {
    host.live.flush();
  }
}

async function executeTask<T>(task: AgentTask<T>, host: AgentHost): Promise<AgentResult<T>> {
  const started = performance.now();
  task.signal?.throwIfAborted();
  host.claim(task.session);
  const run = new TaskRun(task, host);
  try {
    const model = resolveModel(host.models, task);
    const routing = parseSpec(task.model).provider === "openrouter" ? openRouterRouting() : null;
    const session = host.session(task.session, {
      model: task.model,
      reasoning: task.reasoning ?? null,
      routing,
    });
    const tasks = session.entries.filter((entry) => entry.kind === "task");
    const prior = tasks.find((entry) => entry.task === task.task);
    if (prior && (prior.prompt !== task.prompt || prior.system !== task.system))
      throw new Error(`Agent task input changed: ${task.task}`);
    const state = taskState(session.entries, task.task, task.submission.name);
    for (const input of state?.rejected ?? []) {
      try {
        run.submit(input);
      } catch {
        continue;
      }
    }
    if (state?.accepted)
      return {
        ...run.result(session, state, run.submit(state.accepted.input)),
        recoveryMs: performance.now() - started,
      };
    const latest = tasks.at(-1);
    if (
      latest &&
      latest !== prior &&
      latest.task !== task.supersedes &&
      !taskState(session.entries, latest.task, "")?.accepted
    )
      throw new Error(`Previous agent task is incomplete: ${latest.task}`);
    if (prior && latest !== prior)
      throw new Error(`Cannot resume an earlier incomplete task: ${task.task}`);
    if (!prior)
      session.append({
        kind: "task",
        task: task.task,
        prompt: task.prompt,
        system: task.system,
        at: Date.now(),
      });
    return await run.execute(session, model, routing, state?.prompted ?? false);
  } finally {
    host.release(task.session);
    run.progress("ended");
  }
}

class TaskRun<T> {
  private activity: AgentActivity = "starting";
  private tool?: string;
  private usage?: AgentProgress["usage"];
  private accepted?: { value: T };
  private failure?: Error;
  private rejections = 0;
  private lookups = 0;

  constructor(
    private readonly task: AgentTask<T>,
    private readonly host: AgentHost,
  ) {
    this.progress();
  }

  progress(activity = this.activity): void {
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
    this.host.emit(progress);
  }

  submit(input: JsonObject): T {
    rejectUndeclared(this.task.submission, input);
    return this.task.validate(input);
  }

  result(session: Session, state: TaskState, value: T): AgentResult<T> {
    const accepted = state.accepted!;
    return {
      value,
      sessionID: session.id,
      messageID: accepted.messageID,
      response: JSON.stringify(accepted.input),
      reasoning: state.reasoning.join("\n\n"),
      usage: state.usage,
      tools: state.tools,
      attempts: state.attempts,
      latencyMs: accepted.latencyMs,
    };
  }

  async execute(
    session: Session,
    model: Model<Api>,
    routing: OpenRouterRouting | null,
    prompted: boolean,
  ): Promise<AgentResult<T>> {
    const { task } = this;
    const request: Pick<SimpleStreamOptions, "sessionId" | "onPayload"> = {
      sessionId: session.id,
      onPayload: routing
        ? (payload) => ({ ...z.looseObject({}).parse(payload), provider: routing })
        : undefined,
    };
    if (
      !prompted &&
      contextTokens(transcript(session.entries)) > model.contextWindow - COMPACTION_RESERVE_TOKENS
    )
      await this.compact(session, model, request);
    const context = transcript(session.entries);
    const agent = new Agent({
      ...request,
      initialState: { model, thinkingLevel: task.reasoning ?? "off", messages: context },
      streamFn: this.host.models.streamSimple.bind(this.host.models),
      finishTurn: ({ toolResults }) => this.finishTurn(toolResults),
    });
    agent.state.tools = this.tools();
    agent.subscribe((event) => this.observe(session, event));
    let next = () => agent.continue();
    if (!prompted) {
      const system = this.system();
      const pending: AgentMessage[] = [];
      if (getCurrentSystemMessage(context)?.sections?.[PROMPT_SECTION] !== system)
        pending.push({
          role: "system",
          content: "",
          sections: { [PROMPT_SECTION]: system },
          timestamp: Date.now(),
        });
      pending.push(user(task.prompt));
      next = () => agent.prompt(pending);
    } else if (context.at(-1)?.role === "assistant") next = () => agent.prompt(user(CONTINUE));
    const abort = () => agent.abort();
    task.signal?.addEventListener("abort", abort, { once: true });
    try {
      let retries = 0;
      for (let reminders = 0; ;) {
        await next();
        task.signal?.throwIfAborted();
        if (this.failure) throw this.failure;
        const state = taskState(session.entries, task.task, task.submission.name)!;
        if (state.accepted) return this.result(session, state, this.accepted!.value);
        const last = agent.state.messages.at(-1);
        if (last?.role === "assistant" && failed(last)) {
          const transient = isRetryableAssistantError(last);
          if (
            task.timed ||
            retries >= MODEL_RETRIES ||
            !(transient || RESAMPLED_STOPS.has(last.rawStopReason ?? ""))
          )
            throw new Error(last.errorMessage ?? `${task.model} stopped with ${last.stopReason}`);
          retries += 1;
          this.progress("retry");
          if (transient)
            await sleep(RETRY_BASE_MS * 2 ** (retries - 1), undefined, {
              signal: task.signal,
            }).catch((error: Error) => {
              task.signal?.throwIfAborted();
              throw error;
            });
          agent.state.messages = agent.state.messages.slice(0, -1);
          next = () => agent.continue();
          continue;
        }
        if (reminders >= SUBMISSION_REMINDERS)
          throw new Error(
            `No accepted ${task.submission.name} submission after ${reminders} reminders`,
          );
        reminders += 1;
        const name = task.submission.name;
        next = () =>
          agent.prompt(
            user(
              `No ${name} submission was accepted. A text reply is not a submission: call ${name} now, correcting any validation error it returned.`,
            ),
          );
      }
    } finally {
      task.signal?.removeEventListener("abort", abort);
    }
  }

  private system(): string {
    const { task } = this;
    const submissions = sessionSubmissions(task);
    const catalog = task.tools?.length
      ? `${CATALOG_INTRO}\n\n${renderDeclarations({ tools: this.catalog([]) })}`
      : "";
    return [
      task.system,
      `${submissions.length === 1 ? `Submit using ${task.submission.name}.` : "Submit each task with the submission tool its instructions name."} Rejected submissions return validation errors; correct them and submit again.`,
      catalog,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private tools(): ModelTool[] {
    const { task } = this;
    const submissions = sessionSubmissions(task).map((definition): ModelTool => ({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: object.parse(withoutClosedObjects(definition.parameters)),
      execute: async (_id, input) => {
        if (definition.name !== task.submission.name)
          throw new Error(
            `${definition.name} is not this task's submission tool; submit with ${task.submission.name}.`,
          );
        if (this.accepted)
          return {
            content: [
              {
                type: "text",
                text: "This task already has an accepted submission. End your reply.",
              },
            ],
            details: null,
          };
        try {
          this.accepted = { value: this.submit(object.parse(input)) };
        } catch (error) {
          return {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            details: { rejected: true },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: SUBMISSION_ACCEPTED }],
          details: { accepted: true },
        };
      },
    }));
    if (!task.tools?.length) return submissions;
    const execute: ModelTool = {
      name: "execute",
      label: "execute",
      description: EXECUTE_DESCRIPTION,
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
      execute: async (_id, input, signal) => {
        const { code } = z.object({ code: z.string() }).parse(input);
        const calls: ToolCallRecord[] = [];
        const sandbox = new CodemodeSandbox({ tools: this.catalog(calls) });
        try {
          const result = await sandbox.execute(code, { signal });
          const content: (TextContent | ImageContent)[] = [...result.output];
          if (!result.ok)
            content.push({ type: "text", text: result.error.stack ?? result.error.message });
          else if (result.value !== undefined)
            content.push({ type: "text", text: JSON.stringify(result.value) });
          return { content, details: { calls }, isError: !result.ok };
        } finally {
          await sandbox.close();
        }
      },
    };
    return [execute, ...submissions];
  }

  private catalog(calls: ToolCallRecord[]): CodemodeTool[] {
    return (this.task.tools ?? []).map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      inputSchema: object.parse(withoutClosedObjects(tool.definition.parameters)),
      outputSchema: { type: "string" },
      execute: (input) => this.lookup(tool, object.parse(input), calls),
    }));
  }

  private lookup(tool: AgentTool, args: JsonObject, calls: ToolCallRecord[]): string {
    const name = tool.definition.name;
    if (this.lookups >= REFERENCE_CALL_BUDGET) {
      const message = `this task's budget of ${REFERENCE_CALL_BUDGET} reference calls is spent; decide from the results you already have`;
      if (this.lookups === REFERENCE_CALL_BUDGET)
        calls.push({ name, arguments: args, result: `Error: ${message}` });
      this.lookups += 1;
      throw new Error(message);
    }
    this.lookups += 1;
    let result: string;
    try {
      rejectUndeclared(tool.definition, args);
      result = tool.run(args);
    } catch (error) {
      result = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    calls.push({ name, arguments: args, result });
    return result;
  }

  private finishTurn(toolResults: readonly ToolResultMessage[]): AgentTurnDecision | undefined {
    const name = this.task.submission.name;
    this.rejections += toolResults.filter(
      (result) => result.toolName === name && result.isError,
    ).length;
    if (this.accepted) return { action: "end" };
    if (this.rejections < SUBMISSION_FAILURES) return undefined;
    this.failure = new Error(`${name} failed validation ${this.rejections} times`);
    return { action: "end" };
  }

  private observe(session: Session, event: AgentEvent): void {
    switch (event.type) {
      case "message_end":
        session.append({ kind: "message", id: randomUUID(), message: event.message });
        if (event.message.role !== "assistant") return;
        this.addUsage(event.message.usage);
        return this.progress();
      case "turn_start":
        return this.progress("generating");
      case "message_update":
        if (event.assistantMessageEvent.type === "thinking_start") this.progress("reasoning");
        if (event.assistantMessageEvent.type === "thinking_end") this.progress("generating");
        return;
      case "tool_execution_start":
        this.tool = event.toolName;
        return this.progress("tool");
      case "tool_execution_end":
        return this.progress("generating");
    }
  }

  private addUsage(usage: Usage): void {
    const total = this.usage ?? { cost: 0, inputTokens: 0, outputTokens: 0 };
    this.usage = {
      cost: total.cost + usage.cost.total,
      inputTokens: total.inputTokens + usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: total.outputTokens + usage.output,
    };
  }

  private async compact(
    session: Session,
    model: Model<Api>,
    request: Pick<SimpleStreamOptions, "sessionId" | "onPayload">,
  ): Promise<void> {
    this.progress("compacting");
    const context = transcript(session.entries);
    const reply = await this.host.models.completeSimple(
      model,
      { messages: [...context, user(COMPACTION_PROMPT)] },
      { ...request, signal: this.task.signal, reasoning: this.task.reasoning },
    );
    const summary = contentText(
      reply.content.filter((part): part is TextContent => part.type === "text"),
    ).trim();
    if (failed(reply) || !summary)
      throw new Error(`Conversation compaction failed: ${reply.errorMessage ?? "no summary"}`);
    this.addUsage(reply.usage);
    session.append({
      kind: "compaction",
      summary,
      kept: keptCount(context),
      usage: usageRecord(reply.usage),
      at: Date.now(),
    });
  }
}
