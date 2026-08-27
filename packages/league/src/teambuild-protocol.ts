import { z } from "zod";
import type { FranchiseMemory } from "./franchise-memory.js";
import type { ModelReasoningConfig, ReasoningLevel } from "./providers.js";
import type { Rng } from "./random.js";
import { normalizeStageEvidence, type StageEvidence } from "./stage-evidence.js";
import { isText, replyJsonObject } from "./value.js";
import type { Provider } from "./types.js";
import type { TeamBuildSetView, TeamBuildView } from "./views.js";

export const TEAMBUILD_RATIONALE_LIMIT = 2_000;
export const TEAMBUILD_NOTEBOOK_LIMIT = 4_000;
export const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;

const evSchema = z
  .number({ error: "must be a finite, safe, non-negative integer" })
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0,
    "must be a finite, safe, non-negative integer",
  );

const statSpreadSchema = z.object(
  { hp: evSchema, atk: evSchema, def: evSchema, spa: evSchema, spd: evSchema, spe: evSchema },
  { error: "must be an object" },
);

export type StatSpread = z.infer<typeof statSpreadSchema>;

const trimmedString = z
  .string({ error: "must be a string" })
  .refine((value) => value === value.trim(), "must not have surrounding whitespace");

const rawSetSchema = z.object(
  {
    id: trimmedString,
    item: trimmedString,
    ability: trimmedString,
    nature: trimmedString,
    moves: z.array(trimmedString.min(1, "must contain only non-empty strings"), {
      error: "must be an array",
    }),
    evs: statSpreadSchema,
    note: z.string({ error: "must be a string when supplied" }).default(""),
  },
  { error: "must be an object" },
);

export type RawSet = z.infer<typeof rawSetSchema>;

const teamBuildReplySchema = z.object(
  {
    team_plan: z.string({ error: "must be a string when supplied" }).optional(),
    notebook: z.string({ error: "must be a string when supplied" }).optional(),
    sets: z.array(rawSetSchema, { error: "must be an array" }),
  },
  { error: "the reply must be one JSON object" },
);

export type TeamBuildSheetPolicy = "open" | "closed";
export type TeamBuildExecutionPolicy = "league-resilient" | "strict";

export interface TeamBuildCandidate {
  id: string;
  name: string;
  species: string;
  forme?: string;
  item?: string;
  base: string;
  types: string[];
}

interface TeamBuildConstraintBase {
  id: string;
  teamSize: number;
  candidates: readonly TeamBuildCandidate[];
}

export type TeamBuildConstraint =
  | ({ kind: "draft-picks" } & TeamBuildConstraintBase)
  | ({ kind: "frozen-candidate-pool" } & TeamBuildConstraintBase);

export type TeamBuildObjective =
  | {
      kind: "matchup";
      stage: "roundrobin" | "playoff";
      opponent: { model: string; candidates: readonly TeamBuildCandidate[] };
      priorContext: readonly string[];
    }
  | { kind: "general"; brief?: string };

export interface TeamBuildTaskProvenance {
  source: string;
  seed?: string | number;
  parentRunId?: string;
  seriesIndex?: number;
  entrant?: number;
  opponent?: number;
}

export interface TeamBuildTask {
  id: string;
  model: string;
  format: string;
  sheetPolicy: TeamBuildSheetPolicy;
  executionPolicy?: TeamBuildExecutionPolicy;
  constraint: TeamBuildConstraint;
  objective: TeamBuildObjective;
  notebook: string;
  provenance: TeamBuildTaskProvenance;
}

export interface TeamBuildAction {
  selected: string[];
  packed: string;
  sets: TeamBuildSetView[];
}

export interface TeamBuildArtifact {
  schemaVersion: 1;
  status: "valid" | "invalid";
  task: TeamBuildTask;
  executionPolicy: TeamBuildExecutionPolicy;
  showdownCommit: string;
  action: TeamBuildAction | null;
  evidence: StageEvidence;
  validation: {
    showdown: boolean;
    repaired: boolean;
    repairs: string[];
    problems: string[];
  };
  attempts: number;
  fallback: boolean;
  createdAt: string;
}

export interface LeagueTeamBuildResult {
  packed: string | null;
  artifact: TeamBuildArtifact;
}

export interface TeamBuildRefereeOptions {
  psDir?: string;
  attempts?: number;
  createdAt?: string;
}

export type TeamBuildSubmissionValidation =
  | { status: "accepted"; packed: string; artifact: TeamBuildArtifact }
  | {
      status: "rejected";
      problems: string[];
      evidence: StageEvidence;
      artifact: TeamBuildArtifact;
    };

