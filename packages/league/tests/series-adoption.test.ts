import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { resolveAttemptLineage } from "../src/series.js";
import { recordedFixtureOptions, writeDecidedAdoption } from "./series-test-helpers.js";

test("adoption fails closed on ambiguous equal-progress series directories", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-adopt-tie-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 14);
  const firstDir = writeDecidedAdoption(runDir, "z-equal-progress", options);
  const secondDir = writeDecidedAdoption(runDir, "a-equal-progress", options);
  const attemptsBefore = [firstDir, secondDir].map((directory) =>
    fs.readFileSync(path.join(directory, "series-attempts.jsonl")),
  );

  await assert.rejects(playRecordedSeries(options), /ambiguous recorded series adoption/);
  assert.deepEqual(
    [firstDir, secondDir].map((directory) =>
      fs.readFileSync(path.join(directory, "series-attempts.jsonl")),
    ),
    attemptsBefore,
  );
});

test("adoption rejects immutable series identity mismatches without rewriting metadata", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-adopt-identity-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const stored = recordedFixtureOptions(pool, defaultPsDir(), runDir, 16);
  const seriesDir = writeDecidedAdoption(runDir, "identity-bound", stored);
  const metadataBefore = fs.readFileSync(path.join(seriesDir, "series.json"));
  const attemptsBefore = fs.readFileSync(path.join(seriesDir, "series-attempts.jsonl"));
  const mismatched = recordedFixtureOptions(pool, defaultPsDir(), runDir, 16, {
    p1: "openai:different-model",
    p2: "random",
  });

  await assert.rejects(playRecordedSeries(mismatched), /recorded series identity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, "series.json")), metadataBefore);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, "series-attempts.jsonl")), attemptsBefore);
});

test("adoption rejects any mutation of marker-bound canonical game log bytes", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-adopt-log-digest-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 17);
  const seriesDir = writeDecidedAdoption(runDir, "digest-bound", options);
  const attemptsBefore = fs.readFileSync(path.join(seriesDir, "series-attempts.jsonl"));
  fs.appendFileSync(path.join(seriesDir, "game-1.log"), "|mutation|after-completion\n");

  await assert.rejects(playRecordedSeries(options), /canonical game log digest does not match/);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, "series-attempts.jsonl")), attemptsBefore);
});

test("adoption accepts only the exact current completion marker shape", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  for (const mutation of ["extra", "missing"] as const) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `vgc-series-adopt-marker-${mutation}-`));
    t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
    const options = recordedFixtureOptions(
      pool,
      defaultPsDir(),
      runDir,
      mutation === "extra" ? 18 : 19,
    );
    const seriesDir = writeDecidedAdoption(runDir, `${mutation}-marker`, options);
    const markerPath = path.join(seriesDir, "game-1.complete.json");
    const completion = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (mutation === "extra") completion.unbound = true;
    else delete completion.summary.errors;
    fs.writeFileSync(markerPath, `${JSON.stringify(completion)}\n`);

    await assert.rejects(playRecordedSeries(options), /invalid game completion marker/);
  }
});

test("a resumed attempt supersedes a crashed attempt and completes under one stable id", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-attempt-resume-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const seriesId = "crashresume";
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 15);
  const seriesDir = writeDecidedAdoption(runDir, seriesId, options);
  const emptyHead = {
    context_id: null,
    sequence: 0,
    byte_length: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  fs.appendFileSync(
    path.join(seriesDir, "series-attempts.jsonl"),
    `${JSON.stringify({
      kind: "attempt_started",
      schema_version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      attempt_id: "crashed-attempt",
      series_id: seriesId,
      adopted_completed_games: 1,
      context_heads: {
        start: { p1: emptyHead, p2: emptyHead },
        end: { p1: emptyHead, p2: emptyHead },
      },
    })}\n{"kind":`,
  );

  await playRecordedSeries(options);

  const rows = fs
    .readFileSync(path.join(seriesDir, "series-attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const resumedStart = rows.findLast(
    (row) =>
      row.kind === "attempt_started" &&
      ![`${seriesId}-fixture`, "crashed-attempt"].includes(row.attempt_id),
  );
  assert.ok(resumedStart);
  assert.equal(resumedStart.adopted_completed_games, 2);
  const superseded = rows.find((row) => row.kind === "attempt_superseded");
  assert.equal(superseded.attempt_id, "crashed-attempt");
  assert.equal(superseded.superseded_by, resumedStart.attempt_id);
  assert.equal(superseded.adopted_completed_games, 1);
  const completed = rows.at(-1)!;
  assert.equal(completed.kind, "attempt_completed");
  assert.equal(completed.attempt_id, resumedStart.attempt_id);
  assert.equal(completed.adopted_completed_games, 2);
  assert.equal(completed.completed_games, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.series_id === seriesId &&
        row.context_heads.start.p1 &&
        row.context_heads.start.p2 &&
        row.context_heads.end.p1 &&
        row.context_heads.end.p2,
    ),
  );
});

