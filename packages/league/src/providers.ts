import { appendFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible, type MetadataExtractor } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  RetryError,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";

import { providerOption } from "./provider-registry.js";
import { redactSecrets } from "./sanitize.js";
import type {
  CompleteOptions,
  Completion,
  JsonObject,
  JsonValue,
  Provider,
  ProviderFailure,
  ProviderMessage,
  ToolCall,
  ToolDefinition,
} from "./types.js";

import { isRecord } from "./value.js";

type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const errorStatusSchema = z.object({
  code: z.number().optional().catch(undefined),
  status: z.number().optional().catch(undefined),
});
const openRouterErrorSchema = z.object({
  error: z.object({ code: z.union([z.string(), z.number()]) }),
});
const gatewayPayloadSchema = z.object({
  provider: z.string().optional().catch(undefined),
  usage: z
    .object({ cost: z.number().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
const gatewayMetadataSchema = z.object({
  provider: z.string().optional().catch(undefined),
  cost: z.number().optional().catch(undefined),
});
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export function isReasoningLevel(value: JsonValue | undefined): value is ReasoningLevel {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export interface ModelReasoningConfig {
  reasoning?: ReasoningLevel;
  reasoningByModel?: Readonly<Record<string, ReasoningLevel>>;
}

export function reasoningForModel(
  model: string,
  config: ModelReasoningConfig,
): ReasoningLevel | undefined {
  return config.reasoningByModel?.[model] ?? config.reasoning;
}

export function validateModelExecution(
  models: readonly string[],
  config: ModelReasoningConfig & { apiKeys?: Readonly<Record<string, string>> },
): void {
  for (const model of models) validateReasoning(parseSpec(model), reasoningForModel(model, config));
  if (!config.apiKeys) return;
  for (const model of models) {
    if (model !== "random" && config.apiKeys[model] === undefined)
      throw new Error(`API key missing for ${model}; this run cannot use environment keys`);
  }
}

const USAGE =
  "Usage: openrouter:<model-id>, prime:<model-id>, gateway:<model-id>, opencode-go:<model-id>, opencode-zen:<model-id>, or random";
interface ProviderSpec {
  provider: "openrouter" | "prime" | "gateway" | "opencode-go" | "opencode-zen" | "random";
  model: string;
}

export function parseSpec(value: string): ProviderSpec {
  if (value === "random") return { provider: "random", model: "random" };
  for (const provider of [
    "openrouter",
    "prime",
    "gateway",
    "opencode-go",
    "opencode-zen",
  ] as const) {
    const prefix = `${provider}:`;
    if (!value.startsWith(prefix)) continue;
    const model = value.slice(prefix.length);
    if (model && !model.startsWith("-") && !/[\s\p{Cc}]/u.test(model)) return { provider, model };
    break;
  }
  throw new Error(USAGE);
}

export interface ProviderRoute {
  spec: string;
  provider: ProviderSpec["provider"];
  base_url: string | null;
  model: string;
  api: OpenCodeApi;
  reasoning: ReasoningLevel | null;
  routing: JsonObject | null;
}

/** One manifest row per seat: where its calls go and with what settings, so the route is frozen in the
 * run rather than reconstructed from whatever the environment holds later. */
export function describeProviderRoute(
  spec: string,
  reasoning: ReasoningLevel | undefined,
  openRouterRouting: JsonObject,
): ProviderRoute {
  const parsed = parseSpec(spec);
  return {
    spec,
    provider: parsed.provider,
    base_url: providerOption(parsed.provider)?.baseUrl ?? null,
    model: parsed.model,
    api:
      parsed.provider === "opencode-go" || parsed.provider === "opencode-zen"
        ? opencodeApi(parsed.provider, parsed.model)
        : "chat",
    reasoning: reasoning ?? null,
    routing: parsed.provider === "openrouter" ? openRouterRouting : null,
  };
}

export function validateReasoning(spec: ProviderSpec, level?: string): void {
  if (!level) return;
  if (!isReasoningLevel(level)) throw new Error(`invalid reasoning level ${JSON.stringify(level)}`);
  if (spec.provider === "random") return;
  if (
    spec.provider !== "openrouter" &&
    spec.provider !== "opencode-go" &&
    spec.provider !== "opencode-zen"
  ) {
    throw new Error(
      `${spec.provider}:${spec.model} has no advertised configurable reasoning levels`,
    );
  }
}

export type OpenCodeApi = "chat" | "messages" | "responses";

/** OpenCode serves each model through exactly one API shape (https://opencode.ai/docs/zen, /docs/go):
 * GPT, Grok and Muse through the Responses API, Claude and Qwen (and MiniMax on Go) through the
 * Anthropic Messages API, and the rest through chat completions. Gemini needs the Google API, which
 * this harness does not speak. */
export function opencodeApi(provider: "opencode-go" | "opencode-zen", model: string): OpenCodeApi {
  const id = model.toLowerCase();
  if (id.startsWith("gemini-"))
    throw new Error(
      `${provider}:${model} is served through the Google API, which is not supported`,
    );
  if (/^(?:gpt-|grok-|muse-)/.test(id)) return "responses";
  if (/^(?:claude-|qwen)/.test(id)) return "messages";
  if (provider === "opencode-go" && id.startsWith("minimax-")) return "messages";
  return "chat";
}

function parseToolArguments(value: JsonValue): JsonObject {
  if (isRecord(value)) return value;
  if (String(value) !== value || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Providers reject a round that answers one call id twice, and some models do repeat an id across
 * the tool calls in a single response. Collapsing to the first occurrence is the only reply that
 * stays valid: an invented id for the duplicate is rejected just as hard as the duplicate itself. */
export function uniqueToolCalls(calls: ToolCall[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  calls.forEach((call, index) => {
    const id = call.id || `call_${index}`;
    if (!byId.has(id)) byId.set(id, { ...call, id });
  });
  return [...byId.values()];
}

export function assistantToolMessage(completion: Completion): ProviderMessage {
  const message: ProviderMessage = {
    role: "assistant",
    content: completion.text || null,
    toolCalls: uniqueToolCalls(completion.toolCalls),
  };
  if (completion.responseMessages?.length) message.raw = completion.responseMessages;
  return message;
}

export function toolResultMessage(callId: string, content: string): ProviderMessage {
  return { role: "tool", toolCallId: callId, content };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const HARD_QUOTA_ERROR =
  /(?:insufficient[_ -]?quota|exceeded your current quota|free[_ -]?tier[_ -]?requests|requests?[_ -]?per[_ -]?day|generateRequestsPerDay|credit balance|billing quota)/i;

/** A 429 says nothing useful on its own, so the limit the provider names is pulled out of the body. */
function limitDetail(message: string): string {
  const quota =
    /"quotaId"\s*:\s*"([^"]+)"/.exec(message)?.[1] ??
    /"quotaMetric"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  if (quota) return quota.split("/").pop() ?? quota;
  return (
    /\b(requests?|tokens?|input tokens?|output tokens?)[ _-]per[ _-](minute|hour|day)\b/i.exec(
      message,
    )?.[0] ?? ""
  );
}

function rateLimited(label: string, message: string): ProviderFailure {
  const detail = limitDetail(message);
  return {
    kind: "rate_limit",
    summary: `${label} API rate limit was reached (429${detail ? `; ${detail}` : ""}).`,
    terminal: false,
  };
}

export function classifyProviderFailure(cause: unknown, spec = "provider"): ProviderFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  const status =
    cause instanceof ApiError ? cause.status : Number(/\b([45]\d\d)\b/.exec(message)?.[1] ?? 0);
  const provider = spec.split(":", 1)[0] || "provider";
  let label = provider.charAt(0).toUpperCase() + provider.slice(1);
  if (provider === "openrouter") label = "OpenRouter";
  else if (provider === "prime") label = "Prime Inference";
  else if (provider === "gateway") label = "Vercel AI Gateway";
  else if (provider === "opencode-go") label = "OpenCode Go";
  else if (provider === "opencode-zen") label = "OpenCode Zen";
  const suffix = status ? ` (${status})` : "";
  if (
    /Connect error (?:unauthenticated|unavailable|resource[_ -]?exhausted|internal|aborted|deadline[_ -]?exceeded)/i.test(
      message,
    )
  ) {
    return {
      kind: "upstream",
      summary: `${label} transport failed transiently.`,
      terminal: false,
    };
  }
  if (/Upstream request failed|Inference is temporarily unavailable/i.test(message)) {
    return {
      kind: "upstream",
      summary: `${label} API is temporarily unavailable${suffix}.`,
      terminal: false,
    };
  }
  if (status === 429 && /per[_ -]?minute/i.test(message)) {
    return rateLimited(label, message);
  }
  if (HARD_QUOTA_ERROR.test(message)) {
    const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(message)?.[1];
    return {
      kind: "quota",
      summary: `${label} API quota is exhausted${quotaId ? ` (${status || 429}; ${quotaId})` : suffix}.`,
      terminal: true,
    };
  }
  if ((status === 0 || status === 408) && /(?:timed? ?out|timeout|time exhausted)/i.test(message)) {
    return { kind: "timeout", summary: `${label} API request timed out.`, terminal: false };
  }
  if (status === 0 && /^reasoning exhausted the \d+-token response budget$/i.test(message.trim())) {
    return {
      kind: "truncation",
      summary: `${label} API spent the whole response budget on reasoning and returned no answer.`,
      terminal: false,
    };
  }
  if (
    /^provider stopped the response for length after \d+ output tokens, below the requested \d+-token cap(?: before a choice was submitted)?$/i.test(
      message.trim(),
    )
  ) {
    return {
      kind: "truncation",
      summary: `${label} API stopped the response for length below the requested output cap.`,
      terminal: false,
    };
  }
  if (status === 0 && /^empty response$/i.test(message.trim())) {
    return {
      kind: "upstream",
      summary: `${label} API returned no usable response.`,
      terminal: true,
    };
  }
  if (status === 0 && cause instanceof ApiError) {
    return { kind: "network", summary: `${label} API could not be reached.`, terminal: false };
  }
  if (status === 200) {
    return {
      kind: "upstream",
      summary: `${label} API returned an unusable 200 response.`,
      terminal: false,
    };
  }
  if (status === 409 || status === 425) {
    return {
      kind: "upstream",
      summary: `${label} API request was temporarily blocked (${status}).`,
      terminal: false,
    };
  }
  if (status === 429) {
    return rateLimited(label, message);
  }
  if (status === 402) {
    return {
      kind: "quota",
      summary: `${label} API credits are exhausted (402).`,
      terminal: true,
    };
  }
  if (cause instanceof TypeError) {
    return { kind: "network", summary: `${label} API could not be reached.`, terminal: false };
  }
  if (status >= 500 && status !== 501 && status !== 505) {
    return {
      kind: "upstream",
      summary: `${label} API is temporarily unavailable (${status}).`,
      terminal: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "request",
      summary: `${label} API rejected the credentials${suffix}.`,
      terminal: true,
    };
  }
  if (status === 404) {
    return {
      kind: "request",
      summary: `${label} model or endpoint was not found (404).`,
      terminal: true,
    };
  }
  return { kind: "request", summary: `${label} API request failed${suffix}.`, terminal: true };
}

function openRouterErrorStatus(responseBody: string | undefined): number | undefined {
  if (!responseBody) return undefined;
  try {
    const body = openRouterErrorSchema.safeParse(JSON.parse(responseBody));
    if (!body.success) return undefined;
    const code = Number(body.data.error.code);
    return Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_TIMEOUT = 1800;

export interface InfraRetryPolicy {
  attempts: number;
  timeoutAttempts: number;
  baseMs: number;
  capMs: number;
}

/** Timeout attempts get their own tighter budget because each one holds the seat for up to DEFAULT_TIMEOUT. */
const INFRA_RETRY_DEFAULTS: InfraRetryPolicy = {
  attempts: 20,
  timeoutAttempts: 6,
  baseMs: 2_000,
  capMs: 300_000,
};
const RETRY_AFTER_CAP_MS = 600_000;

/** Providers name their cooldown inconsistently, so the failure text is scanned for the common spellings. */
function retryAfterMs(message: string): number | undefined {
  const explicit = /retry[-_ ]?after[^0-9]{0,12}(\d+(?:\.\d+)?)/i.exec(message)?.[1];
  if (explicit) return Math.min(Number(explicit) * 1000, RETRY_AFTER_CAP_MS);
  const phrased = /try again in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)/i.exec(message);
  if (!phrased) return undefined;
  const scale = phrased[2]!.startsWith("m") ? 1 : 1000;
  return Math.min(Number(phrased[1]) * scale, RETRY_AFTER_CAP_MS);
}

function backoffSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish);
  });
}

interface GatewayResponseMeta {
  cost?: number;
  provider?: string;
}

/** OpenRouter may choose among upstream stacks, but never silently falls back after making that choice. */
export function parseRoutingPreferences(env: NodeJS.ProcessEnv = process.env): JsonObject {
  const pinned = env.VGC_OPENROUTER_PIN?.trim();
  if (!pinned) return { allow_fallbacks: false };
  if (pinned.includes(","))
    throw new Error("VGC_OPENROUTER_PIN accepts exactly one upstream provider");
  return { order: [pinned], allow_fallbacks: false };
}
function bodyFetch(
  base: FetchRequest | undefined,
  amend: (body: JsonObject) => void,
): FetchRequest {
  const inner = base ?? fetch;
  return async (input, init) => {
    let request = init;
    const encodedBody = z.string().safeParse(request?.body);
    if (encodedBody.success) {
      try {
        const body = JSON.parse(encodedBody.data);
        if (isRecord(body)) {
          amend(body);
          request = { ...request, body: JSON.stringify(body) };
        }
      } catch {}
    }
    return inner(input, request);
  };
}
function openRouterFetch(base: FetchRequest | undefined, routing: JsonObject): FetchRequest {
  return bodyFetch(base, (body) => {
    body.usage = { include: true };
    body.provider = routing;
  });
}

/** The Responses adapter only emits `reasoning.effort` for model ids it knows as OpenAI reasoning
 * models, so the effort a run asked for is written into the request body for every Responses model. */
function responsesReasoningFetch(
  base: FetchRequest | undefined,
  level: ReasoningLevel,
): FetchRequest {
  return bodyFetch(base, (body) => {
    if (!isRecord(body.reasoning)) body.reasoning = { effort: level };
  });
}
function collectGatewayMeta<Payload>(payload: Payload, meta: GatewayResponseMeta): void {
  const parsed = gatewayPayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  if (parsed.data.provider) meta.provider = parsed.data.provider;
  if (parsed.data.usage?.cost !== undefined) meta.cost = parsed.data.usage.cost;
}

function gatewayMetadata(meta: GatewayResponseMeta) {
  return Object.keys(meta).length ? { openrouter: { ...meta } } : undefined;
}

/** Uses the compatible provider's parsed chunks instead of implementing a second SSE parser. */
const OPENROUTER_METADATA: MetadataExtractor = {
  async extractMetadata({ parsedBody }) {
    const meta: GatewayResponseMeta = {};
    collectGatewayMeta(parsedBody, meta);
    return gatewayMetadata(meta);
  },
  createStreamExtractor() {
    const meta: GatewayResponseMeta = {};
    return {
      processChunk(chunk) {
        collectGatewayMeta(chunk, meta);
      },
      buildMetadata() {
        return gatewayMetadata(meta);
      },
    };
  },
};

export function nitroSpec(spec: string): string {
  if (!spec.startsWith("openrouter:")) return spec;
  if (/:(?:nitro|floor|free)$/.test(spec)) return spec;
  return `${spec}:nitro`;
}

function convertMessages(messages: ProviderMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool") {
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId ?? "",
            toolName: callNames.get(message.toolCallId ?? "") ?? message.name ?? "",
            output: { type: "text", value: message.content ?? "" },
          },
        ],
      });
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) callNames.set(call.id, call.name);
      if (message.raw?.length) {
        converted.push(...message.raw);
        continue;
      }
      const content: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        const providerOptions = call.providerMetadata;
        const part: Extract<
          Extract<ModelMessage, { role: "assistant" }>["content"][number],
          { type: "tool-call" }
        > = {
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
        };
        if (providerOptions) part.providerOptions = providerOptions;
        content.push(part);
      }
      converted.push({ role: "assistant", content });
    } else {
      converted.push({ role: message.role, content: message.content ?? "" });
    }
  }
  return converted;
}

