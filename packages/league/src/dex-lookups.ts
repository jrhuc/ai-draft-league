import type { BoardSearch } from "./board-search.js";
import { assistantToolMessage, toolResultMessage, uniqueToolCalls } from "./providers.js";
import type { ShowdownReference } from "./reference.js";
import { DEX_TOOLS } from "./reference.js";
import type {
  CompleteOptions,
  Completion,
  JsonObject,
  JsonValue,
  Provider,
  ProviderMessage,
  ToolDefinition,
} from "./types.js";
import { isRecord, text } from "./value.js";

export const TOOL_BUDGET_NOTICE =
  "Tool budget for this reply is exhausted; further tool calls will not be executed. Reply now with only the final JSON object.";

function textToolCall(reply: string): { name: string; arguments: JsonObject } | undefined {
  const trimmed = reply.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const name = text(parsed.name);
  const args = parsed.args ?? parsed.arguments ?? parsed.parameters;
  return name && isRecord(args) ? { name, arguments: args } : undefined;
}

interface DexToolPolicy {
  maxTokens: number;
  toolRounds: number;
  maxCallsPerRound: number;
}

export interface ExtraTool {
  definition: ToolDefinition;
  run: (args: JsonObject) => string;
}

export interface DexToolRequest {
  provider: Provider;
  system: string;
  messages: ProviderMessage[];
  spec: string;
  reference: ShowdownReference;
  policy: DexToolPolicy;
  boardSearch?: BoardSearch;
  extraTools?: ExtraTool[];
  signal?: AbortSignal;
  onLookup?: (call: { name: string; arguments: JsonObject; result: string }) => void;
}

function offeredTools(request: DexToolRequest): ToolDefinition[] {
  return [
    ...DEX_TOOLS,
    ...(request.boardSearch ? [request.boardSearch.definition] : []),
    ...(request.extraTools ?? []).map((tool) => tool.definition),
  ];
}

async function completeOnce(
  request: DexToolRequest,
  options: { tools: boolean; final: boolean },
): Promise<Completion> {
  const completeOptions: CompleteOptions = {
    maxTokens: request.policy.maxTokens,
    signal: request.signal,
  };
  if (options.tools) {
    completeOptions.tools = offeredTools(request);
    completeOptions.toolChoice = options.final ? "none" : "auto";
  }
  return request.provider.complete(request.system, request.messages, completeOptions);
}

export interface DexToolCompletion extends Completion {
  /** Whether the final generation reported at least the requested output cap before it stopped. */
  outputLimitReached: boolean;
}

export async function completeWithDexTools(request: DexToolRequest): Promise<DexToolCompletion> {
  const usage: Record<string, number> = {};
  const seenToolResults = new Map<string, string>();
  const offeredNames = new Set(offeredTools(request).map((tool) => tool.name));
  const extra = new Map(
    (request.extraTools ?? []).map((tool) => [tool.definition.name, tool.run] as const),
  );
  const lookup = (name: string, args: JsonObject): string => {
    const seenKey = `${name} ${JSON.stringify(args)}`;
    const cached = seenToolResults.get(seenKey);
    if (cached !== undefined) return `[identical to an earlier call this reply] ${cached}`;
    const result = !offeredNames.has(name)
      ? `Not executed: tool ${JSON.stringify(name)} was not offered in this stage.`
      : request.boardSearch && name === request.boardSearch.definition.name
        ? request.boardSearch.run(args)
        : (extra.get(name)?.(args) ?? request.reference.lookup(name, args));
    seenToolResults.set(seenKey, result);
    return result;
  };
  for (let round = 0; ; round += 1) {
    request.signal?.throwIfAborted();
    const final = round >= request.policy.toolRounds;
    if (final && round === request.policy.toolRounds) {
      request.messages.push({ role: "user", content: TOOL_BUDGET_NOTICE });
    }
    const completion = await completeOnce(request, { tools: true, final });
    for (const [key, value] of Object.entries(completion.usage)) {
      usage[key] = (usage[key] ?? 0) + (key === "cost" ? value : Math.trunc(value));
    }
    if (!completion.toolCalls.length || final) {
      const salvaged = final ? undefined : textToolCall(completion.text);
      if (salvaged) {
        request.messages.push({ role: "assistant", content: completion.text });
        const result = lookup(salvaged.name, salvaged.arguments);
        request.onLookup?.({ name: salvaged.name, arguments: salvaged.arguments, result });
        request.messages.push({
          role: "user",
          content: `Tool result for ${salvaged.name}: ${result}\nWhen your analysis is done, reply with only the final JSON object.`,
        });
        continue;
      }
      /** Some providers omit finishReason, so reported output reaching the requested cap is authoritative. */
      const outputLimitReached = (completion.usage.output_tokens ?? 0) >= request.policy.maxTokens;
      const result: DexToolCompletion = {
        ...completion,
        usage,
        outputLimitReached,
      };
      if (outputLimitReached) result.finishReason = "length";
      return result;
    }

    const requested = uniqueToolCalls(completion.toolCalls);
    const calls = requested.slice(0, request.policy.maxCallsPerRound);
    const dropped = requested.slice(request.policy.maxCallsPerRound);
    request.messages.push(assistantToolMessage(completion));
    for (const call of dropped) {
      const result = `Not executed: this round exceeded its budget of ${request.policy.maxCallsPerRound} calls. Re-issue the call next round if you still need it.`;
      request.onLookup?.({ name: call.name, arguments: call.arguments, result });
      request.messages.push(toolResultMessage(call.id, result));
    }
    for (const call of calls) {
      const result = lookup(call.name, call.arguments);
      request.onLookup?.({ name: call.name, arguments: call.arguments, result });
      request.messages.push(toolResultMessage(call.id, result));
    }
  }
}
