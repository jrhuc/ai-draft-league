import { defaultPsDir } from "./paths.js";
import { loadShowdown, showdownCommit } from "./showdown.js";
import {
  canonicalTeamBuildTask,
  parseTeamBuildResponse,
  type TeamBuildArtifact,
  type TeamBuildRefereeOptions,
  type TeamBuildTask,
  validateTeamBuildTask,
} from "./teambuild-protocol.js";
import { actionForCandidateTeam } from "./teambuild-validation.js";
import type { JsonObject } from "./types.js";

export function validateTeamBuildSubmission(
  task: TeamBuildTask,
  input: JsonObject,
  options: TeamBuildRefereeOptions = {},
): TeamBuildArtifact {
  const psDir = options.psDir ?? defaultPsDir();
  validateTeamBuildTask(task);
  const canonicalTask = canonicalTeamBuildTask(task);
  const { sets, evidence } = parseTeamBuildResponse(input, canonicalTask);
  const { Dex } = loadShowdown(psDir);
  const action = actionForCandidateTeam(Dex.forFormat(task.format), canonicalTask, sets, psDir);
  return {
    schemaVersion: 1,
    task: canonicalTask,
    showdownCommit: showdownCommit(psDir),
    action,
    evidence,
    attempts: options.attempts ?? 0,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}