export interface TeamBuildResult {
  packed: string;
  artifact: TeamBuildArtifact;
  view: TeamBuildView;
}

export interface TeamBuildOptions extends ModelReasoningConfig {
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  logDir: string;
  rng: Rng;
  createdAt?: string;
  signal?: AbortSignal;
  makeTeambuildProvider?: (
    spec: string,
    apiKey: string | undefined,
    reasoning: ReasoningLevel | undefined,
  ) => Provider;
  memory?: FranchiseMemory;
}

export interface TeamBuildRequest {
  seriesIndex: number;
  entrant: number;
  opponent: number;
  stage: "roundrobin" | "playoff";
  model: string;
  opponentModel: string;
  franchiseName: string;
  roster: TeamBuildCandidate[];
  opponentRoster: TeamBuildCandidate[];
  memory: FranchiseMemory;
  playoffContext: string[];
  format: string;
  sheetPolicy?: TeamBuildSheetPolicy;
}

const candidateSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    species: z.string(),
    forme: z.string().optional(),
    item: z.string().optional(),
    base: z.string(),
    types: z.array(z.string()),
  })
  .transform((candidate): TeamBuildCandidate => candidate);

const constraintBaseSchema = {
  id: z.string(),
  teamSize: z.number(),
  candidates: z.array(candidateSchema),
};

const constraintSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("draft-picks"), ...constraintBaseSchema }),
  z.strictObject({ kind: z.literal("frozen-candidate-pool"), ...constraintBaseSchema }),
]);

const objectiveSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("matchup"),
      stage: z.union([z.literal("roundrobin"), z.literal("playoff")]),
      opponent: z.strictObject({ model: z.string(), candidates: z.array(candidateSchema) }),
      priorContext: z.array(z.string()),
    }),
    z.strictObject({ kind: z.literal("general"), brief: z.string().optional() }),
  ])
  .transform((objective): TeamBuildObjective => objective);

const provenanceSchema = z
  .object({
    source: z.string(),
    seed: z.union([z.string(), z.number()]).optional(),
    parentRunId: z.string().optional(),
    seriesIndex: z.number().optional(),
    entrant: z.number().optional(),
    opponent: z.number().optional(),
  })
  .transform((provenance): TeamBuildTaskProvenance => provenance);

const taskSchema = z.strictObject({
  id: z.string(),
  model: z.string(),
  format: z.string(),
  sheetPolicy: z.union([z.literal("open"), z.literal("closed")]),
  executionPolicy: z.union([z.literal("league-resilient"), z.literal("strict")]),
  constraint: constraintSchema,
  objective: objectiveSchema,
  notebook: z.string(),
  provenance: provenanceSchema,
});

const actionSetSchema = z.strictObject({
  species: z.string(),
  spriteId: z.string(),
  item: z.string(),
  ability: z.string(),
  nature: z.string(),
  moves: z.array(z.string()),
  evs: statSpreadSchema,
  note: z.string(),
  repaired: z.boolean(),
  repairs: z.array(z.string()),
});

const actionSchema = z.strictObject({
  selected: z.array(z.string()),
  packed: z.string(),
  sets: z.array(actionSetSchema),
});

const evidenceSchema = z.strictObject({
  rationale: z.string(),
  notebook: z.string(),
  supplied: z.strictObject({ rationale: z.boolean(), notebookUpdate: z.boolean() }),
});

export const teamBuildArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("valid"),
  task: taskSchema,
  executionPolicy: z.union([z.literal("league-resilient"), z.literal("strict")]),
  showdownCommit: z.string(),
  action: actionSchema,
  evidence: evidenceSchema,
  validation: z.strictObject({
    showdown: z.literal(true),
    repaired: z.boolean(),
    repairs: z.array(z.string()),
    problems: z.array(z.string()),
  }),
  attempts: z.number(),
  fallback: z.boolean(),
  createdAt: z.string(),
});

export const teamBuildJournalRowSchema = z.strictObject({ artifact: teamBuildArtifactSchema });

function canonicalCandidate(candidate: TeamBuildCandidate): TeamBuildCandidate {
  const { id, name, species, base, types } = candidate;
  const canonical: TeamBuildCandidate = { id, name, species, base, types: [...types] };
  if (candidate.forme !== undefined) canonical.forme = candidate.forme;
  if (candidate.item !== undefined) canonical.item = candidate.item;
  return canonical;
}

