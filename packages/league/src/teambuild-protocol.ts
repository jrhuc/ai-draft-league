import { z } from "zod";
import type { FranchiseMemory } from "./franchise-memory.js";
import type { ModelReasoningConfig } from "./providers.js";
import type { Rng } from "./random.js";
import { normalizeStageEvidence, type StageEvidence } from "./stage-evidence.js";
import type { AgentRunner } from "./agent-runtime.js";
import type { JsonObject } from "./types.js";
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
    id: trimmedString.describe("Board id of the Pokémon exactly as listed in your roster."),
    item: trimmedString.describe(
      'Canonical Showdown item name from the allowed list, or "" for no item.',
    ),
    ability: trimmedString.describe("Canonical Showdown ability name."),
    nature: trimmedString.describe("Canonical Showdown nature name."),
    moves: z
      .array(trimmedString.min(1, "must contain only non-empty strings"), {
        error: "must be an array",
      })
      .max(4)
      .describe("One to four canonical Showdown move names."),
    evs: statSpreadSchema.describe(
      "EV points per stat; whole numbers within the format's per-stat and total limits.",
    ),
    note: z
      .string({ error: "must be a string when supplied" })
      .default("")
      .describe("One line on this set's job; shown to your pilot in battle."),
  },
  { error: "must be an object" },
);

export type RawSet = z.infer<typeof rawSetSchema>;

export const teamBuildReplySchema = z.object(
  {
    team_plan: z
      .string({ error: "must be a string when supplied" })
      .describe(
        `2-5 sentences on how these six play together; shown to your pilot in battle. At most ${TEAMBUILD_RATIONALE_LIMIT} characters.`,
      )
      .optional(),
    notebook: z
      .string({ error: "must be a string when supplied" })
      .describe(
        `Replacement for your private notebook, at most ${TEAMBUILD_NOTEBOOK_LIMIT} characters after trimming; omit to keep the current notebook.`,
      )
      .optional(),
    sets: z
      .array(rawSetSchema, { error: "must be an array" })
      .describe("One entry per Pokémon you bring, in the order you want them listed."),
  },
  { error: "the reply must be one JSON object" },
);

export type TeamBuildSheetPolicy = "open" | "closed";

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
  task: TeamBuildTask;
  showdownCommit: string;
  action: TeamBuildAction;
  evidence: StageEvidence;
  attempts: number;
  createdAt: string;
}

export interface TeamBuildRefereeOptions {
  psDir?: string;
  attempts?: number;
  createdAt?: string;
}

export interface TeamBuildResult {
  packed: string;
  artifact: TeamBuildArtifact;
  view: TeamBuildView;
}

export interface TeamBuildOptions extends ModelReasoningConfig {
  runDir: string;
  psDir?: string;
  logDir: string;
  rng: Rng;
  createdAt?: string;
  signal?: AbortSignal;
  runAgent: AgentRunner;
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

export const teamBuildArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  task: taskSchema,
  showdownCommit: z.string(),
  action: actionSchema,
  evidence: evidenceSchema,
  attempts: z.number().int().nonnegative(),
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

export function canonicalTeamBuildTask(task: TeamBuildTask): TeamBuildTask {
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

export interface ParsedTeamBuild {
  sets: RawSet[];
  evidence: StageEvidence;
}

function replyIssueMessage(issue: z.core.$ZodIssue): string {
  const [head, index, ...rest] = issue.path;
  if (head === "sets" && Number.isInteger(index)) {
    const field = rest.length ? ` "${rest.join(".")}"` : "";
    return `set ${Number(index) + 1}${field} ${issue.message}`;
  }
  return issue.path.length ? `"${issue.path.join(".")}" ${issue.message}` : issue.message;
}

export function parseTeamBuildResponse(input: JsonObject, task: TeamBuildTask): ParsedTeamBuild {
  const reply = teamBuildReplySchema.safeParse(input);
  if (!reply.success) throw new Error(replyIssueMessage(reply.error.issues[0]!));
  const { sets, team_plan, notebook } = reply.data;
  const evidence = normalizeStageEvidence(team_plan, notebook, {
    currentNotebook: task.notebook,
    rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
    notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
  });
  return { sets, evidence };
}
