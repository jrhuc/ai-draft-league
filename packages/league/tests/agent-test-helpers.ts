import type { AgentResult, AgentRunner, AgentRuntime, AgentTask } from "../src/agent-runtime.js";
import type { JsonObject } from "../src/types.js";

export function agentReply<T>(task: AgentTask<T>, input: JsonObject, attempts = 1): AgentResult<T> {
  return {
    value: task.validate(input),
    sessionID: task.session,
    messageID: task.task,
    response: JSON.stringify(input),
    reasoning: "",
    usage: { input_tokens: 10, output_tokens: 2 },
    tools: [],
    attempts,
    latencyMs: 100,
  };
}

type ScriptedInput =
  | JsonObject
  | Error
  | ((task: AgentTask<unknown>) => JsonObject | Promise<JsonObject>);

/**
 * Consumes one scripted submission per task; a submission the task rejects is returned to the
 * script as a validation error and the next input is tried, as the OpenCode runtime would.
 */
export function scriptedAgent(inputs: ScriptedInput[]) {
  const calls: AgentTask<unknown>[] = [];
  const rejections: string[] = [];
  const run: AgentRunner = async (task) => {
    calls.push(task);
    for (let attempts = 1; ; attempts += 1) {
      const input = inputs.shift();
      if (input === undefined) throw new Error("missing scripted agent submission");
      if (input instanceof Error) throw input;
      const value = input instanceof Function ? await input(task) : input;
      try {
        return agentReply(task, value, attempts);
      } catch (error) {
        rejections.push(error instanceof Error ? error.message : String(error));
      }
    }
  };
  return { calls, rejections, run, agents: agentRuntime(run) };
}

export function agentRuntime(run: AgentRunner): AgentRuntime {
  return { run, live: { game() {}, invalidate() {} } };
}
