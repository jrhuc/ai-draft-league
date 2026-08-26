import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDraftLeagueSchedule } from "../src/draftleague-protocol.js";
import { buildSeasonExport } from "../src/export-season.js";
import { seriesRecordFixture } from "./fixtures/records.js";

test("the automatic release exports a completed round-robin draw with replay evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-export-season-draw-"));
  const runsDir = path.join(root, "runs");
  const runId = "20260826T120000.000000Z-draw0001";
  const runDir = path.join(runsDir, runId);
  const recordsPath = path.join(root, "records.jsonl");
  const models = ["openai:alpha", "openai:beta"];
  const names = ["Alpha Aces", "Beta Bandits"];
  const plan = buildDraftLeagueSchedule(2, 17).plans[0]!;
  assert.ok(plan.entrants);
  fs.mkdirSync(path.join(runDir, "draft"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify({
      mode: "draft",
      entrants: models,
      team_names: names,
      weeks: 1,
      board: "regmb-202607",
      format: "gen9championsvgc2026regmbbo3",
      seed: 17,
      closed_sheets: false,
      showdown_commit: null,
    }),
  );
  fs.writeFileSync(
    path.join(runDir, "rosters.json"),
    JSON.stringify([
      {
        entrant: 0,
        model: models[0],
        team_name: names[0],
        budget_left: 80,
        spent: 20,
        roster: [{ id: "charizard-mega-y", name: "Mega Charizard Y", cost: 20 }],
      },
      {
        entrant: 1,
        model: models[1],
        team_name: names[1],
        budget_left: 80,
        spent: 20,
        roster: [{ id: "floette-mega", name: "Mega Floette", cost: 20 }],
      },
    ]),
  );
  fs.writeFileSync(
    path.join(runDir, "draft", "draft.jsonl"),
    `${JSON.stringify({ entrant: 0, pick: 1, model: models[0], mon: "charizard-mega-y", name: "Mega Charizard Y", cost: 20, budget_left: 80 })}\n${JSON.stringify({ entrant: 1, pick: 2, model: models[1], mon: "floette-mega", name: "Mega Floette", cost: 20, budget_left: 80 })}\n`,
  );
  const sides = plan.entrants;
  const seriesId = "draw-series";
  const row = seriesRecordFixture({
    mode: "draft",
    run_id: runId,
    series_id: seriesId,
    series_index: plan.index,
    stage: "roundrobin",
    round: 1,
    timestamp: "2026-08-26T12:00:00.000Z",
    board: "regmb-202607",
    format: "gen9championsvgc2026regmbbo3",
    entrants: sides,
    players: { p1: models[sides[0]], p2: models[sides[1]] },
    teams: { p1: names[sides[0]], p2: names[sides[1]] },
    winner: null,
    winner_side: null,
    score: { p1: 1, p2: 1 },
    turns: 15,
    games: [
      { number: 1, winner: models[sides[0]], winner_side: "p1", turns: 5 },
      { number: 2, winner: models[sides[1]], winner_side: "p2", turns: 5 },
      { number: 3, winner: null, winner_side: null, turns: 5 },
    ],
  });
  fs.writeFileSync(recordsPath, `${JSON.stringify(row)}\n`);
  const seriesDir = path.join(runDir, "series", seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  const terminals = [`|win|${names[sides[0]]}`, `|win|${names[sides[1]]}`, "|tie"];
  for (const [index, terminal] of terminals.entries()) {
    fs.writeFileSync(
      path.join(seriesDir, `game-${index + 1}.log`),
      `|player|p1|${names[sides[0]]}|\n|player|p2|${names[sides[1]]}|\n|turn|5\n${terminal}\n`,
    );
  }

  try {
    const bundle = buildSeasonExport({
      recordsPath,
      runsDir,
      runId,
      title: "Draw season",
      releasedThroughWeek: "all",
      generatedAt: "2026-08-26T13:00:00.000Z",
    });

    assert.equal(bundle.season.releasedThroughWeek, 1);
    assert.equal(bundle.weeks[0]?.matches[0]?.status, "complete");
    assert.equal(bundle.weeks[0]?.matches[0]?.winnerId, null);
    assert.deepEqual(bundle.weeks[0]?.matches[0]?.score, [1, 1]);
    assert.equal(bundle.replays[seriesId]?.games.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