const TOOL_SETS = new WeakMap<ToolDefinition[], ToolSet>();

const EPHEMERAL_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

function markFirstUserBreakpoint(messages: ModelMessage[]): void {
  const first = messages.find((message) => message.role === "user");
  if (first) first.providerOptions = EPHEMERAL_CACHE;
}

class SdkProvider implements Provider {
  readonly model: string;
  readonly reasoning?: ReasoningLevel | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetch: FetchRequest | undefined;
  private readonly api: OpenCodeApi;
  private readonly retry: InfraRetryPolicy;

  constructor(
    private readonly spec: ProviderSpec,
    options: {
      apiKey?: string | undefined;
      reasoning?: ReasoningLevel | undefined;
      fetch?: FetchRequest | undefined;
      retry?: Partial<InfraRetryPolicy> | undefined;
    },
  ) {
    this.model = spec.model;
    this.reasoning = options.reasoning;
    this.apiKey = options.apiKey;
    this.retry = {
      attempts: options.retry?.attempts ?? INFRA_RETRY_DEFAULTS.attempts,
      timeoutAttempts: options.retry?.timeoutAttempts ?? INFRA_RETRY_DEFAULTS.timeoutAttempts,
      baseMs: options.retry?.baseMs ?? INFRA_RETRY_DEFAULTS.baseMs,
      capMs: options.retry?.capMs ?? INFRA_RETRY_DEFAULTS.capMs,
    };
    this.api =
      spec.provider === "opencode-go" || spec.provider === "opencode-zen"
        ? opencodeApi(spec.provider, spec.model)
        : "chat";
    this.fetch =
      spec.provider === "openrouter"
        ? openRouterFetch(options.fetch, parseRoutingPreferences())
        : this.api === "responses" && options.reasoning
          ? responsesReasoningFetch(options.fetch, options.reasoning)
          : options.fetch;
  }

