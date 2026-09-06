import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { runDraftLeague } from "../src/draftleague.js";
import { readFranchiseRosterVersion } from "../src/league-journal.js";
import { defaultPsDir } from "../src/paths.js";
import { readRunArtifacts } from "../src/run-artifact-store.js";
import {
  parseTradeDecision,
  readTradeWindowArtifact,
  readTransactionEvents,
  runTradeWindow,
} from "../src/trade-window.js";
import type { Completion, JsonObject } from "../src/types.js";
import { asRecord } from "../src/value.js";
import { BOARD, transactionState } from "./draft-test-helpers.js";

test("an interrupted draft resumes only from its committed database state", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-database-resume-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  await assert.rejects(
    runDraftLeague(["random", "random"], directory, {
      recordsPath,
      seed: 101,
      draftOnly: true,
      onEvent: (event) => {
        if (event.type === "draft" && event.draft.picks.length === 1) {
          throw new Error("interrupt after first committed pick");
        }
      },
    }),
    /interrupt after first committed pick/,
  );
  const config: JsonObject = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(config, "rosters"), false);
  assert.equal(readRunArtifacts(directory, "draft-pick").length, 1);

  await assert.rejects(
    runDraftLeague(["random", "random"], directory, {
      recordsPath,
      seed: 102,
      draftOnly: true,
      resume: true,
    }),
    /stored config does not match/,
  );
  const picks: number[] = [];
  const resumed = await runDraftLeague(["random", "random"], directory, {
    recordsPath,
    seed: 101,
    draftOnly: true,
    resume: true,
    onEvent: (event) => {
      if (event.type === "draft" && event.draft.phase === "draft")
        picks.push(event.draft.picks.length);
    },
  });
  assert.deepEqual(resumed, []);
  assert.equal(readRunArtifacts(directory, "draft-pick").length, BOARD.picks * 2);
  assert.equal(readFranchiseRosterVersion(directory, 0).length, 2);
  assert.equal(
    Math.max(...picks),
    BOARD.picks * 2,
    "the replayed pick is counted once in the live draft view",
  );
});

test("a transaction window resumes after its last committed event without repeating decisions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-resume-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = transactionState();
  state.models = ["test:second", "test:first"];
  const before = JSON.stringify(state);
  const owned = new Set(state.rosters.flatMap((roster) => roster.map((candidate) => candidate.id)));
  let swap: { drop: string; add: string } | undefined;
  for (const drop of state.rosters[0]!) {
    for (const add of BOARD.mons) {
      if (owned.has(add.id)) continue;
      const parsed = parseTradeDecision(
        JSON.stringify({ swaps: [{ drop: drop.id, add: add.id }] }),
        state,
        0,
      );
      if (!(parsed instanceof Object) || !parsed.swaps[0]) continue;
      swap = parsed.swaps[0];
      break;
    }
    if (swap) break;
  }
  assert.ok(swap, "fixture needs one legal swap");
  const options = { runDir: directory, psDir: defaultPsDir(), tradesAllowed: 0 };
  const position = { afterWeek: 1, index: 0, count: 1 };
  const calls: string[] = [];
  await assert.rejects(
    runTradeWindow(state, {
      ...options,
      position,
      makeTradeProvider: (spec) => ({
        complete(): Promise<Completion> {
          calls.push(spec);
          if (spec === "test:second") throw new Error("provider outage");
          return Promise.resolve({
            text: JSON.stringify({ swaps: [] }),
            usage: {},
            toolCalls: [],
          });
        },
      }),
    }),
    /trade window cannot continue/,
  );
  assert.deepEqual(calls, ["test:first", "test:second"]);
  assert.equal(readTransactionEvents(directory, 1).length, 1, "the first decision is committed");
  assert.equal(JSON.stringify(state), before, "a failed window does not mutate caller state");

  const artifact = await runTradeWindow(state, {
    ...options,
    position,
    makeTradeProvider: (spec) => ({
      complete(): Promise<Completion> {
        calls.push(spec);
        if (spec === "test:first") throw new Error("a committed decision is not asked again");
        return Promise.resolve({
          text: JSON.stringify({ swaps: [swap] }),
          usage: {},
          toolCalls: [],
        });
      },
    }),
  });
  assert.deepEqual(calls, ["test:first", "test:second", "test:second"]);
  assert.equal(readTransactionEvents(directory, 1).length, 2);
  assert.deepEqual(readTradeWindowArtifact(directory, 1), artifact);
  assert.ok(state.rosters[0]!.some((candidate) => candidate.id === swap.add));

  const replayed = await runTradeWindow(transactionState(), {
    ...options,
    position,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        throw new Error("a completed window must not call providers");
      },
    }),
  });
  assert.deepEqual(replayed, artifact);
});

