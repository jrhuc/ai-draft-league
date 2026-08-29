import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";

import { buildTournamentExport } from "../src/export-tournament.js";
import { publicTournamentBundleSchema } from "../src/public/tournament-protocol.js";
import { seriesRecordFixture } from "./fixtures/records.js";

function writeTeamPreviewRows(seriesDir: string, gameCount: number): void {
  for (const pid of ["p1", "p2"] as const) {
    const rows = Array.from({ length: gameCount }, (_, index) => ({
      kind: "decision",
      game_number: index + 1,
      turn: 0,
      phase: "team_preview",
      action: "team 1234",
      selection: [],
      rationale: "",
      outcome: "accepted",
      submission_id: `${pid}-preview-${index + 1}`,
      automatic: false,
      fallback: false,
      latency_ms: 100,
      total_tokens: 100,
    }));
    fs.appendFileSync(
      path.join(seriesDir, `${pid}-decisions.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  }
}

test("a completed pool bracket exports its entrants, bracket, and replay evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-export-tournament-"));
  const runsDir = path.join(root, "runs");
  const runId = "20260826T120000.000000Z-cup00001";
  const runDir = path.join(runsDir, runId);
  const recordsPath = path.join(root, "records.jsonl");
  const models = ["openai:alpha", "openai:beta"];
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify({
      mode: "tournament",
      models,
      seed: 7,
      pool: "test",
      format: "gen9championsvgc2026regmbbo3",
      provenance: "disclosed",
      entrants: [
        { model: models[0], team: "wolfe-mega-raichu-y" },
        { model: models[1], team: "endo-mega-sceptile" },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(runDir, "status.json"),
    JSON.stringify({ state: "done", start_time: "2026-08-26T12:00:00.000Z" }),
  );
  const seriesId = "final-series";
  const row = seriesRecordFixture({
    mode: "tournament",
    run_id: runId,
    series_id: seriesId,
    series_index: 0,
    round: 1,
    entrant_count: 2,
    seeds: { p1: 0, p2: 1 },
    provenance: "disclosed",
    pool: "test",
    advanced: models[1],
    timestamp: "2026-08-26T12:30:00.000Z",
    format: "gen9championsvgc2026regmbbo3",
    players: { p1: models[0], p2: models[1] },
    teams: { p1: "wolfe-mega-raichu-y", p2: "endo-mega-sceptile" },
    winner: models[1],
    winner_side: "p2",
    score: { p1: 0, p2: 2 },
    turns: 10,
    games: [
      { number: 1, winner: models[1], winner_side: "p2", turns: 5 },
      { number: 2, winner: models[1], winner_side: "p2", turns: 5 },
    ],
  });
  fs.writeFileSync(recordsPath, `${JSON.stringify(row)}\n`);
  const seriesDir = path.join(runDir, "series", seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  for (const game of [1, 2]) {
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      `|player|p1|${models[0]}|\n|player|p2|${models[1]}|\n|turn|5\n|win|${models[1]}\n`,
    );
  }
  fs.writeFileSync(
    path.join(seriesDir, "p1-decisions.jsonl"),
    `${JSON.stringify({
      kind: "decision",
      game_number: 1,
      turn: 1,
      phase: "turn",
      action: "move",
      selection: ["Fake Out -> foe 1"],
      rationale: "sash means the burst line is safe",
      notebook: "watch the sash",
      automatic: false,
      fallback: false,
      latency_ms: 1200,
      total_tokens: 900,
      reasoning_tokens: 400,
    })}\n${JSON.stringify({
      kind: "game_reflection",
      game_number: 1,
      result: "won",
      series_over: false,
      summary: "the lead pair held",
      adjustment: "keep the same lead",
      notebook: "carry: lead safe",
      fallback: false,
      total_tokens: 700,
      reasoning_tokens: 300,
    })}\n`,
  );
  writeTeamPreviewRows(seriesDir, 2);

  try {
    const bundle = buildTournamentExport({
      recordsPath,
      runsDir,
      runId,
      title: "Test Cup",
      generatedAt: "2026-08-26T13:00:00.000Z",
    });

    assert.equal(bundle.tournament.championId, "entrant-1");
    assert.equal(bundle.tournament.startedAt, "2026-08-26T12:00:00.000Z");
    assert.equal(bundle.briefing, null);
    assert.equal(bundle.entrants.length, 2);
    assert.equal(bundle.entrants[0]?.team.id, "wolfe-mega-raichu-y");
    assert.equal(bundle.entrants[0]?.team.sets.length, 6);
    assert.ok(bundle.entrants[0]?.team.sets.some((set) => set.mega !== null));
    assert.equal(bundle.bracket.rounds.length, 1);
    const final = bundle.bracket.rounds[0]?.[0];
    assert.deepEqual(final?.slots, ["entrant-0", "entrant-1"]);
    assert.equal(final?.match?.winnerId, "entrant-1");
    assert.deepEqual(final?.match?.score, [0, 2]);
    assert.equal(bundle.replays[seriesId]?.games.length, 2);
    assert.equal(bundle.replays[seriesId]?.games[0]?.winnerId, "entrant-1");
    assert.equal(bundle.replays[seriesId]?.games[0]?.brought[0].length, 4);
    assert.equal(bundle.replays[seriesId]?.games[0]?.brought[1].length, 4);
    assert.equal(
      bundle.replays[seriesId]?.games[0]?.raw,
      `|player|p1|${models[0]}|\n|player|p2|${models[1]}|\n|turn|5\n|win|${models[1]}\n`,
    );
    assert.equal(
      bundle.replays[seriesId]?.games[0]?.decisions.find((decision) => decision.phase === "turn")
        ?.notebook,
      "watch the sash",
    );
    assert.equal(bundle.replays[seriesId]?.games[0]?.reflections[0]?.notebook, "carry: lead safe");
    const invalid = structuredClone(bundle);
    invalid.replays[seriesId]!.games[0]!.brought[0].pop();
    assert.equal(publicTournamentBundleSchema.safeParse(invalid).success, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a half-played bracket keeps later rounds open and reports no champion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-export-tournament-open-"));
  const runsDir = path.join(root, "runs");
  const runId = "20260826T120000.000000Z-cup00002";
  const runDir = path.join(runsDir, runId);
  const recordsPath = path.join(root, "records.jsonl");
  const models = ["openai:alpha", "openai:beta", "openai:gamma", "openai:delta"];
  const teams = [
    "wolfe-mega-raichu-y",
    "endo-mega-sceptile",
    "jpnats-mega-swampert",
    "cybertron-mega-staraptor",
  ];
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify({
      mode: "tournament",
      models,
      seed: 7,
      pool: "test",
      format: "gen9championsvgc2026regmbbo3",
      entrants: models.map((model, position) => ({ model, team: teams[position] })),
    }),
  );
  const seriesId = "semi-series";
  const row = seriesRecordFixture({
    mode: "tournament",
    run_id: runId,
    series_id: seriesId,
    series_index: 0,
    round: 1,
    entrant_count: 4,
    seeds: { p1: 0, p2: 3 },
    pool: "test",
    advanced: models[0],
    format: "gen9championsvgc2026regmbbo3",
    players: { p1: models[0], p2: models[3] },
    teams: { p1: teams[0], p2: teams[3] },
    winner: models[0],
    winner_side: "p1",
    score: { p1: 2, p2: 0 },
    turns: 10,
    games: [
      { number: 1, winner: models[0], winner_side: "p1", turns: 5 },
      { number: 2, winner: models[0], winner_side: "p1", turns: 5 },
    ],
  });
  fs.writeFileSync(recordsPath, `${JSON.stringify(row)}\n`);
  const seriesDir = path.join(runDir, "series", seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  for (const game of [1, 2]) {
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      `|player|p1|${models[0]}|\n|player|p2|${models[3]}|\n|turn|5\n|win|${models[0]}\n`,
    );
  }
  writeTeamPreviewRows(seriesDir, 2);

  try {
    const bundle = buildTournamentExport({ recordsPath, runsDir, runId, title: "Test Cup" });
    assert.equal(bundle.tournament.championId, null);
    assert.equal(bundle.bracket.rounds.length, 2);
    assert.equal(bundle.bracket.rounds[0]?.[0]?.match?.winnerId, "entrant-0");
    assert.deepEqual(bundle.bracket.rounds[0]?.[1]?.slots, ["entrant-1", "entrant-2"]);
    assert.equal(bundle.bracket.rounds[0]?.[1]?.match, null);
    assert.deepEqual(bundle.bracket.rounds[1]?.[0]?.slots, ["entrant-0", null]);
    assert.equal(Object.keys(bundle.replays).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
