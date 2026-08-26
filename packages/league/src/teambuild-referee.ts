import { defaultPsDir } from "./paths.js";
import { seededRng } from "./random.js";
import { loadShowdown, showdownCommit } from "./showdown.js";
import { noStageEvidence, type StageEvidence } from "./stage-evidence.js";
import {
  parseTeamBuildResponse,
  strictTeamBuildTask,
  type TeamBuildAction,
  type TeamBuildArtifact,
  type TeamBuildRefereeOptions,
  type TeamBuildSubmissionValidation,
  type TeamBuildTask,
} from "./teambuild-protocol.js";
import {
  actionForCandidateTeam,
  fallbackSets,
  legalMoves,
  repairSet,
  validateCandidate,
} from "./teambuild-validation.js";

function refereeArtifact(
  task: TeamBuildTask,
  psDir: string,
  action: TeamBuildAction | null,
  evidence: StageEvidence,
  problems: string[],
  options: TeamBuildRefereeOptions,
): TeamBuildArtifact {
  return {
    schemaVersion: 1,
    status: action ? "valid" : "invalid",
    task,
    executionPolicy: "strict",
    showdownCommit: showdownCommit(psDir),
    action,
    evidence,
    validation: {
      showdown: Boolean(action),
      repaired: false,
      repairs: [],
      problems,
    },
    attempts: options.attempts ?? 0,
    fallback: false,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

export function validateTeamBuildSubmission(
  task: TeamBuildTask,
  response: string,
  options: TeamBuildRefereeOptions = {},
): TeamBuildSubmissionValidation {
  let canonicalTask: TeamBuildTask;
  try {
    canonicalTask = strictTeamBuildTask(task);
  } catch (cause) {
    const problem = cause instanceof Error ? cause.message : String(cause);
    const rejectedTask = structuredClone(task);
    const evidence = noStageEvidence(task.notebook);
    const psDir = options.psDir ?? defaultPsDir();
    return {
      status: "rejected",
      problems: [problem],
      evidence,
      artifact: refereeArtifact(rejectedTask, psDir, null, evidence, [problem], options),
    };
  }
  const psDir = options.psDir ?? defaultPsDir();
  const parsed = parseTeamBuildResponse(response, canonicalTask);
  if (parsed.status === "rejected") {
    const evidence = noStageEvidence(canonicalTask.notebook);
    return {
      status: "rejected",
      problems: [parsed.error],
      evidence,
      artifact: refereeArtifact(canonicalTask, psDir, null, evidence, [parsed.error], options),
    };
  }
  const submission = parsed.data;
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonicalTask.format);
  const dex = Dex.mod(format.mod || "base");
  const owned = new Map(canonicalTask.constraint.candidates.map((mon) => [mon.id, mon]));
  const problems = validateCandidate(dex, canonicalTask.format, submission.sets, owned, psDir);
  if (problems.length) {
    return {
      status: "rejected",
      problems,
      evidence: submission.evidence,
      artifact: refereeArtifact(canonicalTask, psDir, null, submission.evidence, problems, options),
    };
  }
  try {
    const entries = submission.sets.map((set) => ({ mon: owned.get(set.id)!, set }));
    const action = actionForCandidateTeam(dex, canonicalTask, entries, psDir);
    const artifact = refereeArtifact(
      canonicalTask,
      psDir,
      action,
      submission.evidence,
      [],
      options,
    );
    return { status: "accepted", packed: action.packed, artifact };
  } catch (cause) {
    const problems = [cause instanceof Error ? cause.message : String(cause)];
    return {
      status: "rejected",
      problems,
      evidence: submission.evidence,
      artifact: refereeArtifact(canonicalTask, psDir, null, submission.evidence, problems, options),
    };
  }
}

export interface DeterministicTeamBuildFallback {
  response: string;
  validation: Extract<TeamBuildSubmissionValidation, { status: "accepted" }>;
}

export function deterministicTeamBuildFallback(
  task: TeamBuildTask,
  seed: string | number,
  options: TeamBuildRefereeOptions = {},
): DeterministicTeamBuildFallback {
  const canonical = strictTeamBuildTask(task);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonical.format);
  const dex = Dex.mod(format.mod || "base");
  const rules = Dex.formats.getRuleTable(format);
  const random = seededRng(seed);
  const selected = fallbackSets(
    canonical.constraint.candidates,
    canonical.constraint.teamSize,
    random,
    rules.evLimit ?? 508,
    32,
  );
  const owned = new Map(
    canonical.constraint.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const taken = new Set<string>();
  const repaired = selected.map((raw) => {
    const mon = owned.get(raw.id);
    if (!mon) throw new Error(`fallback selected unknown candidate ${JSON.stringify(raw.id)}`);
    const moves = legalMoves(dex, mon)
      .sort((left, right) => {
        const leftStatus = dex.moves.get(left).category === "Status" ? 1 : 0;
        const rightStatus = dex.moves.get(right).category === "Status" ? 1 : 0;
        return leftStatus - rightStatus || left.localeCompare(right);
      })
      .slice(0, 4);
    return repairSet(dex, mon, { ...raw, moves }, rules.evLimit ?? 508, 32, taken, random).set;
  });
  const response = JSON.stringify({
    team_plan: "deterministic legal fallback supplied by the connected referee",
    sets: repaired.map((set) => ({
      id: set.id,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: { ...set.evs },
      note: set.note,
    })),
  });
  const validation = validateTeamBuildSubmission(canonical, response, options);
  if (validation.status !== "accepted") {
    throw new Error(
      `deterministic strict fallback was rejected: ${validation.problems.join("; ")}`,
    );
  }
  return { response, validation };
}
