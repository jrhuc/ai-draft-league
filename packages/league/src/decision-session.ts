import { assistantToolMessage, toolResultMessage, uniqueToolCalls } from "./providers.js";
import { ToolRound, type ToolQueryResult } from "./tool-batch.js";
import type { Completion, JsonObject, ProviderMessage, ToolDefinition } from "./types.js";

export interface DecisionBudget {
  maxProviderCalls: number;
  maxToolRounds: number;
  maxToolQueries: number;
  maxOutputTokens: number;
}

export const LIBERAL_DECISION_BUDGET: DecisionBudget = {
  maxProviderCalls: 96,
  maxToolRounds: 64,
  maxToolQueries: 1_024,
  maxOutputTokens: 2_097_152,
};

export interface DecisionSessionResult extends Completion {
  providerCalls: number;
  toolRounds: number;
  toolQueries: ToolQueryResult[];
}

interface DecisionSessionOptions {
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  lookup: (name: string, args: JsonObject) => string;
  budget?: Partial<DecisionBudget>;
  signal?: AbortSignal;
  onLookup?: (call: ToolQueryResult) => void;
}

interface ToolLoopOptions {
  maxToolRounds: number;
  finalNotice: string;
  complete: (
    messages: ProviderMessage[],
    final: boolean,
    remainingOutputTokens: number,
  ) => Promise<Completion>;
  forceFinal?: () => boolean;
  salvageToolCall?: (text: string) => { name: string; arguments: JsonObject } | undefined;
  afterToolRound?: (messages: ProviderMessage[]) => void;
}

export class DecisionSession {
  readonly messages: ProviderMessage[];
  private readonly budget: DecisionBudget;
  private providerCalls = 0;
  private toolRounds = 0;
  private outputTokens = 0;
  private readonly toolQueries: ToolQueryResult[] = [];
  private noticeAdded = false;

  constructor(private readonly options: DecisionSessionOptions) {
    this.messages = options.messages;
    this.budget = { ...LIBERAL_DECISION_BUDGET, ...options.budget };
  }

  async completeToolLoop(options: ToolLoopOptions): Promise<DecisionSessionResult> {
    const usage: Record<string, number> = {};
    const reasoning: string[] = [];
    let localToolRounds = 0;
    for (;;) {
      this.options.signal?.throwIfAborted();
      const exhausted =
        this.providerCalls >= this.budget.maxProviderCalls - 1 ||
        this.toolRounds >= this.budget.maxToolRounds ||
        this.outputTokens >= this.budget.maxOutputTokens;
      const final =
        exhausted || localToolRounds >= options.maxToolRounds || options.forceFinal?.() === true;
      if (final && !this.noticeAdded) {
        this.noticeAdded = true;
        this.messages.push({ role: "user", content: options.finalNotice });
      }
      if (this.providerCalls >= this.budget.maxProviderCalls) {
        throw new Error(`decision session exceeded ${this.budget.maxProviderCalls} provider calls`);
      }
      const remainingOutputTokens = Math.max(1, this.budget.maxOutputTokens - this.outputTokens);
      const completion = await options.complete(this.messages, final, remainingOutputTokens);
      this.providerCalls += 1;
      const generated = Math.max(0, Math.trunc(completion.usage.output_tokens ?? 0));
      this.outputTokens += generated;
      for (const [key, value] of Object.entries(completion.usage)) {
        usage[key] = (usage[key] ?? 0) + (key === "cost" ? value : Math.trunc(value));
      }
      if (completion.reasoning) reasoning.push(completion.reasoning);
      if (!completion.toolCalls.length || final) {
        const salvaged = final ? undefined : options.salvageToolCall?.(completion.text);
        if (salvaged) {
          this.messages.push({ role: "assistant", content: completion.text });
          const result = this.toolRound().run(salvaged.name, salvaged.arguments);
          this.messages.push({
            role: "user",
            content: `Tool result for ${salvaged.name}: ${result}\nWhen your analysis is done, reply with only the final JSON object.`,
          });
          localToolRounds += 1;
          this.toolRounds += 1;
          options.afterToolRound?.(this.messages);
          continue;
        }
        const result: DecisionSessionResult = {
          ...completion,
          usage,
          providerCalls: this.providerCalls,
          toolRounds: this.toolRounds,
          toolQueries: [...this.toolQueries],
        };
        const combinedReasoning = reasoning.join("\n\n").trim();
        if (combinedReasoning) result.reasoning = combinedReasoning;
        return result;
      }
      this.messages.push(assistantToolMessage(completion));
      const round = this.toolRound();
      for (const call of uniqueToolCalls(completion.toolCalls)) {
        const result = round.run(call.name, call.arguments, call.inputError);
        this.messages.push(toolResultMessage(call.id, result));
      }
      localToolRounds += 1;
      this.toolRounds += 1;
      options.afterToolRound?.(this.messages);
    }
  }

  private toolRound(): ToolRound {
    return new ToolRound(
      this.options.tools,
      (name, args) => {
        if (this.toolQueries.length >= this.budget.maxToolQueries) {
          return `Not executed: decision session exhausted its ${this.budget.maxToolQueries}-query budget.`;
        }
        return this.options.lookup(name, args);
      },
      (call) => {
        this.toolQueries.push(call);
        this.options.onLookup?.(call);
      },
      this.options.signal,
    );
  }
}
