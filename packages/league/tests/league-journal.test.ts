import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  latestRosterVersion,
  readFranchiseCheckpoints,
  readFranchiseRosterVersion,
  readLeagueTransitions,
  recordLeagueTransition,
  storeFranchiseCheckpoint,
  storeFranchiseRosterVersion,
} from "../src/league-journal.js";
import { RUN_DATABASE_FILE } from "../src/run-database.js";

function scratch(t: { onTestFinished: (callback: () => void) => void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-league-journal-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function storeRosters(runDir: string, rosterVersion: number): void {
  storeFranchiseRosterVersion(
    runDir,
    [0, 1].map((entrant) => ({
      rosterVersion,
      entrant,
      teamName: `team-${entrant}`,
      budget: 10 - rosterVersion,
      roster: [{ id: `mon-${entrant}-${rosterVersion}`, name: `Mon ${entrant}`, cost: 1 }],
    })),
  );
}

function checkpoint(
  runDir: string,
  stage: "week" | "transactions",
  week: number,
  entrant: number,
  rosterVersion: number,
  notebook: string,
): void {
  storeFranchiseCheckpoint(runDir, {
    stage,
    week,
    entrant,
    model: `model-${entrant}`,
    rosterVersion,
    memory: { notebook },
    reasoning: "",
    fallback: false,
  });
}

test("league transitions persist one causal season path and ignore replays", (t) => {
  const runDir = scratch(t);
  const transitions = [
    { phase: "draft" as const, completedPicks: 0 },
    { phase: "draft" as const, completedPicks: 1 },
    { phase: "roundrobin" as const, week: 0, rosterVersion: 0 },
    { phase: "roundrobin" as const, week: 1, rosterVersion: 0 },
    { phase: "window" as const, week: 1, rosterVersion: 0 },
    { phase: "roundrobin" as const, week: 1, rosterVersion: 1 },
    { phase: "roundrobin" as const, week: 2, rosterVersion: 1 },
    { phase: "playoffs" as const, round: 0 },
    { phase: "playoffs" as const, round: 1 },
    { phase: "done" as const, champion: 0 },
  ];
  storeRosters(runDir, 0);
  for (const transition of transitions.slice(0, 4))
    recordLeagueTransition(runDir, transition!, 2, 2);
  for (const entrant of [0, 1]) checkpoint(runDir, "week", 1, entrant, 0, "week one");
  storeRosters(runDir, 1);
  for (const entrant of [0, 1]) checkpoint(runDir, "transactions", 1, entrant, 1, "reconciled");
  for (const transition of transitions.slice(4, 7))
    recordLeagueTransition(runDir, transition!, 2, 2);
  for (const entrant of [0, 1]) checkpoint(runDir, "week", 2, entrant, 1, "week two");
  for (const transition of transitions.slice(7)) recordLeagueTransition(runDir, transition!, 2, 2);
  for (const transition of transitions) recordLeagueTransition(runDir, transition, 2, 2);

  assert.deepEqual(readLeagueTransitions(runDir), transitions);
  assert.equal(latestRosterVersion(runDir), 1);
  assert.ok(fs.existsSync(path.join(runDir, RUN_DATABASE_FILE)));
});

test("league transitions reject a new state that crosses a season barrier", (t) => {
  const runDir = scratch(t);
  recordLeagueTransition(runDir, { phase: "draft", completedPicks: 0 }, 3, 2);
  storeRosters(runDir, 0);
  recordLeagueTransition(runDir, { phase: "roundrobin", week: 0, rosterVersion: 0 }, 3, 2);

  assert.throws(
    () => recordLeagueTransition(runDir, { phase: "roundrobin", week: 2, rosterVersion: 0 }, 3, 2),
    /invalid league transition/,
  );
  assert.deepEqual(readLeagueTransitions(runDir), [
    { phase: "draft", completedPicks: 0 },
    { phase: "roundrobin", week: 0, rosterVersion: 0 },
  ]);
});

test("a completed week cannot advance without every franchise memory checkpoint", (t) => {
  const runDir = scratch(t);
  recordLeagueTransition(runDir, { phase: "draft", completedPicks: 0 }, 2, 2);
  storeRosters(runDir, 0);
  recordLeagueTransition(runDir, { phase: "roundrobin", week: 0, rosterVersion: 0 }, 2, 2);
  recordLeagueTransition(runDir, { phase: "roundrobin", week: 1, rosterVersion: 0 }, 2, 2);
  checkpoint(runDir, "week", 1, 0, 0, "reviewed");

  assert.throws(
    () => recordLeagueTransition(runDir, { phase: "roundrobin", week: 2, rosterVersion: 0 }, 2, 2),
    /week 1 has 1\/2 franchise memory checkpoints/,
  );
});

test("a changed roster cannot leave its transaction window before memory reconciliation", (t) => {
  const runDir = scratch(t);
  recordLeagueTransition(runDir, { phase: "draft", completedPicks: 0 }, 2, 2);
  storeRosters(runDir, 0);
  recordLeagueTransition(runDir, { phase: "roundrobin", week: 0, rosterVersion: 0 }, 2, 2);
  recordLeagueTransition(runDir, { phase: "roundrobin", week: 1, rosterVersion: 0 }, 2, 2);
  for (const entrant of [0, 1]) checkpoint(runDir, "week", 1, entrant, 0, "reviewed");
  recordLeagueTransition(runDir, { phase: "window", week: 1, rosterVersion: 0 }, 2, 2);
  storeRosters(runDir, 1);
  assert.throws(
    () => recordLeagueTransition(runDir, { phase: "roundrobin", week: 1, rosterVersion: 1 }, 2, 2),
    /lacks transaction memory/,
  );
});

test("franchise memory checkpoints are queryable barriers and cannot be rewritten", (t) => {
  const runDir = scratch(t);
  const stored = {
    stage: "week" as const,
    week: 2,
    entrant: 1,
    model: "provider:model",
    rosterVersion: 1,
    memory: { notebook: "week two", rain: "speed notes" },
    reasoning: "retained the useful matchup facts",
    fallback: false,
  };
  storeFranchiseCheckpoint(runDir, stored);
  storeFranchiseCheckpoint(runDir, stored);

  assert.deepEqual(readFranchiseCheckpoints(runDir, "week", 2), [stored]);
  assert.throws(
    () => storeFranchiseCheckpoint(runDir, { ...stored, memory: { notebook: "changed" } }),
    /checkpoint is already committed differently/,
  );
});

test("franchise roster versions commit as immutable season snapshots", (t) => {
  const runDir = scratch(t);
  storeRosters(runDir, 0);
  storeRosters(runDir, 0);

  assert.deepEqual(readFranchiseRosterVersion(runDir, 0), [
    {
      rosterVersion: 0,
      entrant: 0,
      teamName: "team-0",
      budget: 10,
      roster: [{ id: "mon-0-0", name: "Mon 0", cost: 1 }],
    },
    {
      rosterVersion: 0,
      entrant: 1,
      teamName: "team-1",
      budget: 10,
      roster: [{ id: "mon-1-0", name: "Mon 1", cost: 1 }],
    },
  ]);
  assert.throws(
    () =>
      storeFranchiseRosterVersion(runDir, [
        {
          rosterVersion: 0,
          entrant: 0,
          teamName: "rewritten",
          budget: 10,
          roster: [{ id: "mon-0-0", name: "Mon 0", cost: 1 }],
        },
      ]),
    /already committed differently/,
  );
});
