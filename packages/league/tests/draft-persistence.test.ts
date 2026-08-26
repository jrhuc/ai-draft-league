import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDraftLeague } from "../src/draftleague.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { defaultPsDir } from "../src/paths.js";
import { seededRng, seriesEntropy } from "../src/random.js";
import { canonicalJson } from "../src/serialization.js";
import { foldSeriesGames } from "../src/series.js";
import { decodeTeamBuildJournalRow } from "../src/teambuild.js";
import {
  parseTradeDecision,
  readValidatedTradeWindow,
  runTradeWindow,
} from "../src/trade-window.js";
import type { Completion, JsonObject } from "../src/types.js";
import { asRecord, asRecords } from "../src/value.js";
import { BOARD, transactionState } from "./draft-test-helpers.js";

test("durable journal and atomic final-artifact faults retry provider-free and commit once", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-atomic-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = transactionState();
  state.models = ["random", "test:coach"];
  const initial = structuredClone(state);
  const before = JSON.stringify(state);
  const rosterReference = state.rosters;
  const budgetReference = state.budgets;
  const owned = new Set(state.rosters.flatMap((roster) => roster.map((candidate) => candidate.id)));
  let swap: { drop: string; add: string } | undefined;
  for (const drop of state.rosters[1]!) {
    for (const add of BOARD.mons) {
      if (owned.has(add.id)) continue;
      const parsed = parseTradeDecision(
        JSON.stringify({ swaps: [{ drop: drop.id, add: add.id }] }),
        state,
        1,
      );
      if (typeof parsed === "string" || !parsed.swaps[0]) continue;
      swap = parsed.swaps[0];
      break;
    }
    if (swap) break;
  }
  assert.ok(swap, "fixture needs one legal durable swap");

  const transcript = path.join(directory, "window.jsonl");
  const originalAppend = fs.appendFileSync;
  let completions = 0;
  let injected = false;
  fs.appendFileSync = (file, data, options) => {
    originalAppend(file, data, options);
    if (!injected && String(file) === transcript) {
      injected = true;
      throw new Error("fault after durable append");
    }
  };
  try {
    await assert.rejects(
      runTradeWindow(state, {
        epochDir: directory,
        psDir: defaultPsDir(),
        position: { afterWeek: 1, index: 0, count: 1 },
        tradesAllowed: 0,
        makeTradeProvider: () => ({
          complete(): Promise<Completion> {
            completions += 1;
            return Promise.resolve({
              text: JSON.stringify({ swaps: [swap], notebook: "durable plan" }),
              usage: {},
              toolCalls: [],
            });
          },
        }),
      }),
      /fault after durable append/,
    );
  } finally {
    fs.appendFileSync = originalAppend;
  }
  assert.equal(completions, 1);
  assert.equal(JSON.stringify(state), before, "durability failure does not mutate caller state");
  assert.equal(
    fs.readFileSync(transcript, "utf8").split("\n").length,
    2,
    "the first row reached durable storage",
  );

  const artifactFile = path.join(directory, "window.json");
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    originalRename(source, destination);
    if (String(destination) === artifactFile)
      throw new Error("fault after physical artifact rename");
  };
  try {
    await assert.rejects(
      runTradeWindow(state, {
        epochDir: directory,
        psDir: defaultPsDir(),
        position: { afterWeek: 1, index: 0, count: 1 },
        tradesAllowed: 0,
        makeTradeProvider: () => ({
          complete(): Promise<Completion> {
            completions += 1;
            throw new Error("durable decisions must not call providers");
          },
        }),
      }),
      /fault after physical artifact rename/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  const journal = fs.readFileSync(transcript, "utf8");
  assert.equal(journal.split("\n").length, 3);
  assert.ok(journal.endsWith("\n"));
  assert.ok(fs.existsSync(artifactFile), "the physical artifact survived the interrupted caller");
  assert.equal(JSON.stringify(state), before, "finalization failure remains caller-atomic");
  assert.equal(completions, 1, "the durable prefix was replayed");

  const artifact = await runTradeWindow(state, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 0,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        completions += 1;
        throw new Error("complete durable journal must not call providers");
      },
    }),
  });
  assert.equal(completions, 1);
  assert.equal(
    fs.readFileSync(transcript, "utf8"),
    journal,
    "retry does not append committed decisions twice",
  );
  assert.strictEqual(state.rosters, rosterReference);
  assert.strictEqual(state.budgets, budgetReference);
  assert.equal(state.rosters[1]!.filter((candidate) => candidate.id === swap.add).length, 1);
  assert.ok(!state.rosters[1]!.some((candidate) => candidate.id === swap.drop));
  assert.deepEqual(
    readValidatedTradeWindow(directory, initial, { afterWeek: 1, tradesAllowed: 0 }),
    artifact,
  );
});

