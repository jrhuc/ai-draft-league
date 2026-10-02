import type { AgentResult, AgentRunner, AgentTask } from "./agent-runtime.js";
import { rejectUndeclared } from "./tool-input.js";
import type { JsonObject } from "./types.js";

export interface ExternalExchange extends JsonObject {
  id: number;
  session: string;
  task: string;
  system: string;
  prompt: string;
  tools: Array<{ name: string; description: string; parameters: JsonObject }>;
  submission: { name: string; description: string; parameters: JsonObject };
}

export interface ExternalReply {
  response?: string;
  reasoning?: string;
  usage?: Record<string, number>;
}

export class ExchangeAbandoned extends Error {}

interface PendingExchange {
  view: ExternalExchange;
  tool: (name: string, input: JsonObject) => string;
  submit: (input: JsonObject, reply: ExternalReply) => void;
  abandon: (error: Error) => void;
}

export class ExternalRunner {
  private readonly pending = new Map<number, PendingExchange>();
  private sequence = 0;

  constructor(private readonly announce: (exchange: ExternalExchange) => void = () => {}) {}

  readonly run: AgentRunner = async <T>(task: AgentTask<T>) => {
    task.signal?.throwIfAborted();
    const started = performance.now();
    const id = ++this.sequence;
    const calls: AgentResult<T>["tools"] = [];
    let attempts = 0;
    const { promise, resolve, reject } = Promise.withResolvers<AgentResult<T>>();
    const settle = () => {
      this.pending.delete(id);
      task.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      settle();
      reject(task.signal?.reason ?? new Error("exchange aborted"));
    };
    task.signal?.addEventListener("abort", abort, { once: true });
    const view: ExternalExchange = {
      id,
      session: task.session,
      task: task.task,
      system: task.system,
      prompt: task.prompt,
      tools: (task.tools ?? []).map(({ definition }) => ({ ...definition })),
      submission: { ...task.submission },
    };
    this.pending.set(id, {
      view,
      tool: (name, input) => {
        const tool = task.tools?.find((candidate) => candidate.definition.name === name);
        if (!tool) throw new Error(`unknown tool ${name}`);
        try {
          rejectUndeclared(tool.definition, input);
          const result = tool.run(input);
          calls.push({ name, arguments: input, result });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          calls.push({ name, arguments: input, result: `Error: ${message}` });
          throw error;
        }
      },
      submit: (input, reply) => {
        attempts += 1;
        rejectUndeclared(task.submission, input);
        const value = task.validate(input);
        settle();
        resolve({
          value,
          sessionID: `external-${task.session}`,
          messageID: `exchange-${id}`,
          response: reply.response ?? JSON.stringify(input),
          reasoning: reply.reasoning ?? "",
          usage: reply.usage ?? {},
          tools: calls,
          attempts,
          latencyMs: performance.now() - started,
        });
      },
      abandon: (error) => {
        settle();
        reject(error);
      },
    });
    this.announce(view);
    return promise;
  };

  exchanges(): ExternalExchange[] {
    return [...this.pending.values()].map((exchange) => exchange.view);
  }

  tool(id: number, name: string, input: JsonObject): string {
    return this.exchange(id).tool(name, input);
  }

  /** Throws the validator's message when the arguments are refused; the exchange stays open. */
  submit(id: number, input: JsonObject, reply: ExternalReply = {}): void {
    this.exchange(id).submit(input, reply);
  }

  abandon(id: number, reason: string): void {
    this.exchange(id).abandon(new ExchangeAbandoned(reason));
  }

  close(reason: string): void {
    for (const exchange of this.pending.values()) exchange.abandon(new Error(reason));
  }

  private exchange(id: number): PendingExchange {
    const exchange = this.pending.get(id);
    if (!exchange) throw new Error(`no pending exchange ${id}`);
    return exchange;
  }
}
