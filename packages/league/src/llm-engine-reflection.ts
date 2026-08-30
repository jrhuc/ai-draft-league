import {
  applyMemoryUpdate,
  type BattleMemory,
  memoryUpdateTelemetry,
  MemoryUpdateError,
  renderStrategicMemory,
  renderVerifiedReferenceMemory,
} from "./battle-memory.js";
import type { GameEnd } from "./battle-agent.js";
import {
  extractReflection,
  extractTournamentRetrospective,
  type Reflection,
} from "./llm-engine-support.js";
import {
  assistantToolMessage,
  classifyProviderFailure,
  toolResultMessage,
  uniqueToolCalls,
} from "./providers.js";
import type { Completion, JsonObject, Pid, ProviderMessage, ToolDefinition } from "./types.js";
import { count } from "./value.js";

export function reflectionPrompt(input: {
  seriesId: string | undefined;
  gameNumber: number;
  result: string;
  scoreText: string;
  seriesOver: boolean;
  seriesResult: string;
  score: { mine: number; theirs: number };
  pid: Pid;
  draftRoster: string | undefined;
  outcome: GameEnd["outcome"];
  finalState: string;
  timeline: string[];
  gameLog: string[];
  memory: BattleMemory;
  tournamentStatus?: GameEnd["tournamentStatus"];
  retrospective: boolean;
}): string {
  return [
    `Series ${input.seriesId ?? "?"}; game ${input.gameNumber}; result: ${input.result}; series score ${input.scoreText}.`,
    ...(input.seriesOver
      ? [
          `The series is over: you ${input.seriesResult} it ${input.score.mine}-${input.score.theirs} (you are ${input.pid}).`,
        ]
      : []),
    ...(input.tournamentStatus === "advancing"
      ? ["You won this single-elimination match and advance to the next round with the same team."]
      : input.tournamentStatus === "champion"
        ? ["You won the tournament final and are the champion; your tournament run is complete."]
        : input.tournamentStatus === "eliminated"
          ? [
              "You lost this single-elimination match and are eliminated; your tournament run is complete.",
            ]
          : []),
    ...(input.draftRoster ? [`Your full draft roster this season: ${input.draftRoster}`] : []),
    `Turns: ${input.outcome.turns === undefined ? "?" : count(input.outcome.turns)}. Decision errors: ${count(input.outcome.errors)}. Model-choice defaults: ${count(input.outcome.model_choice_fallbacks)}. Simulator substitutions: ${count(input.outcome.simulator_substitutions)}. Timer autodefaults: ${count(input.outcome.timer_autodefaults)}.`,
    "",
    "Final authoritative state:",
    input.finalState,
    "",
    "Compact private battle timeline:",
    ...input.timeline,
    "",
    "Complete private Showdown battle log (your POV; no model reasoning):",
    ...(input.gameLog.length ? input.gameLog : ["(unavailable)"]),
    "",
    ...(input.retrospective
      ? []
      : [
          "Current private strategic memory:",
          renderStrategicMemory(input.memory),
          "",
          "Verified reference memory from authoritative lookups:",
          renderVerifiedReferenceMemory(input.memory),
          "",
        ]),
    input.retrospective
      ? "Return the required concise tournament retrospective. Do not return or update the private notebook."
      : "Return the required concise game review and updated notebook.",
  ].join("\n");
}