test("current teambuild provenance counts as post-window transaction-barrier evidence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-teambuild-barrier-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = ["random", "random"];
  await runDraftLeague(models, directory, {
    recordsPath,
    seed: 79,
    concurrency: 1,
    throughWeek: 1,
  });
  fs.rmSync(path.join(directory, "reviews", "week-1.jsonl"));
  const teambuildFile = path.join(directory, "teambuild", "teambuild.jsonl");
  const postWindow = decodeTeamBuildJournalRow(readJsonlObjects(teambuildFile)[0]!);
  postWindow.artifact.task.provenance.seriesIndex = 1;
  postWindow.artifact.task.provenance.opponent = 1;
  fs.appendFileSync(
    teambuildFile,
    `${JSON.stringify({ artifact: postWindow.artifact })}
`,
  );

  await assert.rejects(
    runDraftLeague(models, directory, { recordsPath, seed: 79, concurrency: 1, resume: true }),
    /review barrier but lacks a complete review: window.json, window.jsonl, window, teambuild\/teambuild.jsonl series 1/,
  );
});

test("committed overlays fail closed when tampered or missing past the transaction barrier", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-barrier-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  await runDraftLeague(["random", "random"], directory, { recordsPath, seed: 73, concurrency: 1 });
  const artifactFile = path.join(directory, "transactions", "after-week-1", "window.json");
  const original = fs.readFileSync(artifactFile, "utf8");
  const artifact: { rosters: Array<{ spent: number }> } = JSON.parse(original);
  artifact.rosters[0]!.spent += 1;
  fs.writeFileSync(artifactFile, `${JSON.stringify(artifact)}\n`);
  await assert.rejects(
    runDraftLeague(["random", "random"], directory, {
      recordsPath,
      seed: 73,
      concurrency: 1,
      resume: true,
    }),
    /authoritative ordered replay/,
  );

  fs.writeFileSync(artifactFile, original);
  fs.rmSync(artifactFile);
  await assert.rejects(
    runDraftLeague(["random", "random"], directory, {
      recordsPath,
      seed: 73,
      concurrency: 1,
      resume: true,
    }),
    /transaction barrier but lacks authoritative window artifacts/,
  );
  assert.ok(!fs.existsSync(artifactFile), "resume does not regenerate a missing committed overlay");
});

test("transaction replay enforces one current schema, privacy shape, and phase order", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await runTradeWindow(transactionState(), {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 1,
  });
  const transcript = path.join(directory, "window.jsonl");
  const artifactFile = path.join(directory, "window.json");
  const journal = fs.readFileSync(transcript, "utf8");
  const artifact = fs.readFileSync(artifactFile, "utf8");
  const lines = journal.slice(0, -1).split("\n");
  const scenarios: Array<{ name: string; write: () => void; error: RegExp }> = [
    {
      name: "blank physical line",
      write: () => fs.writeFileSync(transcript, `\n${journal}`),
      error: /line 1 must be a nonblank JSON object/,
    },
    {
      name: "missing terminal newline",
      write: () => fs.writeFileSync(transcript, journal.slice(0, -1)),
      error: /must be nonblank and end with a newline/,
    },
    {
      name: "noncanonical duplicate key",
      write: () =>
        fs.writeFileSync(
          transcript,
          `${lines[0]!.replace('"kind":"offer"', '"kind":"ignored","kind":"offer"')}\n${lines.slice(1).join("\n")}\n`,
        ),
      error: /line 1 is not canonical JSON/,
    },
    {
      name: "no-offer private responder field",
      write: () => {
        const rows: JsonObject[] = lines.map((line) => JSON.parse(line));
        rows[0]!.responseNotebook = "not applicable";
        fs.writeFileSync(transcript, `${rows.map(canonicalJson).join("\n")}\n`);
      },
      error: /offer row must have exactly the current schema keys/,
    },
    {
      name: "interleaved phase",
      write: () =>
        fs.writeFileSync(transcript, `${[lines[0], lines[2], lines[1], lines[3]].join("\n")}\n`),
      error: /interleaves an offer after free agency began/,
    },
    {
      name: "incomplete committed log",
      write: () => fs.writeFileSync(transcript, `${lines.slice(0, -1).join("\n")}\n`),
      error: /ordered log is incomplete/,
    },
    {
      name: "missing current artifact field",
      write: () => {
        const parsed: JsonObject = JSON.parse(artifact);
        delete parsed.offers;
        fs.writeFileSync(artifactFile, `${JSON.stringify(parsed)}\n`);
      },
      error: /is not a complete transaction artifact/,
    },
  ];
  for (const scenario of scenarios) {
    fs.writeFileSync(transcript, journal);
    fs.writeFileSync(artifactFile, artifact);
    scenario.write();
    assert.throws(
      () =>
        readValidatedTradeWindow(directory, transactionState(), { afterWeek: 1, tradesAllowed: 1 }),
      scenario.error,
      scenario.name,
    );
  }
});