  private key(): string {
    const envKey = providerOption(this.spec.provider)?.envKey;
    if (!envKey) throw new Error(USAGE);
    const apiKey = this.apiKey ?? process.env[envKey];
    if (!apiKey) throw new Error(`Missing ${envKey}`);
    return apiKey;
  }

  agentModel() {
    const apiKey = this.key();
    const secrets = this.secrets(apiKey);
    const redact = (cause: unknown) => this.redactedError(cause, secrets);
    return {
      model: this.languageModel(apiKey),
      reasoning: this.reasoning,
      redact,
    };
  }

  private cachedModel: { apiKey: string; model: LanguageModel } | undefined;

  private languageModel(apiKey: string): LanguageModel {
    if (this.cachedModel?.apiKey !== apiKey)
      this.cachedModel = { apiKey, model: this.buildLanguageModel(apiKey) };
    return this.cachedModel.model;
  }

  private buildLanguageModel(apiKey: string): LanguageModel {
    const option = providerOption(this.spec.provider);
    if (!option?.baseUrl) throw new Error(USAGE);
    const transport = this.fetch ? { fetch: this.fetch } : {};
    if (this.api === "responses") {
      return createOpenAI({
        name: this.spec.provider,
        baseURL: option.baseUrl,
        apiKey,
        ...transport,
      }).responses(this.model);
    }
    if (this.api === "messages") {
      return createAnthropic({
        name: this.spec.provider,
        baseURL: option.baseUrl,
        apiKey,
        ...transport,
      })(this.model);
    }
    if (this.spec.provider === "openrouter") {
      return createOpenAICompatible({
        name: this.spec.provider,
        baseURL: option.baseUrl,
        apiKey,
        ...transport,
        metadataExtractor: OPENROUTER_METADATA,
      })(this.model);
    }
    return createOpenAICompatible({
      name: this.spec.provider,
      baseURL: option.baseUrl,
      apiKey,
      ...transport,
    })(this.model);
  }

