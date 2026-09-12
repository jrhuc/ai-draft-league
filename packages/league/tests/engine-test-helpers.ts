import type { AgentContext, BattleAgent, BattleRequest } from "../src/types.js";

export function request(activeCount = 1): BattleRequest {
  return {
    active: Array.from({ length: activeCount }, () => ({
      moves: [
        { move: "First", id: "first", pp: 10, maxpp: 10, target: "self", disabled: false },
        { move: "Second", id: "second", pp: 10, maxpp: 10, target: "self", disabled: false },
      ],
    })),
    side: {
      pokemon: Array.from({ length: activeCount }, (_, slot) => ({
        ident: `p1: Mon${slot + 1}`,
        details: "Pikachu, L50",
        condition: "100/100",
        active: true,
        stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
        moves: ["first", "second"],
        ability: "static",
        item: "",
      })),
    },
  };
}

export const notebook = (seriesMemory = "", teamPlaybook = "", nextGamePlan = "") => ({
  team_playbook: teamPlaybook,
  series_memory: seriesMemory,
  next_game_plan: nextGamePlan,
});

let submissionSequence = 0;
export async function acceptedAct(
  engine: BattleAgent,
  battleRequest: BattleRequest,
  context: AgentContext,
): Promise<string> {
  const submission = await engine.submit(battleRequest, {
    ...context,
    submissionId: `test-submission-${++submissionSequence}`,
  });
  if (!submission) return "";
  engine.resolveSubmission(submission, "accepted");
  return submission.choice;
}
