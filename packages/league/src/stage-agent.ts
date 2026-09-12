import fs from "node:fs";
import { z } from "zod";
import type { BoardSearch } from "./board-search.js";
import type { AgentRunner, AgentTask, AgentTool } from "./agent-runtime.js";
import { DEX_TOOLS, type ShowdownReference } from "./reference.js";
import type { JsonObject, ToolDefinition } from "./types.js";

/** The advertised schema is strict; validation with the same schema strips unknown keys. */
export function submissionTool(name: string, schema: z.ZodType): ToolDefinition {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema);
  return {
    name,
    description:
      "Submit your decision. Validation errors are returned so you can correct and resubmit it. After acceptance, end your reply.",
    parameters: z.record(z.string(), z.json()).parse(parameters),
  };
}

export function referenceTools(
  reference: ShowdownReference,
  boardSearch?: BoardSearch,
  extra: AgentTool[] = [],
): AgentTool[] {
  return [
    ...DEX_TOOLS.map((definition) => ({
      definition,
      run: (input: JsonObject) => reference.lookup(definition.name, input),
    })),
    ...(boardSearch ? [boardSearch] : []),
    ...extra,
  ];
}

export async function runStage<T>(task: AgentTask<T> & { runner: AgentRunner; logFile: string }) {
  const result = await task.runner(task);
  fs.appendFileSync(
    task.logFile,
    `${JSON.stringify({
      attempt: result.attempts,
      system: task.system,
      user: task.prompt,
      response: result.response,
      reasoning: result.reasoning,
      usage: result.usage,
      tool_lookups: result.tools,
      session_id: result.sessionID,
      message_id: result.messageID,
      task_id: task.task,
      latency_ms: result.latencyMs,
      recovery_ms: result.recoveryMs,
    })}\n`,
  );
  return result;
}