  private secrets(apiKey: string): string[] {
    return [
      apiKey,
      process.env.OPENROUTER_API_KEY ?? "",
      process.env.PRIME_API_KEY ?? "",
      process.env.AI_GATEWAY_API_KEY ?? "",
      process.env.OPENCODE_API_KEY ?? "",
    ];
  }

  private redactedError(cause: unknown, secrets: readonly string[]): Error {
    let detail: string;
    if (cause instanceof Error) detail = cause.message;
    else if (cause instanceof Object) {
      try {
        detail = JSON.stringify(cause);
      } catch {
        detail = "provider transport failed";
      }
    } else detail = String(cause);
    const message = redactSecrets(detail, secrets) || "provider transport failed";
    if (cause instanceof ApiError) return new ApiError(cause.status, message);
    if (cause instanceof TypeError) return new TypeError(message);
    const status = errorStatusSchema.safeParse(cause);
    if (status.success) return new ApiError(status.data.code ?? status.data.status ?? 0, message);
    return new Error(message);
  }
  /** All backoff lives here: the SDK's own retries are disabled so every failure is classified once,
   * infra-class failures (rate limit, upstream, network, timeout) retry with jittered backoff honoring
   * any advertised cooldown, and schema/legality/truncation handling stays with the callers' budgets.
   * Timed battles pass failFast so the battle clock keeps control. */
  async complete(
    system: string,
    messages: ProviderMessage[],
    options: CompleteOptions = {},
  ): Promise<Completion> {
    let tries = 0;
    let timeoutTries = 0;
    for (;;) {
      try {
        return await this.completeAttempt(system, messages, options);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const failure = classifyProviderFailure(error, `${this.spec.provider}:${this.model}`);
        tries += 1;
        if (failure.kind === "timeout") timeoutTries += 1;
        const retryable = !failure.terminal && failure.kind !== "truncation" && !options.failFast;
        const budgetSpent =
          tries >= this.retry.attempts ||
          (failure.kind === "timeout" && timeoutTries >= this.retry.timeoutAttempts);
        if (!retryable || budgetSpent) throw error;
        const backoff = Math.min(this.retry.baseMs * 2 ** (tries - 1), this.retry.capMs);
        const jittered = backoff / 2 + Math.random() * (backoff / 2);
        const advertised =
          retryAfterMs(error instanceof Error ? error.message : String(error)) ?? 0;
        const wait = Math.max(jittered, advertised);
        console.error(
          `[infra-retry] ${this.spec.provider}:${this.model} ${failure.kind} try ${tries}: ${failure.summary} retrying in ${Math.round(wait / 1000)}s`,
        );
        await backoffSleep(wait, options.signal);
        if (options.signal?.aborted) throw error;
      }
    }
  }

