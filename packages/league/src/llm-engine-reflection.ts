import type { GameEnd } from "./battle-agent.js";
import { extractReflection } from "./llm-engine-support.js";
import { classifyProviderFailure } from "./providers.js";
import type { Completion, Pid, ProviderMessage } from "./types.js";
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
  notebook: string;
}): string {
  return [
    `Series ${input.seriesId ?? "?"}; game ${input.gameNumber}; result: ${input.result}; series score ${input.scoreText}.`,
    ...(input.seriesOver
      ? [
          `The series is over: you ${input.seriesResult} it ${input.score.mine}-${input.score.theirs} (you are ${input.pid}).`,
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
    `Current private notebook: ${input.notebook || "(empty)"}`,
    "",
    "Return the required concise game review and updated notebook.",
  ].join("\n");
}

export async function requestReflection(input: {
  prompt: string;
  currentNotebook: string;
  result: string;
  spec: string;
  complete: (messages: ProviderMessage[]) => Promise<Completion>;
}) {
  const messages: ProviderMessage[] = [{ role: "user", content: input.prompt }];
  const usage: Record<string, number> = {};
  let rawResponse = "";
  let parsed;
  let error: string | undefined;
  let failureSummary: string | undefined;
  let failureKind: string | undefined;
  try {
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      const completion = await input.complete(messages);
      for (const [key, value] of Object.entries(completion.usage)) {
        usage[key] = (usage[key] ?? 0) + (key === "cost" ? value : Math.trunc(value));
      }
      rawResponse = completion.text;
      if (!rawResponse.trim() && completion.reasoning) {
        try {
          extractReflection(completion.reasoning);
          rawResponse = completion.reasoning;
        } catch {}
      }
      try {
        parsed = extractReflection(rawResponse);
        error = undefined;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        if (attempt === 0) {
          messages.push({
            role: "assistant",
            content: rawResponse || "[the reply contained no visible text]",
          });
          messages.push({
            role: "user",
            content: `Invalid review: ${error}. Reply with exactly the required JSON object.`,
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
  const review =
    parsed ??
    ({
      summary: `Game ${input.result}; model reflection unavailable (${failureSummary ?? error ?? "unparseable review"}).`,
      adjustment: "Retain the existing series plan and reassess from the next team preview.",
      notebook: input.currentNotebook,
    } satisfies { summary: string; adjustment: string; notebook: string });
  return { usage, rawResponse, error, failureSummary, failureKind, fallback, review };
}
