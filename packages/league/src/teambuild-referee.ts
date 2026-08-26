import { defaultPsDir } from "./paths.js";
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
import { actionForCandidateTeam, validateCandidate } from "./teambuild-validation.js";

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
