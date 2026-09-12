import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { loadBoard } from "../src/draft.js";
import { defaultPsDir } from "../src/paths.js";
import {
  replayTeamBuildArtifact,
  type TeamBuildTask,
  validateTeamBuildSubmission,
} from "../src/teambuild.js";
import type { JsonObject } from "../src/types.js";
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
      kind: "frozen-candidate-pool",
      id: "referee-pool",
      teamSize: 6,
      candidates: CANDIDATES,
    },
    objective: { kind: "general", brief: "Build a coherent team." },
    notebook: "Retain flexible speed control.",
    provenance: { source: "team-build-referee-test" },
  };
}

type Reply = { notebook?: string; sets: Array<{ item: string; evs: { hp: unknown } }> };

const reply = (): Reply & JsonObject =>
  legalTeamReply("Flexible speed control lets this team pressure both fast and slow modes.");

test("provider-free construction referee produces an exactly replayable artifact", () => {
  const artifact = validateTeamBuildSubmission(task(), reply(), { ...OPTIONS, attempts: 1 });
  const replayed = replayTeamBuildArtifact(artifact, { psDir: defaultPsDir() });
  assert.deepEqual(replayed.artifact, artifact);
  assert.equal(replayed.packed, artifact.action.packed);
});

test("provider-free construction referee rejects malformed and illegal sets", () => {
  assert.throws(() => validateTeamBuildSubmission(task(), { sets: [] }, OPTIONS), /exactly 6/);

  const illegal = reply();
  illegal.sets[0]!.item = "Not An Item";
  assert.throws(
    () => validateTeamBuildSubmission(task(), illegal, OPTIONS),
    /canonical Showdown name/,
  );

  for (const hp of ["2", -1, 1.5, 100]) {
    const invalid = reply();
    invalid.sets[0]!.evs.hp = hp;
    assert.throws(() => validateTeamBuildSubmission(task(), invalid, OPTIONS), /evs\.hp|in HP/);
  }

  const oversized = reply();
  oversized.notebook = "x".repeat(4001);
  assert.throws(() => validateTeamBuildSubmission(task(), oversized, OPTIONS), /notebook.*4000/);

  const maximal = reply();
  maximal.notebook = "x".repeat(4000);
  assert.equal(
    validateTeamBuildSubmission(task(), maximal, OPTIONS).evidence.notebook,
    maximal.notebook,
  );
});

test("semantic replay rejects action sets or roster ids that do not match packed bytes", () => {
  const artifact = validateTeamBuildSubmission(task(), reply(), OPTIONS);

  const changedSet = structuredClone(artifact);
  changedSet.action.sets[0]!.nature = "Adamant";
  assert.throws(() => replayTeamBuildArtifact(changedSet), /do not exactly match/);

  const changedSelection = structuredClone(artifact);
  changedSelection.action.selected[0] = "not-owned";
  assert.throws(() => replayTeamBuildArtifact(changedSelection), /frozen candidate pool/);
});