test("season resume requires canonical stored series evidence before standings and bracket adoption", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-season-fold-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  await runDraftLeague(["random", "random"], directory, { recordsPath, seed: 29, concurrency: 1 });
  const original = fs
    .readFileSync(recordsPath, "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  const roundRobin = original.findIndex((row) => row.stage === "roundrobin");
  const playoff = original.findIndex((row) => row.stage === "playoff");
  assert.ok(roundRobin >= 0 && playoff >= 0);

  const inventedTiebreak = structuredClone(original);
  const playoffRow = inventedTiebreak[playoff]!;
  const playoffIndex = Number(playoffRow.series_index);
  const regulationSeeds = seriesEntropy(seededRng(`29:series:${playoffIndex}`)).gameSeeds;
  const tiedRegulation = regulationSeeds.map((gameSeed, index) => ({
    number: index + 1,
    winner: null,
    winner_side: null,
    turns: 1,
    seed: gameSeed,
  }));
  const tiebreakSeed = foldSeriesGames(regulationSeeds, tiedRegulation, {
    requireWinner: true,
  }).nextSeed!;
  const winnerSide = playoffRow.winner_side === "p1" ? "p1" : "p2";
  const players = asRecord(playoffRow.players);
  playoffRow.games = [
    ...tiedRegulation,
    {
      number: 4,
      winner: players[winnerSide],
      winner_side: winnerSide,
      turns: 1,
      seed: tiebreakSeed,
    },
  ];
  playoffRow.score = winnerSide === "p1" ? { p1: 1, p2: 0 } : { p1: 0, p2: 1 };
  playoffRow.winner = players[winnerSide];
  playoffRow.turns = 4;
  fs.writeFileSync(
    recordsPath,
    `${inventedTiebreak.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await assert.rejects(
    runDraftLeague(["random", "random"], directory, {
      recordsPath,
      seed: 29,
      concurrency: 1,
      resume: true,
    }),
    /canonical completed series evidence/,
    "a fourth playoff game invented only in results.jsonl is not stored series evidence",
  );

  const scenarios: Array<{
    name: string;
    mutate: (rows: Array<JsonObject>) => void;
    error: RegExp;
  }> = [
    {
      name: "Bo3 cardinality",
      mutate: (rows) => {
        rows[roundRobin]!.games = [];
      },
      error: /canonical completed series evidence/,
    },
    {
      name: "players",
      mutate: (rows) => {
        rows[playoff]!.players = { p1: "forged", p2: "random" };
      },
      error: /canonical completed series evidence/,
    },
    {
      name: "seed",
      mutate: (rows) => {
        const games = asRecords(rows[roundRobin]!.games);
        games[0]!.seed = [1, 1, 1, 1];
      },
      error: /canonical completed series evidence/,
    },
    {
      name: "folded score",
      mutate: (rows) => {
        rows[roundRobin]!.score = { p1: 9, p2: 0 };
      },
      error: /canonical completed series evidence/,
    },
    {
      name: "pre-window prefix",
      mutate: (rows) => {
        const later = rows[playoff]!;
        const prefix = rows[roundRobin]!;
        rows.splice(0, rows.length, later, prefix);
      },
      error: /crosses the transaction barrier before the exact pre-window result prefix/,
    },
  ];
  for (const scenario of scenarios) {
    const rows = structuredClone(original);
    scenario.mutate(rows);
    fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await assert.rejects(
      runDraftLeague(["random", "random"], directory, {
        recordsPath,
        seed: 29,
        concurrency: 1,
        resume: true,
      }),
      scenario.error,
      scenario.name,
    );
  }
});

test("a two-coach league plays one week and a single final", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-two-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = await runDraftLeague(["random", "random"], directory, {
    recordsPath: path.join(directory, "results.jsonl"),
    seed: 5,
    concurrency: 1,
    sequentialWeeks: true,
    closedSheets: true,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.stage, "roundrobin");
  assert.equal(rows[1]!.stage, "playoff");
  assert.ok(rows[1]!.winner, "a playoff series must produce a winner");
  const config: JsonObject = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.equal(config.sequential_weeks, true);
  assert.equal(config.closed_sheets, true);
  assert.deepEqual(
    config.transactions,
    [{ after_week: 1, trades_allowed: 2 }],
    "short leagues keep only the default windows that fit their round robin",
  );
  for (const row of rows)
    assert.equal(row.closed_sheets, true, "series records carry the sheet rule");
  const builds = readJsonlObjects(path.join(directory, "teambuild", "teambuild.jsonl"));
  for (const build of builds) {
    const artifact = asRecord(build.artifact);
    const task = asRecord(artifact.task);
    assert.equal(task.sheetPolicy, "closed");
  }
  const gameLog = fs.readFileSync(
    path.join(directory, "series", String(rows[0]!.series_id), "game-1.log"),
    "utf8",
  );
  assert.ok(!gameLog.includes("|showteam|"), "closed-sheet games publish no team sheets");
});

test("a draft-only league stops at the rosters and resumes into a full season", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-only-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
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
  const rosters: Array<JsonObject> = JSON.parse(
    fs.readFileSync(path.join(directory, "rosters.json"), "utf8"),
  );
  assert.equal(rosters.length, 2);

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
  assert.deepEqual(promoted.rosters, config.rosters, "the drafted rosters carry into the season");
  assert.equal(promoted.draft_only, false, "a resumed draft-only run is a season");
  assert.deepEqual(
    promoted.transactions,
    [{ after_week: 1, trades_allowed: 2 }],
    "the resumed season chooses a schedule like a fresh one",
  );
  assert.ok(
    fs.existsSync(path.join(directory, "transactions", "after-week-1", "window.json")),
    "the chosen window opens",
  );
  assert.equal(played[0]!.stage, "roundrobin");
  assert.equal(played[1]!.stage, "playoff");

  const contaminated = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-only-evidence-"));
  t.after(() => fs.rmSync(contaminated, { recursive: true, force: true }));
  const contaminatedRecords = path.join(contaminated, "results.jsonl");
  await runDraftLeague(["random", "random"], contaminated, {
    recordsPath: contaminatedRecords,
    seed: 5,
    draftOnly: true,
  });
  fs.writeFileSync(
    contaminatedRecords,
    `${JSON.stringify({ ...played[0], run_id: path.basename(contaminated) })}\n`,
  );
  for (const relative of ["teambuild/teambuild.jsonl", "coaching.jsonl", "season.jsonl"]) {
    fs.mkdirSync(path.dirname(path.join(contaminated, relative)), { recursive: true });
    fs.writeFileSync(path.join(contaminated, relative), "{}\n");
  }
  fs.mkdirSync(path.join(contaminated, "series", "stale"), { recursive: true });
  await assert.rejects(
    runDraftLeague(["random", "random"], contaminated, {
      recordsPath: contaminatedRecords,
      seed: 5,
      resume: true,
    }),
    (error: Error) =>
      [
        "stored results",
        "teambuild/teambuild.jsonl",
        "coaching.jsonl",
        "season.jsonl",
        "series/",
      ].every((value) => error.message.includes(value)),
  );
});
