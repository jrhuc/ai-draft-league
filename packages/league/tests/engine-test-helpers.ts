import type {
  AgentContext,
  BattleAgent,
  BattleRequest,
  CompleteOptions,
  Completion,
  Provider,
  ProviderMessage,
} from "../src/types.js";

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

export const notebook = (
  seriesMemory = "",
  teamPlaybook = "",
  nextGamePlan = "",
) => ({
  team_playbook: teamPlaybook,
  series_memory: seriesMemory,
  next_game_plan: nextGamePlan,
});

export const decision = (choices: number[], rationale = "test choice", note = "") =>
  JSON.stringify({ choices, rationale, notebook: notebook(note) });

export const emptyStats = {
  decisions: 0,
  fallbacks: 0,
  reflections: 0,
  reflection_fallbacks: 0,
  move_selections: 0,
  switch_selections: 0,
  protect_selections: 0,
  consecutive_protect_selections: 0,
  ally_target_selections: 0,
  spread_move_selections: 0,
  mega_selections: 0,
  tool_lookups: 0,
  repeated_joint_actions: 0,
  team_previews: 0,
  bring_changes: 0,
  lead_changes: 0,
  substituted_actions: 0,
  abandoned_decisions: 0,
  parse_failures: 0,
};
export const oneMoveStats = { ...emptyStats, decisions: 1, move_selections: 1 };

export type ScriptedResponse =
  | string
  | Completion
  | Error
  | ((options: CompleteOptions) => string | Completion | Error);

export class ScriptedProvider implements Provider {
  readonly calls: Array<{ system: string; messages: ProviderMessage[]; options: CompleteOptions }> =
    [];
  private index = 0;

  constructor(private readonly responses: ScriptedResponse[]) {}

  async complete(
    system: string,
    messages: ProviderMessage[],
    options: CompleteOptions = {},
  ): Promise<Completion> {
    this.calls.push({
      system,
      messages: structuredClone(messages),
      options: structuredClone(options),
    });
    const scripted = this.responses[this.index++];
    const response = scripted instanceof Function ? scripted(options) : scripted;
    if (response instanceof Error) throw response;
    if (response instanceof Object) return response;
    if (response === undefined) throw new Error("missing scripted response");
    return { text: response, usage: { input_tokens: 10, output_tokens: 2 }, toolCalls: [] };
  }
}

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
