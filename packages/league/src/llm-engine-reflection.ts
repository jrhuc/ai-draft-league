import { type BattleMemory, renderStrategicMemory } from "./battle-memory.js";
import type { GameEnd } from "./battle-agent.js";
import type { Pid } from "./types.js";
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
    `Turns: ${input.outcome.turns === undefined ? "?" : count(input.outcome.turns)}. Decision errors: ${count(input.outcome.errors)}. Simulator substitutions: ${count(input.outcome.simulator_substitutions)}. Timer autodefaults: ${count(input.outcome.timer_autodefaults)}.`,
    "",
    "Final authoritative state:",
    input.finalState,
    "",
    "Complete private Showdown battle log (your POV):",
    ...input.gameLog,
    ...(input.retrospective
      ? []
      : ["", "Current private strategic memory:", renderStrategicMemory(input.memory)]),
    "",
    input.retrospective
      ? "Submit your tournament retrospective with submit_review."
      : "Submit your game review with submit_review. Update selected notebook fields where useful; omitted fields remain unchanged.",
  ].join("\n");
}
