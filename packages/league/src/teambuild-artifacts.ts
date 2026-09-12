import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { defaultPsDir } from "./paths.js";
import { loadShowdown, showdownCommit } from "./showdown.js";
import { normalizeStageEvidence } from "./stage-evidence.js";
import {
  type TeamBuildArtifact,
  teamBuildArtifactSchema,
  teamBuildJournalRowSchema,
  TEAMBUILD_NOTEBOOK_LIMIT,
  TEAMBUILD_RATIONALE_LIMIT,
  type TeamBuildRefereeOptions,
  validateTeamBuildTask,
} from "./teambuild-protocol.js";
import { actionForCandidateTeam } from "./teambuild-validation.js";
import type { JsonValue } from "./types.js";
import type { TeamBuildView } from "./views.js";

export interface TeamBuildJournalEntry {
  artifact: TeamBuildArtifact;
  view: TeamBuildView;
  notebook: string;
}

export function decodeTeamBuildJournalRow(
  value: JsonValue,
  label = "team-build journal row",
): TeamBuildJournalEntry {
  const parsed = teamBuildJournalRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${label} is not a current team-build journal row: ${z.prettifyError(parsed.error)}`,
    );
  }
  const artifact = parsed.data.artifact;
  const provenance = artifact.task.provenance;
  if (
    provenance.source !== "draft-league" ||
    !Number.isSafeInteger(provenance.seriesIndex) ||
    Number(provenance.seriesIndex) < 0 ||
    !Number.isSafeInteger(provenance.entrant) ||
    Number(provenance.entrant) < 0 ||
    !Number.isSafeInteger(provenance.opponent) ||
    Number(provenance.opponent) < 0 ||
    artifact.task.objective.kind !== "matchup"
  ) {
    throw new Error(`${label} does not carry complete draft-league provenance and a valid action`);
  }
  return {
    artifact,
    notebook: artifact.evidence.notebook,
    view: {
      seriesIndex: provenance.seriesIndex!,
      entrant: provenance.entrant!,
      opponent: provenance.opponent!,
      brought: [...artifact.action.selected],
      sets: structuredClone(artifact.action.sets),
      rationale: artifact.evidence.rationale,
      attempts: artifact.attempts,
    },
  };
}

export interface ReplayedTeamBuildArtifact {
  artifact: TeamBuildArtifact;
  packed: string;
}

export function replayTeamBuildArtifact(
  value: JsonValue | TeamBuildArtifact,
  options: Pick<TeamBuildRefereeOptions, "psDir"> = {},
): ReplayedTeamBuildArtifact {
  const parsed = teamBuildArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`construction artifact is malformed: ${z.prettifyError(parsed.error)}`);
  }
  const artifact = parsed.data;
  const { task, action } = artifact;
  const psDir = options.psDir ?? defaultPsDir();
  validateTeamBuildTask(task);
  if (artifact.showdownCommit !== showdownCommit(psDir)) {
    throw new Error("construction artifact is not bound to this Showdown revision");
  }
  const normalized = normalizeStageEvidence(
    artifact.evidence.rationale,
    artifact.evidence.supplied.notebookUpdate ? artifact.evidence.notebook : undefined,
    {
      currentNotebook: task.notebook,
      rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
      notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
    },
  );
  if (
    artifact.evidence.rationale !== normalized.rationale ||
    (!artifact.evidence.supplied.rationale && artifact.evidence.rationale !== "") ||
    artifact.evidence.notebook !== normalized.notebook
  ) {
    throw new Error("construction artifact evidence is not normalized against its task notebook");
  }
  if (action.selected.length !== action.sets.length)
    throw new Error("construction artifact must bind each set to a selected roster id");
  const { Dex } = loadShowdown(psDir);
  const reconstructed = actionForCandidateTeam(
    Dex.forFormat(task.format),
    task,
    action.sets.map((view, index) => ({
      id: action.selected[index]!,
      item: view.item,
      ability: view.ability,
      nature: view.nature,
      moves: view.moves,
      evs: view.evs,
      note: view.note,
    })),
    psDir,
  );
  if (!isDeepStrictEqual(reconstructed, action)) {
    throw new Error(
      "construction packed species and sets do not exactly match action.selected and action.sets",
    );
  }
  return { artifact, packed: action.packed };
}