test("adoption truncates a torn final context row before a subsequent append", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-context-tail-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 9, {
    p1: "openrouter:context-test",
    p2: "random",
  });
  const seriesDir = writeDecidedAdoption(runDir, "contextattempt", options);
  const contextFile = path.join(seriesDir, "p1-context.jsonl");
  const rows = [
    {
      kind: "agent_context",
      pid: "p1",
      series_id: "contextattempt",
      context_id: "ctx-00000001",
      sequence: 1,
      context_kind: "episode",
      payload: { event: "game_begin" },
    },
    {
      kind: "agent_context",
      pid: "p1",
      series_id: "contextattempt",
      context_id: "ctx-00000002",
      sequence: 2,
      context_kind: "observation",
      payload: { lines: ["|turn|1"] },
    },
  ];
  fs.writeFileSync(
    contextFile,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{"kind":"agent_context","context_id":"ctx-00000003"`,
  );
  await playRecordedSeries(options);
  assert.equal(
    fs.readFileSync(contextFile, "utf8"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const next = {
    kind: "agent_context",
    pid: "p1",
    series_id: "contextattempt",
    context_id: "ctx-00000003",
    sequence: 3,
    context_kind: "reflection",
    payload: { summary: "appended after recovery" },
  };
  fs.appendFileSync(contextFile, `${JSON.stringify(next)}\n`);
  await playRecordedSeries(options);
  const recovered = fs
    .readFileSync(contextFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    recovered.map((row) => row.sequence),
    [1, 2, 3],
  );
});

test("adoption still rejects malformed interior context rows", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-context-interior-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 10, {
    p1: "openrouter:context-test",
    p2: "random",
  });
  const seriesDir = writeDecidedAdoption(runDir, "badcontext", options);
  fs.writeFileSync(
    path.join(seriesDir, "p1-context.jsonl"),
    [
      JSON.stringify({
        kind: "agent_context",
        pid: "p1",
        series_id: "badcontext",
        context_id: "ctx-00000001",
        sequence: 1,
        context_kind: "episode",
        payload: {},
      }),
      '{"kind":',
      JSON.stringify({
        kind: "agent_context",
        pid: "p1",
        series_id: "badcontext",
        context_id: "ctx-00000002",
        sequence: 2,
        context_kind: "episode",
        payload: {},
      }),
      "",
    ].join("\n"),
  );

  const contextBefore = fs.readFileSync(path.join(seriesDir, "p1-context.jsonl"));
  await assert.rejects(playRecordedSeries(options), /invalid p1 context row 2/);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, "p1-context.jsonl")), contextBefore);
  const attempts = fs
    .readFileSync(path.join(seriesDir, "series-attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    attempts.map((row) => row.kind),
    ["attempt_started", "attempt_completed", "attempt_started", "attempt_aborted"],
  );
  assert.equal(attempts.at(-2)!.attempt_id, attempts.at(-1)!.attempt_id);
  assert.equal(attempts.at(-1)!.error.message, "invalid p1 context row 2");
});

test("attempt lineage is transitive, excludes restart siblings, and fails closed", () => {
  const starts = [
    { kind: "attempt_started", attempt_id: "A", series_id: "series" },
    { kind: "attempt_started", attempt_id: "restart-sibling", series_id: "series" },
    { kind: "attempt_started", attempt_id: "B", series_id: "series", resumed_from: "A" },
    { kind: "attempt_started", attempt_id: "C", series_id: "series", resumed_from: "B" },
  ];
  assert.deepEqual(resolveAttemptLineage(starts, "C"), ["A", "B", "C"]);
  assert.deepEqual(resolveAttemptLineage(starts, "restart-sibling"), ["restart-sibling"]);
  assert.equal(
    resolveAttemptLineage(
      [
        ...starts,
        {
          kind: "attempt_started",
          attempt_id: "missing-child",
          series_id: "series",
          resumed_from: "missing",
        },
      ],
      "missing-child",
    ),
    undefined,
  );
  assert.equal(
    resolveAttemptLineage(
      [
        {
          kind: "attempt_started",
          attempt_id: "cycle-a",
          series_id: "series",
          resumed_from: "cycle-b",
        },
        {
          kind: "attempt_started",
          attempt_id: "cycle-b",
          series_id: "series",
          resumed_from: "cycle-a",
        },
      ],
      "cycle-a",
    ),
    undefined,
  );
});

test("adoption rejects context rows owned by another seat or series", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-context-owner-"));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, pid, persistedSeries] of [
    ["wrongpid", "p2", "wrongpid"],
    ["wrongseries", "p1", "another-series"],
  ] as const) {
    const runDir = path.join(root, name);
    const options = recordedFixtureOptions(
      pool,
      defaultPsDir(),
      runDir,
      name === "wrongpid" ? 12 : 13,
      {
        p1: "openrouter:context-test",
        p2: "random",
      },
    );
    const seriesDir = writeDecidedAdoption(runDir, name, options);
    fs.writeFileSync(
      path.join(seriesDir, "p1-context.jsonl"),
      `${JSON.stringify({
        kind: "agent_context",
        pid,
        series_id: persistedSeries,
        context_id: "ctx-00000001",
        sequence: 1,
        context_kind: "episode",
        payload: {},
      })}\n`,
    );
    await assert.rejects(playRecordedSeries(options), /invalid p1 context row 1/);
  }
});