test("a two-coach league plays one week and a single final", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-two-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = await runDraftLeague(["random", "random"], directory, {
    recordsPath: path.join(directory, "results.jsonl"),
    seed: 5,
    concurrency: 1,
    closedSheets: true,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.stage, "roundrobin");
  assert.equal(rows[1]!.stage, "playoff");
  assert.ok(rows[1]!.winner, "a playoff series must produce a winner");
  const config: JsonObject = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.equal(config.closed_sheets, true);
  assert.deepEqual(
    config.transactions,
    [{ after_week: 1, trades_allowed: 2 }],
    "short leagues keep only the default windows that fit their round robin",
  );
  for (const row of rows)
    assert.equal(row.closed_sheets, true, "series records carry the sheet rule");
  for (const build of readRunArtifacts(directory, "teambuild")) {
    const task = asRecord(asRecord(build.value).artifact).task;
    assert.equal(asRecord(task).sheetPolicy, "closed");
  }
  const gameLog = fs.readFileSync(
    path.join(directory, "series", String(rows[0]!.series_id), "game-1.log"),
    "utf8",
  );
  assert.ok(!gameLog.includes("|showteam|"), "closed-sheet games publish no team sheets");
});

test("a completed database series recreates a missing result projection without replaying", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-result-projection-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const original = await runDraftLeague(["random", "random"], directory, {
    recordsPath,
    seed: 37,
    concurrency: 1,
  });
  const projected = fs.readFileSync(recordsPath, "utf8").trim().split("\n");
  projected.pop();
  fs.writeFileSync(recordsPath, `${projected.join("\n")}\n`);

  const resumed = await runDraftLeague(["random", "random"], directory, {
    recordsPath,
    seed: 37,
    concurrency: 1,
    resume: true,
  });
  assert.deepEqual(
    resumed.map((row) => row.series_id),
    original.map((row) => row.series_id),
  );
  assert.deepEqual(
    resumed.map((row) => row.score),
    original.map((row) => row.score),
  );
  assert.equal(fs.readFileSync(recordsPath, "utf8").trim().split("\n").length, original.length);
});

test("a draft-only league stops at the rosters and resumes into a full season", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-only-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const drafted = await runDraftLeague(["random", "random"], directory, {
    recordsPath,
    seed: 5,
    concurrency: 1,
    draftOnly: true,
  });
  assert.deepEqual(drafted, [], "a draft-only league plays no series");
  assert.ok(!fs.existsSync(path.join(directory, "series")), "no series directory is created");
  assert.ok(!fs.existsSync(recordsPath), "no rows reach the records file");

  const config: JsonObject = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.equal(config.draft_only, true);
  assert.equal(
    config.transactions,
    null,
    "a league that plays no games holds no transaction window",
  );
  const draftedRoster = readFranchiseRosterVersion(directory, 0);
  assert.equal(draftedRoster.length, 2);
  for (const franchise of draftedRoster) {
    assert.ok(franchise.roster.reduce((total, mon) => total + mon.cost, 0) <= BOARD.budget);
  }

  const played = await runDraftLeague(["random", "random"], directory, {
    recordsPath,
    seed: 5,
    concurrency: 1,
    resume: true,
  });
  assert.equal(played.length, 2, "resuming a draft-only run plays the season it skipped");
  const promoted: JsonObject = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.deepEqual(
    readFranchiseRosterVersion(directory, 0),
    draftedRoster,
    "the committed draft roster carries into the season",
  );
  assert.equal(promoted.draft_only, false, "a resumed draft-only run is a season");
  assert.deepEqual(
    promoted.transactions,
    [{ after_week: 1, trades_allowed: 2 }],
    "the resumed season chooses a schedule like a fresh one",
  );
  assert.ok(readTradeWindowArtifact(directory, 1), "the chosen window opens");
  assert.equal(played[0]!.stage, "roundrobin");
  assert.equal(played[1]!.stage, "playoff");
});
