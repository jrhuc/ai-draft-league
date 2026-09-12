export type Pid = "p1" | "p2";
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type ExperimentMode = "rotation" | "exhibition" | "tournament" | "draft";

export type ContributorAttribution = {
  provider: "github";
  subject: string;
  login: string;
};

export interface PlayerOptions {
  name: string;
  team: string;
}
export interface BattleMoveRequest extends JsonObject {
  move: string;
  id?: string | undefined;
  pp?: number | undefined;
  maxpp?: number | undefined;
  target?: string | undefined;
  disabled?: string | boolean | undefined;
}

export interface BattleActiveRequest extends JsonObject {
  moves: BattleMoveRequest[];
  canMegaEvo?: boolean | undefined;
  trapped?: boolean | undefined;
}

export interface BattlePokemonRequest extends JsonObject {
  ident?: string | undefined;
  details?: string | undefined;
  condition?: string | undefined;
  active?: boolean | undefined;
  commanding?: boolean | undefined;
  reviving?: boolean | undefined;
  item?: string | undefined;
  ability?: string | undefined;
  moves?: string[] | undefined;
  stats?: JsonObject | undefined;
}

export interface BattleSideRequest extends JsonObject {
  name?: string | undefined;
  id?: string | undefined;
  pokemon?: BattlePokemonRequest[] | undefined;
}

export interface BattleRequest extends JsonObject {
  wait?: boolean | undefined;
  teamPreview?: boolean | undefined;
  maxChosenTeamSize?: number | undefined;
  forceSwitch?: boolean[] | undefined;
  active?: Array<BattleActiveRequest | null> | undefined;
  side?: BattleSideRequest | undefined;
  timer?: {
    turnSeconds?: number;
    seconds?: number;
  };
}

export type TimerScale = number | "off";

export type SubmissionSource =
  | "model"
  | "automatic"
  | "random"
  | "model-default"
  | "simulator-default"
  | "timer-default";

export interface ActionSubmission {
  submissionId: string;
  choice: string;
  source: SubmissionSource;
}

export type SubmissionOutcome = "accepted" | "rejected";

export interface AgentContext {
  povLines: string[];
  error?: string;
}

export interface SubmissionContext extends AgentContext {
  submissionId: string;
}

export interface BattleAgent {
  submit(
    request: BattleRequest,
    context: SubmissionContext,
  ): Promise<ActionSubmission | null> | ActionSubmission | null;
  resolveSubmission(
    submission: ActionSubmission,
    outcome: SubmissionOutcome,
    showdownError?: string,
  ): void;
  observe(lines: string[]): Promise<void> | void;
  abandonDecision?(): void;
}

export interface BattleOutcome {
  winner: string | null;
  turns: number;
  log: string[];
  pov: Record<Pid, string[]>;
  errors: Record<Pid, number>;
  simulatorSubstitutions: Record<Pid, number>;
  timerAutodefaults: Record<Pid, number>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}