export function canonicalTeamBuildTask(
  task: TeamBuildTask,
  executionPolicy: TeamBuildExecutionPolicy,
): TeamBuildTask {
  const candidates = task.constraint.candidates.map(canonicalCandidate);
  const constraint: TeamBuildConstraint = {
    kind: task.constraint.kind,
    id: task.constraint.id,
    teamSize: task.constraint.teamSize,
    candidates,
  };
  const objective: TeamBuildObjective =
    task.objective.kind === "general"
      ? { ...task.objective }
      : {
          kind: "matchup",
          stage: task.objective.stage,
          opponent: {
            model: task.objective.opponent.model,
            candidates: task.objective.opponent.candidates.map(canonicalCandidate),
          },
          priorContext: [...task.objective.priorContext],
        };
  return {
    id: task.id,
    model: task.model,
    format: task.format,
    sheetPolicy: task.sheetPolicy,
    executionPolicy,
    constraint,
    objective,
    notebook: task.notebook,
    provenance: { ...task.provenance },
  };
}

export function validateTeamBuildTask(task: TeamBuildTask): void {
  const { candidates, teamSize } = task.constraint;
  if (task.sheetPolicy !== "open" && task.sheetPolicy !== "closed") {
    throw new Error("team-build sheetPolicy must be open or closed");
  }
  if (
    task.executionPolicy !== undefined &&
    task.executionPolicy !== "league-resilient" &&
    task.executionPolicy !== "strict"
  ) {
    throw new Error("team-build executionPolicy must be league-resilient or strict");
  }
  if (!Number.isSafeInteger(teamSize) || teamSize < 1) {
    throw new Error("team-build constraint teamSize must be a positive integer");
  }
  const ids = candidates.map((candidate) => candidate.id);
  if (ids.some((id) => !id)) throw new Error("every team-build candidate needs a non-empty id");
  if (new Set(ids).size !== ids.length) throw new Error("team-build candidate ids must be unique");
  const distinct = new Set(candidates.map((candidate) => candidate.base)).size;
  if (distinct < teamSize) {
    throw new Error(
      `team-build constraint ${JSON.stringify(task.constraint.id)} has ${distinct} distinct species, fewer than teamSize ${teamSize}`,
    );
  }
}

export function strictTeamBuildTask(task: TeamBuildTask): TeamBuildTask {
  validateTeamBuildTask(task);
  if (task.executionPolicy !== undefined && task.executionPolicy !== "strict") {
    throw new Error("the team-build referee accepts only strict executionPolicy tasks");
  }
  return canonicalTeamBuildTask(task, "strict");
}

export interface ParsedTeamBuild {
  sets: RawSet[];
  evidence: StageEvidence;
}

export type ParsedTeamBuildResult =
  | { status: "accepted"; data: ParsedTeamBuild }
  | { status: "rejected"; error: string };

function replyIssueMessage(issue: z.core.$ZodIssue): string {
  const [head, index, ...rest] = issue.path;
  if (head === "sets" && Number.isInteger(index)) {
    const field = rest.length ? ` "${rest.join(".")}"` : "";
    return `set ${Number(index) + 1}${field} ${issue.message}`;
  }
  return issue.path.length ? `"${issue.path.join(".")}" ${issue.message}` : issue.message;
}

export function parseTeamBuildResponse(
  response: string,
  task: TeamBuildTask,
): ParsedTeamBuildResult {
  const json = replyJsonObject(response);
  if (isText(json)) return { status: "rejected", error: json };
  const reply = teamBuildReplySchema.safeParse(json);
  if (!reply.success)
    return { status: "rejected", error: replyIssueMessage(reply.error.issues[0]!) };
  const { sets, team_plan, notebook } = reply.data;
  const teamSize = task.constraint.teamSize;
  if (sets.length !== teamSize) {
    return {
      status: "rejected",
      error: `"sets" must hold exactly ${teamSize} entries, not ${sets.length}`,
    };
  }
  const owned = new Map(task.constraint.candidates.map((mon) => [mon.id, mon]));
  const used = new Set<string>();
  for (const { id } of sets) {
    if (!owned.has(id)) {
      return {
        status: "rejected",
        error:
          task.constraint.kind === "draft-picks"
            ? `"${id}" is not a board id on your roster`
            : `"${id}" is not an id in the frozen candidate pool`,
      };
    }
    if (used.has(id)) {
      return {
        status: "rejected",
        error:
          teamSize === 6
            ? `"${id}" appears twice; bring six different Pokémon`
            : `"${id}" appears twice; choose ${teamSize} different Pokémon`,
      };
    }
    used.add(id);
  }
  const evidence = normalizeStageEvidence(team_plan, notebook, {
    currentNotebook: task.notebook,
    rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
    notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
  });
  return { status: "accepted", data: { sets, evidence } };
}
