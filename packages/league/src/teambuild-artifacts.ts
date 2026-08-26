import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { defaultPsDir } from "./paths.js";
import { loadShowdown, showdownCommit } from "./showdown.js";
import { normalizeStageEvidence } from "./stage-evidence.js";
import {
  type RawSet,
  STATS,
  type TeamBuildArtifact,
  type TeamBuildCandidate,
  teamBuildArtifactSchema,
  teamBuildJournalRowSchema,
  TEAMBUILD_NOTEBOOK_LIMIT,
  TEAMBUILD_RATIONALE_LIMIT,
  type TeamBuildRefereeOptions,
  validateTeamBuildTask,
} from "./teambuild-protocol.js";
import { packCandidateTeam } from "./teambuild-validation.js";
import { normalizePackedTeam, validateTeam } from "./teams.js";
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
  const artifact: TeamBuildArtifact = parsed.data.artifact;
  const provenance = artifact.task.provenance;
  if (
    provenance.source !== "draft-league" ||
    !Number.isSafeInteger(provenance.seriesIndex) ||
    Number(provenance.seriesIndex) < 0 ||
    !Number.isSafeInteger(provenance.entrant) ||
    Number(provenance.entrant) < 0 ||
    !Number.isSafeInteger(provenance.opponent) ||
    Number(provenance.opponent) < 0 ||
    artifact.task.objective.kind !== "matchup" ||
    !artifact.action
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
  const parsedArtifact = parsed.data;
  const artifact: TeamBuildArtifact = parsedArtifact;
  const task = parsedArtifact.task;
  const action = parsedArtifact.action;
  const psDir = options.psDir ?? defaultPsDir();
  validateTeamBuildTask(task);
  if (
    artifact.executionPolicy !== task.executionPolicy ||
    artifact.showdownCommit !== showdownCommit(psDir)
  ) {
    throw new Error(
      "construction artifact is not bound to its task, policy, and Showdown revision",
    );
  }
  if (
    !Number.isSafeInteger(artifact.attempts) ||
    artifact.attempts < 0 ||
    artifact.validation.problems.length
  ) {
    throw new Error("construction artifact validation state is inconsistent");
  }
  const normalizedRationale = normalizeStageEvidence(artifact.evidence.rationale, undefined, {
    currentNotebook: task.notebook,
    rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
    notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
  }).rationale;
  const normalizedNotebook = normalizeStageEvidence(
    undefined,
    artifact.evidence.supplied.notebookUpdate ? artifact.evidence.notebook : undefined,
    {
      currentNotebook: task.notebook,
      rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
      notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
    },
  ).notebook;
  if (
    artifact.evidence.rationale !== normalizedRationale ||
    (!artifact.evidence.supplied.rationale &&
      !artifact.fallback &&
      artifact.evidence.rationale !== "") ||
    artifact.evidence.notebook !== normalizedNotebook
  ) {
    throw new Error("construction artifact evidence is not normalized against its task notebook");
  }
  if (
    task.constraint.teamSize !== 6 ||
    action.selected.length !== 6 ||
    action.sets.length !== 6 ||
    new Set(action.selected).size !== 6
  ) {
    throw new Error("construction artifact must select exactly six unique roster ids and sets");
  }
  const candidates = new Map(
    task.constraint.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const { Dex, Teams } = loadShowdown(psDir);
  const format = Dex.formats.get(task.format);
  const dex = Dex.mod(format.mod || "base");
  const entries: Array<{ mon: TeamBuildCandidate; set: RawSet }> = [];
  for (const [index, id] of action.selected.entries()) {
    const mon = candidates.get(id);
    const view = action.sets[index]!;
    if (!mon) {
      throw new Error(
        `construction selected roster id ${JSON.stringify(id)} that its task does not own`,
      );
    }
    const spriteId = dex.species.get(mon.forme ?? mon.species).spriteid;
    if (view.species !== mon.name || view.spriteId !== spriteId) {
      throw new Error(
        `construction set ${index + 1} is not bound to selected roster id ${JSON.stringify(id)}`,
      );
    }
    entries.push({
      mon,
      set: {
        id,
        item: view.item,
        ability: view.ability,
        nature: view.nature,
        moves: [...view.moves],
        evs: { ...view.evs },
        note: view.note ?? "",
      },
    });
  }
  const expectedRepairs = action.selected.flatMap((id, index) =>
    action.sets[index]!.repairs.map((repair) => `${id}: ${repair}`),
  );
  if (
    artifact.validation.repaired !== expectedRepairs.length > 0 ||
    !isDeepStrictEqual(artifact.validation.repairs, expectedRepairs) ||
    action.sets.some((set) => set.repaired !== set.repairs.length > 0)
  ) {
    throw new Error("construction artifact repair metadata is inconsistent with its action");
  }
  if (
    artifact.executionPolicy === "strict" &&
    (artifact.fallback || artifact.validation.repaired || action.sets.some((set) => set.repaired))
  ) {
    throw new Error("strict construction artifact cannot contain a fallback or repaired action");
  }
  const unpacked = Teams.unpack(action.packed);
  if (unpacked?.length !== 6) {
    throw new Error("construction packed team must unpack to exactly six sets");
  }
  if (Teams.pack(unpacked) !== action.packed) {
    throw new Error("construction packed team is not an exact Showdown pack/unpack normalization");
  }
  if (normalizePackedTeam(action.packed, psDir, task.format) !== action.packed) {
    throw new Error("construction packed team is not normalized for its format");
  }
  const reconstructed = packCandidateTeam(dex, entries, psDir);
  if (reconstructed !== action.packed) {
    throw new Error(
      "construction packed species and sets do not exactly match action.selected and action.sets",
    );
  }
  for (const [index, set] of unpacked.entries()) {
    const { mon, set: view } = entries[index]!;
    const species = dex.species.get(mon.species).name;
    const evs = Object.fromEntries(STATS.map((stat) => [stat, set.evs?.[stat] ?? 0]));
    const ivs = Object.fromEntries(STATS.map((stat) => [stat, set.ivs?.[stat] ?? 31]));
    if (
      set.name !== species ||
      set.species !== species ||
      set.item !== view.item ||
      set.ability !== view.ability ||
      set.nature !== view.nature ||
      !isDeepStrictEqual(set.moves, view.moves) ||
      !isDeepStrictEqual(evs, view.evs) ||
      Object.values(ivs).some((iv) => iv !== 31) ||
      (set.gender ?? "") !== "" ||
      set.level !== 50 ||
      set.shiny ||
      set.teraType
    ) {
      throw new Error(
        `construction packed set ${index + 1} is inconsistent with its exact registered set`,
      );
    }
  }
  validateTeam(action.packed, task.format, psDir);
  return { artifact, packed: action.packed };
}
