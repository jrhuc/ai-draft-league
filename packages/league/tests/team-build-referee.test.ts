import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { loadBoard } from "../src/draft.js";
import { defaultPsDir } from "../src/paths.js";
import { submissionTool } from "../src/stage-agent.js";
import { teamBuildReplySchema } from "../src/teambuild-protocol.js";
import {
  replayTeamBuildArtifact,
  type TeamBuildTask,
  validateTeamBuildSubmission,
} from "../src/teambuild.js";
import type { JsonObject } from "../src/types.js";
import { asRecord } from "../src/value.js";
import { legalTeamReply } from "./fixtures/team-build.js";

const BOARD = loadBoard("regmc-202609");
const candidate = (id: string) => {
  const found = BOARD.mons.find((entry) => entry.id === id);
  assert.ok(found, `board is missing ${id}`);
  return found;
};
const CANDIDATES = [
  "garchomp",
  "incineroar",
  "sinistcha",
  "farigiraf",
  "whimsicott",
  "charizard-mega-y",
].map(candidate);
const CREATED_AT = "2026-03-17T00:00:00.000Z";
const OPTIONS = { psDir: defaultPsDir(), createdAt: CREATED_AT };

function task(): TeamBuildTask {
  return {
    id: "referee-fixture",
    model: "scripted:model",
    format: BOARD.format,
    sheetPolicy: "open",
    constraint: {
      kind: "draft-picks",
      id: "referee-roster",
      teamSize: 6,
      candidates: CANDIDATES,
    },
    objective: {
      kind: "matchup",
      stage: "roundrobin",
      opponent: { model: "scripted:rival", candidates: CANDIDATES },
      priorContext: [],
    },
    notebook: "Retain flexible speed control.",
    provenance: { source: "team-build-referee-test" },
  };
}

type Reply = JsonObject & {
  team_plan: string;
  sets: Array<{ item: string; ability: string; nature: string; moves: string[]; evs: JsonObject }>;
};

const reply = (): Reply =>
  legalTeamReply("Flexible speed control lets this team pressure both fast and slow modes.");

test("provider-free construction referee produces an exactly replayable artifact", () => {
  const artifact = validateTeamBuildSubmission(task(), reply(), OPTIONS);
  const replayed = replayTeamBuildArtifact(artifact, { psDir: defaultPsDir() });
  assert.deepEqual(replayed.artifact, artifact);
  assert.equal(replayed.packed, artifact.action.packed);
});

test("provider-free construction referee rejects malformed and illegal sets", () => {
  assert.throws(() => validateTeamBuildSubmission(task(), { sets: [] }, OPTIONS), /exactly 6/);

  for (const hp of ["2", -1, 1.5, 100]) {
    const invalid = reply();
    invalid.sets[0]!.evs.hp = hp;
    assert.throws(() => validateTeamBuildSubmission(task(), invalid, OPTIONS), /evs\.hp|in HP/);
  }
});

test("a set written in any spelling the dex resolves is stored under its canonical names", () => {
  const loose = reply();
  loose.sets[0]!.item = "life orb";
  loose.sets[0]!.ability = "rough skin";
  loose.sets[0]!.nature = "jolly";
  loose.sets[0]!.moves = ["earthquake", "dragonclaw", "Rock Slide", "protect"];
  const artifact = validateTeamBuildSubmission(task(), loose, OPTIONS);
  assert.deepEqual(artifact.action, validateTeamBuildSubmission(task(), reply(), OPTIONS).action);
  assert.equal(replayTeamBuildArtifact(artifact).packed, artifact.action.packed);
});

test("a name the dex does not know is rejected by quoting it and naming its kind", () => {
  const unknown = reply();
  unknown.sets[0]!.item = "Leftover";
  unknown.sets[0]!.ability = "Ruff Skin";
  unknown.sets[0]!.nature = "Speedy";
  unknown.sets[0]!.moves = ["Earthquak", "Protect"];
  assert.throws(
    () => validateTeamBuildSubmission(task(), unknown, OPTIONS),
    (error: Error) => {
      assert.deepEqual(error.message.split("\n"), [
        'Garchomp: "Leftover" is not an item in this format',
        'Garchomp: "Ruff Skin" is not an ability in this format',
        'Garchomp: "Speedy" is not a nature in this format',
        'Garchomp: "Earthquak" is not a move in this format',
      ]);
      return true;
    },
  );
});

test("the build reply offers a plan the pilot reads whole and no notebook", () => {
  const { properties } = submissionTool("submit_team", teamBuildReplySchema).parameters;
  assert.deepEqual(Object.keys(asRecord(properties)), ["team_plan", "sets"]);
  assert.equal(asRecord(asRecord(properties).team_plan).maxLength, 2000);

  const written = reply();
  written.notebook = "Scouting the builder believes it saved.";
  const { evidence } = validateTeamBuildSubmission(task(), written, OPTIONS);
  assert.equal(evidence.notebook, task().notebook);
  assert.equal(evidence.supplied.notebookUpdate, false);

  const maximal = reply();
  maximal.team_plan = "p".repeat(2000);
  assert.equal(
    validateTeamBuildSubmission(task(), maximal, OPTIONS).evidence.rationale,
    maximal.team_plan,
  );
  const oversized = reply();
  oversized.team_plan = "p".repeat(2001);
  assert.throws(
    () => validateTeamBuildSubmission(task(), oversized, OPTIONS),
    /^Error: "team_plan" must be at most 2000 characters$/,
  );
});

test("artifacts stored with a builder notebook or a clipped plan still replay", () => {
  const artifact = validateTeamBuildSubmission(task(), reply(), OPTIONS);

  const notebook = structuredClone(artifact);
  notebook.evidence.notebook = "Builder scouting notes.";
  notebook.evidence.supplied.notebookUpdate = true;
  assert.deepEqual(replayTeamBuildArtifact(notebook).artifact, notebook);

  const clipped = structuredClone(artifact);
  clipped.evidence.rationale = `${"p".repeat(2000)} [clipped]`;
  assert.deepEqual(replayTeamBuildArtifact(clipped).artifact, clipped);
});

test("semantic replay rejects action sets or roster ids that do not match packed bytes", () => {
  const artifact = validateTeamBuildSubmission(task(), reply(), OPTIONS);

  const changedSet = structuredClone(artifact);
  changedSet.action.sets[0]!.nature = "Adamant";
  assert.throws(() => replayTeamBuildArtifact(changedSet), /do not exactly match/);

  const changedSelection = structuredClone(artifact);
  changedSelection.action.selected[0] = "not-owned";
  assert.throws(() => replayTeamBuildArtifact(changedSelection), /not a board id on your roster/);
});
