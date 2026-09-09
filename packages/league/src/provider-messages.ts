import type { ModelMessage, ToolCallPart } from "ai";
import type { Completion, ProviderMessage, ToolCall } from "./types.js";

function indexedToolCalls(calls: ToolCall[]): ToolCall[] {
  const reserved = new Set(calls.map((call) => call.id).filter(Boolean));
  return calls.map((call, index) => {
    if (call.id) return call;
    let id = `call_${index}`;
    while (reserved.has(id)) id += "_";
    reserved.add(id);
    return { ...call, id };
  });
}

export function uniqueToolCalls(calls: ToolCall[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const call of indexedToolCalls(calls)) {
    if (!byId.has(call.id)) byId.set(call.id, call);
  }
  return [...byId.values()];
}

export function assistantMessage(completion: Completion): ProviderMessage {
  const message: ProviderMessage = {
    role: "assistant",
    content: completion.text || null,
    toolCalls: uniqueToolCalls(completion.toolCalls),
  };
  if (!completion.responseMessages?.length) return message;
  const indexed = indexedToolCalls(completion.toolCalls);
  const handled = new Set([...completion.toolCalls, ...indexed].map((call) => call.id));
  const seen = new Set<string>();
  let index = 0;
  message.raw = completion.responseMessages.flatMap((raw): ModelMessage[] => {
    if (raw.role === "tool") {
      const content = raw.content.filter(
        (part) => part.type !== "tool-result" || !handled.has(part.toolCallId),
      );
      return content.length ? [{ ...raw, content }] : [];
    }
    if (raw.role !== "assistant" || !Array.isArray(raw.content)) return [raw];
    const content = raw.content.flatMap((part): typeof raw.content => {
      if (part.type !== "tool-call") return [part];
      const call = indexed[index++];
      if (!call) throw new Error("provider response has an unaccounted tool call");
      if (seen.has(call.id)) return [];
      seen.add(call.id);
      return [{ ...part, toolCallId: call.id, toolName: call.name, input: call.arguments }];
    });
    return content.length ? [{ ...raw, content }] : [];
  });
  if (index !== indexed.length) throw new Error("provider response is missing tool calls");
  return message;
}

export function toolResultMessage(callId: string, content: string): ProviderMessage {
  return { role: "tool", toolCallId: callId, content };
}

export function convertMessages(messages: ProviderMessage[]): ModelMessage[] {
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
    } else if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) callNames.set(call.id, call.name);
      if (message.raw?.length) {
        converted.push(...message.raw);
        continue;
      }
      const content: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        const part: ToolCallPart = {
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
        };
        if (call.providerMetadata) part.providerOptions = call.providerMetadata;
        content.push(part);
      }
      converted.push({ role: "assistant", content });
    } else {
      converted.push({ role: message.role, content: message.content ?? "" });
    }
  }
  return converted;
}
