import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { runDraftLeague } from "../src/draftleague.js";
import { readLeagueTransitions } from "../src/league-journal.js";
import { loadSeriesRecords } from "../src/records.js";
import { commitRunArtifact, readRunArtifacts } from "../src/run-artifact-store.js";
import type { DraftTableRow } from "../src/views.js";

const MODELS = ["random", "random", "random", "random"];

test("a failed season review of an eliminated coach keeps the league short of done", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-playoffs-review-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  let table: DraftTableRow[] = [];
  await runDraftLeague(MODELS, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    throughWeek: 3,
    onEvent: (event) => {
      if (event.type === "draft" && event.draft.table) table = event.draft.table;
    },
  });
  assert.equal(loadSeriesRecords(recordsPath).length, 6, "the round robin is complete");
  const eliminated = table.at(-1)!.entrant;
  const contradiction = "stored under another ending";
  commitRunArtifact(directory, "season-review", String(eliminated).padStart(6, "0"), {
    timestamp: new Date().toISOString(),
    entrant: eliminated,
    model: "random",
    outcome: contradiction,
    summary: contradiction,
    did_well: contradiction,
    did_poorly: contradiction,
    would_change: contradiction,
  });

  await assert.rejects(
    runDraftLeague(MODELS, directory, { recordsPath, seed: 11, concurrency: 2, resume: true }),
    /season review artifact/,
  );
  assert.equal(loadSeriesRecords(recordsPath).length, 7, "the final is still played");
  assert.deepEqual(readLeagueTransitions(directory).at(-1), { phase: "playoffs", round: 1 });
});

test("a league stopped before the finalists' reviews resumes to done", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-playoffs-stop-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const controller = new AbortController();
  await runDraftLeague(MODELS, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "series-end" && event.record.stage === "playoff") controller.abort();
    },
  });
  assert.equal(readRunArtifacts(directory, "season-review").length, 2);
  assert.deepEqual(readLeagueTransitions(directory).at(-1), { phase: "playoffs", round: 1 });

  await runDraftLeague(MODELS, directory, { recordsPath, seed: 11, concurrency: 2, resume: true });
  assert.equal(readRunArtifacts(directory, "season-review").length, 4);
  assert.equal(readLeagueTransitions(directory).at(-1)?.phase, "done");
});
