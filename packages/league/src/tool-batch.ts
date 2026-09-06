import { z } from "zod";
import type { JsonObject, ToolDefinition } from "./types.js";

export const MAX_TOOL_QUERIES_PER_ROUND = 32;
const BATCH_TOOL = "batch_tools";

const batchSchema = z.strictObject({
  queries: z
    .array(
      z.strictObject({
        name: z.string(),
        arguments: z.record(z.string(), z.json()),
      }),
    )
    .min(1)
    .max(MAX_TOOL_QUERIES_PER_ROUND),
});

export interface ToolQueryResult extends JsonObject {
  name: string;
  arguments: JsonObject;
  result: string;
}

export function withToolBatch(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return [
    ...tools,
    {
      name: BATCH_TOOL,
      description: `Run up to ${MAX_TOOL_QUERIES_PER_ROUND} independent read-only queries in one call, including different tools. Each arguments object must use the named tool's input schema. Results follow query order; queries cannot depend on other results in this batch. Native tool calls and batched queries share the round's query limit.`,
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TOOL_QUERIES_PER_ROUND,
            items: {
              type: "object",
              properties: {
                name: { type: "string", enum: tools.map((tool) => tool.name) },
                arguments: { type: "object", additionalProperties: true },
              },
              required: ["name", "arguments"],
              additionalProperties: false,
            },
          },
        },
        required: ["queries"],
        additionalProperties: false,
      },
    },
  ];
}

export class ToolRound {
  private remaining = MAX_TOOL_QUERIES_PER_ROUND;
  private readonly names: Set<string>;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly lookup: (name: string, args: JsonObject) => string,
    private readonly record: (result: ToolQueryResult) => void,
    private readonly signal?: AbortSignal,
  ) {
    this.names = new Set(tools.map((tool) => tool.name));
  }

  run(name: string, args: JsonObject, inputError?: string): string {
    this.signal?.throwIfAborted();
    if (inputError) {
      const result = `Not executed: invalid tool input: ${inputError}`;
      this.record({ name, arguments: args, result });
      return result;
    }
    if (name !== BATCH_TOOL || !this.names.has(name)) return this.query(name, args);
    const parsed = batchSchema.safeParse(args);
    if (!parsed.success) {
      const result = `Not executed: batch_tools requires 1 to ${MAX_TOOL_QUERIES_PER_ROUND} queries, each with a name and an arguments object.`;
      this.record({ name, arguments: args, result });
      return result;
    }
    return JSON.stringify(
      parsed.data.queries.map((query) => ({
        name: query.name,
        result: this.query(query.name, query.arguments),
      })),
    );
  }

  private query(name: string, args: JsonObject): string {
    this.signal?.throwIfAborted();
    let result: string;
    if (name === BATCH_TOOL || !this.names.has(name)) {
      result = `Not executed: tool ${JSON.stringify(name)} was not offered in this stage or cannot be nested.`;
    } else if (this.remaining === 0) {
      result = `Not executed: this round exceeded its budget of ${MAX_TOOL_QUERIES_PER_ROUND} queries. Re-issue the query next round if you still need it.`;
    } else {
      this.remaining -= 1;
      try {
        result = this.lookup(name, args);
      } catch (error) {
        this.signal?.throwIfAborted();
        result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.record({ name, arguments: args, result });
    return result;
  }
}
