import {
  applyMemoryUpdate,
  type BattleMemory,
  memoryUpdateTelemetry,
  MemoryUpdateError,
  renderStrategicMemory,
  renderVerifiedReferenceMemory,
} from "./battle-memory.js";
import type { GameEnd } from "./battle-agent.js";
import { DecisionSession } from "./decision-session.js";
import {
  extractReflection,
  extractTournamentRetrospective,
  type Reflection,
} from "./llm-engine-support.js";
import { assistantMessage, classifyProviderFailure } from "./providers.js";
import type { Completion, JsonObject, Pid, ProviderMessage, ToolDefinition } from "./types.js";
import { count } from "./value.js";
import type { ToolQueryResult } from "./tool-batch.js";

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
  signal?: AbortSignal | undefined;
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
  const toolCalls: ToolQueryResult[] = [];
  const reasoningParts: string[] = [];
  const session = new DecisionSession({
    messages,
    tools: input.tools,
    lookup: input.lookupTool,
    signal: input.signal,
  });
  try {
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      const completion = await session.completeToolLoop({
        maxToolRounds: 8,
        finalNotice:
          "Tool budget for this review is exhausted; reply now with exactly the required JSON object.",
        complete: (currentMessages, finalRound) => input.complete(currentMessages, finalRound),
      });
      toolRounds = completion.toolRounds;
      toolCalls.splice(0, toolCalls.length, ...completion.toolQueries);
      if (completion.reasoning) reasoningParts.push(completion.reasoning);
      for (const [key, value] of Object.entries(completion.usage)) {
        usage[key] = (usage[key] ?? 0) + (key === "cost" ? value : Math.trunc(value));
      }
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
          messages.push(assistantMessage(completion));
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
    input.signal?.throwIfAborted();
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
    reasoning: reasoningParts.join("\n\n").trim() || null,
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
