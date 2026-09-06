import type { BoardSearch } from "./board-search.js";
import { DecisionSession } from "./decision-session.js";
import type { ShowdownReference } from "./reference.js";
import { DEX_TOOLS } from "./reference.js";
import { withToolBatch, type ToolQueryResult } from "./tool-batch.js";
import { cachedToolLookup } from "./tool-cache.js";
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
  onLookup?: (call: ToolQueryResult) => void;
}

function offeredTools(request: DexToolRequest): ToolDefinition[] {
  return withToolBatch([
    ...DEX_TOOLS,
    ...(request.boardSearch ? [request.boardSearch.definition] : []),
    ...(request.extraTools ?? []).map((tool) => tool.definition),
  ]);
}

async function completeOnce(
  request: DexToolRequest,
  tools: ToolDefinition[],
  final: boolean,
): Promise<Completion> {
  const completeOptions: CompleteOptions = {
    maxTokens: request.policy.maxTokens,
    signal: request.signal,
    tools,
    toolChoice: final ? "none" : "auto",
  };
  return request.provider.complete(request.system, request.messages, completeOptions);
}

export interface DexToolCompletion extends Completion {
  /** Whether the final generation reported at least the requested output cap before it stopped. */
  outputLimitReached: boolean;
}

export async function completeWithDexTools(request: DexToolRequest): Promise<DexToolCompletion> {
  const tools = offeredTools(request);
  const extra = new Map(
    (request.extraTools ?? []).map((tool) => [tool.definition.name, tool.run] as const),
  );
  const lookup = cachedToolLookup((name, args) =>
    request.boardSearch && name === request.boardSearch.definition.name
      ? request.boardSearch.run(args)
      : (extra.get(name)?.(args) ?? request.reference.lookup(name, args)),
  );
  const session = new DecisionSession({
    messages: request.messages,
    tools,
    lookup,
    signal: request.signal,
    onLookup: request.onLookup,
  });
  const completion = await session.completeToolLoop({
    maxToolRounds: request.policy.toolRounds,
    finalNotice: TOOL_BUDGET_NOTICE,
    complete: (_messages, final) => completeOnce(request, tools, final),
    salvageToolCall: textToolCall,
  });
  /** Some providers omit finishReason, so reported output reaching the requested cap is authoritative. */
  const outputLimitReached = (completion.usage.output_tokens ?? 0) >= request.policy.maxTokens;
  const result: DexToolCompletion = { ...completion, outputLimitReached };
  if (outputLimitReached) result.finishReason = "length";
  return result;
}