export async function requestReflection(input: {
  prompt: string;
  currentMemory: () => BattleMemory;
  fallbackMemory: () => BattleMemory;
  result: string;
  spec: string;
  tools: ToolDefinition[];
  complete: (messages: ProviderMessage[], finalRound: boolean) => Promise<Completion>;
  lookupTool: (name: string, args: JsonObject) => string;
  retrospective: boolean;
}) {
  const messages: ProviderMessage[] = [{ role: "user", content: input.prompt }];
  const usage: Record<string, number> = {};
  let rawResponse = "";
  let parsed: Reflection | undefined;
  let error: string | undefined;
  let failureSummary: string | undefined;
  let failureKind: string | undefined;
  let toolRounds = 0;
  let memoryRepairAttempts = 0;
  let rejectedMemoryUpdate: JsonObject | undefined;
  const toolCalls: Array<{ name: string; arguments: JsonObject; result: string }> = [];
  const offered = new Set(input.tools.map((tool) => tool.name));
  try {
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      let completion: Completion | undefined;
      for (let round = 0; round <= 2; round += 1) {
        const finalRound = round === 2;
        completion = await input.complete(messages, finalRound);
        for (const [key, value] of Object.entries(completion.usage)) {
          usage[key] = (usage[key] ?? 0) + (key === "cost" ? value : Math.trunc(value));
        }
        if (!finalRound && completion.toolCalls.length) {
          toolRounds += 1;
          messages.push(assistantToolMessage(completion));
          const calls = uniqueToolCalls(completion.toolCalls);
          for (const [index, call] of calls.entries()) {
            let result: string;
            try {
              result =
                index >= 8
                  ? "Not executed: this review round is limited to 8 tool calls."
                  : offered.has(call.name)
                    ? input.lookupTool(call.name, call.arguments)
                    : `Not executed: tool ${JSON.stringify(call.name)} is not available during review.`;
            } catch (caught) {
              result = `Tool error: ${caught instanceof Error ? caught.message : String(caught)}`;
            }
            toolCalls.push({ name: call.name, arguments: call.arguments, result });
            messages.push(toolResultMessage(call.id, result));
          }
          continue;
        }
        break;
      }
      if (!completion) throw new Error("reflection completion unavailable");
      rawResponse = completion.text;
      if (!rawResponse.trim() && completion.reasoning) {
        try {
          if (input.retrospective)
            extractTournamentRetrospective(completion.reasoning, input.currentMemory());
          else extractReflection(completion.reasoning, input.currentMemory());
          rawResponse = completion.reasoning;
        } catch {}
      }
      try {
        parsed = input.retrospective
          ? extractTournamentRetrospective(rawResponse, input.currentMemory())
          : extractReflection(rawResponse, input.currentMemory());
        error = undefined;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        if (caught instanceof MemoryUpdateError) {
          memoryRepairAttempts += 1;
          rejectedMemoryUpdate = memoryUpdateTelemetry(caught.update);
        }
        if (attempt === 0) {
          messages.push({
            role: "assistant",
            content: rawResponse || "[the reply contained no visible text]",
          });
          messages.push({
            role: "user",
            content:
              caught instanceof MemoryUpdateError
                ? `Invalid review: ${error}. Compress the three notebook fields without dropping verified or decisive strategic facts, then reply with exactly the required JSON object.`
                : `Invalid review: ${error}. Reply with exactly the required JSON object.`,
          });
        }
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    const failure = classifyProviderFailure(caught, input.spec);
    failureSummary = failure.summary;
    failureKind = failure.kind;
  }
  const fallback = !parsed;
  const fallbackReason = `Game ${input.result}; model reflection unavailable (${failureSummary ?? error ?? "unparseable review"}).`;
  const fallbackMemory = input.fallbackMemory();
  const review =
    parsed ??
    (input.retrospective
      ? ({
          summary: fallbackReason,
          adjustment: "",
          memory: fallbackMemory,
          memoryUpdate: applyMemoryUpdate(fallbackMemory, undefined),
        } satisfies Reflection)
      : ({
          summary: fallbackReason,
          adjustment: "No model-authored adjustment was recorded.",
          memory: fallbackMemory,
          memoryUpdate: applyMemoryUpdate(fallbackMemory, undefined),
        } satisfies Reflection));
  return {
    usage,
    rawResponse,
    error,
    failureSummary,
    failureKind,
    fallback,
    review,
    toolRounds,
    toolCalls,
    memoryRepairAttempts,
    rejectedMemoryUpdate,
  };
}