  private async completeAttempt(
    system: string,
    messages: ProviderMessage[],
    options: CompleteOptions,
  ): Promise<Completion> {
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT * 1000);
    const abortSignal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const apiKey = this.key();
    const secrets = this.secrets(apiKey);
    try {
      const model = this.languageModel(apiKey);
      let tools: ToolSet | undefined;
      if (options.tools?.length) {
        tools = TOOL_SETS.get(options.tools);
        if (!tools) {
          tools = {};
          for (const definition of options.tools) {
            const parameters =
              // SAFETY: ToolDefinition parameters are owned JSON Schemas built by this harness.
              definition.parameters as JSONSchema7;
            tools[definition.name] = tool({
              description: definition.description,
              inputSchema: jsonSchema(parameters),
            });
          }
          TOOL_SETS.set(options.tools, tools);
        }
      }
      /** streamText reports stream failures through onError rather than rejecting, so rethrow the first
       * captured error after consumption and preserve the normal retry/failure evidence path. */
      let streamError: unknown;
      const toolOptions = tools
        ? options.toolChoice
          ? { tools, toolChoice: options.toolChoice }
          : { tools }
        : {};
      const reasoningOptions = options.reasoningMaxTokens
        ? {
            providerOptions: {
              [this.spec.provider]: { reasoning: { max_tokens: options.reasoningMaxTokens } },
            },
          }
        : this.reasoning
          ? { reasoning: this.reasoning }
          : {};
      /** Anthropic-style APIs reject prefill when extended thinking is on, so reasoning disables it. */
      const prefill =
        options.prefillResponse &&
        this.api === "messages" &&
        !this.reasoning &&
        !options.reasoningMaxTokens
          ? options.prefillResponse
          : undefined;
      const converted = convertMessages(
        prefill ? [...messages, { role: "assistant", content: prefill }] : messages,
      );
      /** Cache breakpoints stay claude-only: other Messages-shaped gateways may reject cache_control. */
      const cacheBreakpoints = this.api === "messages" && this.model.includes("claude");
      if (cacheBreakpoints) markFirstUserBreakpoint(converted);
      const systemMessage: ModelMessage = {
        role: "system",
        content: system,
        providerOptions: EPHEMERAL_CACHE,
      };
      const stream = streamText({
        model,
        ...(cacheBreakpoints ? {} : { system }),
        messages: cacheBreakpoints ? [systemMessage, ...converted] : converted,
        ...toolOptions,
        ...reasoningOptions,
        maxOutputTokens: options.maxTokens ?? 1200,
        maxRetries: 0,
        abortSignal,
        onError: ({ error }) => {
          if (streamError === undefined) streamError = error;
        },
      });
      await stream.consumeStream();
      if (streamError !== undefined) throw streamError;
      abortSignal.throwIfAborted();
      const [
        text,
        finishReason,
        usage,
        streamToolCalls,
        rawReasoningText,
        response,
        providerMetadata,
      ] = await Promise.all([
        stream.text,
        stream.finishReason,
        stream.usage,
        stream.toolCalls,
        stream.reasoningText,
        stream.response,
        stream.providerMetadata,
      ]);
      const debugTarget = process.env.VGC_DEBUG_PROVIDER_ERRORS;
      if (debugTarget && !text.trim() && streamToolCalls.length === 0) {
        let raw = "(unavailable)";
        try {
          raw = JSON.stringify(
            Object.getOwnPropertyDescriptor(response, "body")?.value ?? null,
          ).slice(0, 2000);
        } catch {}
        raw = redactSecrets(raw, secrets);
        const line = redactSecrets(
          `[provider-debug] ${this.spec.provider}:${this.model} empty-response ` +
            `finish=${finishReason} usage=${JSON.stringify(usage)} response=${raw}`,
          secrets,
        );
        if (debugTarget === "1") console.error(line);
        else appendFileSync(debugTarget, `${line}\n`);
      }
      const reasoningText = rawReasoningText?.trim() ?? "";
      const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
      const gateway = gatewayMetadataSchema.safeParse(providerMetadata?.openrouter);
      const reportedGateway = gateway.success ? gateway.data : undefined;
      const completionUsage: Completion["usage"] = {
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
      };
      if (reasoningTokens > 0) completionUsage.reasoning_tokens = reasoningTokens;
      const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
      if (cacheReadTokens > 0) completionUsage.cached_input_tokens = cacheReadTokens;
      if (reportedGateway?.cost !== undefined) completionUsage.cost = reportedGateway.cost;
      const toolCalls: ToolCall[] = streamToolCalls.map((call) => {
        const convertedCall: ToolCall = {
          id: call.toolCallId,
          name: call.toolName,
          arguments: parseToolArguments(z.json().catch(null).parse(call.input)),
        };
        if (call.providerMetadata) convertedCall.providerMetadata = call.providerMetadata;
        return convertedCall;
      });
      const completion: Completion = {
        text: prefill === undefined ? text : prefill + text,
        finishReason,
        usage: completionUsage,
        toolCalls,
      };
      if (reportedGateway?.provider) completion.provider = reportedGateway.provider;
      if (reasoningText) completion.reasoning = reasoningText;
      if (response.messages.length) completion.responseMessages = response.messages;
      return completion;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timeout.aborted)
        throw new ApiError(
          0,
          `request to ${this.spec.provider}:${this.model} timed out after ${DEFAULT_TIMEOUT}s`,
        );
      const finalError = RetryError.isInstance(error) ? error.lastError : error;
      if (APICallError.isInstance(finalError)) {
        const detail = redactSecrets(finalError.responseBody ?? finalError.message, secrets);
        const inBandStatus =
          this.spec.provider === "openrouter"
            ? openRouterErrorStatus(finalError.responseBody)
            : undefined;
        const status = inBandStatus ?? finalError.statusCode ?? 0;
        const debugTarget = process.env.VGC_DEBUG_PROVIDER_ERRORS;
        if (debugTarget) {
          const body =
            finalError.requestBodyValues === undefined
              ? undefined
              : JSON.stringify(finalError.requestBodyValues);
          const line = redactSecrets(
            `[provider-debug] ${this.spec.provider}:${this.model} ${status} request=${body ?? "(unavailable)"}`,
            secrets,
          );
          if (debugTarget === "1") console.error(line);
          else {
            appendFileSync(debugTarget, `${line}\n`);
            appendFileSync(
              `${debugTarget}.messages.jsonl`,
              `${JSON.stringify(convertMessages(messages))}\n`,
            );
          }
        }
        throw new ApiError(status, `${this.spec.provider}:${this.model} ${status}: ${detail}`);
      }
      throw this.redactedError(finalError, secrets);
    }
  }
}

export function makeProvider(
  spec: ProviderSpec,
  options: {
    apiKey?: string | undefined;
    reasoning?: ReasoningLevel | undefined;
    fetch?: FetchRequest | undefined;
    retry?: Partial<InfraRetryPolicy> | undefined;
  } = {},
): Provider {
  validateReasoning(spec, options.reasoning);
  if (spec.provider === "random") throw new Error("random provider is handled separately");
  return new SdkProvider(spec, options);
}

export type AgentModel = ReturnType<SdkProvider["agentModel"]>;

export function makeAgentModel(
  spec: ProviderSpec,
  options: {
    apiKey?: string | undefined;
    reasoning?: ReasoningLevel | undefined;
    fetch?: FetchRequest | undefined;
  } = {},
): AgentModel {
  validateReasoning(spec, options.reasoning);
  if (spec.provider === "random") throw new Error("random provider is handled separately");
  return new SdkProvider(spec, options).agentModel();
}
