import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";

import { loadBoard } from "../src/draft.js";
import { seriesGameSummaries, teamPreviewPicks } from "../src/game-usage.js";
import type { TeamBuildView } from "../src/views.js";
import { storeCompletedSeriesFixture } from "./series-store-fixture.js";

const BOARD = loadBoard("regmc-202609");
const byId = new Map(BOARD.mons.map((mon) => [mon.id, mon]));

function mon(id: string) {
  const found = byId.get(id);
  if (!found) throw new Error(`board has no ${id}`);
  return found;
}

function build(entrant: number, brought: string[]): TeamBuildView {
  return {
    seriesIndex: 0,
    entrant,
    opponent: 1 - entrant,
    brought,
    sets: [],
    rationale: "",
    attempts: 1,
  };
}

function writeSeries(previewActions: { p1?: string; p2?: string }): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-game-usage-"));
  const seriesDir = path.join(runDir, "series", "abc123");
  fs.mkdirSync(seriesDir, { recursive: true });
  const gameLog = [
    "|gametype|doubles",
    "|start",
    `|switch|p1a: A|${mon("tsareena").species}, L50|100/100`,
    `|switch|p1b: B|${mon("raichu").species}, L50|100/100`,
    `|switch|p2a: C|${mon("heliolisk").species}, L50|100/100`,
    `|switch|p2b: D|${mon("pelipper").species}, L50|100/100`,
    "|turn|1",
    "|win|p1-test:alpha",
    "",
  ].join("\n");
  const gameLogPath = path.join(seriesDir, "game-1.log");
  fs.writeFileSync(gameLogPath, gameLog);
  storeCompletedSeriesFixture(runDir, "abc123", [
    { number: 1, logPath: gameLogPath, winner: "test:alpha", winnerSide: "p1" },
  ]);
  for (const [pid, action] of Object.entries(previewActions)) {
    fs.writeFileSync(
      path.join(seriesDir, `${pid}-decisions.jsonl`),
      `${JSON.stringify({
        kind: "decision",
        attempt_id: "canonical",
        game_number: 1,
        turn: 0,
        phase: "team_preview",
        action,
        rationale: "",
        outcome: "accepted",
        submission_id: `${pid}-preview`,
      })}\n`,
    );
  }
  return runDir;
}

const P1_REGISTERED = ["raichu", "primarina", "tsareena", "diggersby"];
const P2_REGISTERED = ["pelipper", "heliolisk", "hydreigon", "klefki"];

test("team preview evidence requires an accepted unique four-slot action", () => {
  const picks = teamPreviewPicks(
    [
      [
        {
          kind: "decision",
          phase: "team_preview",
          outcome: "accepted",
          game_number: 1,
          action: "team 3142",
        },
        {
          kind: "decision",
          phase: "team_preview",
          outcome: "rejected",
          game_number: 1,
          action: "team 1234",
        },
      ],
      [
        {
          kind: "decision",
          phase: "team_preview",
          outcome: "accepted",
          game_number: 1,
          action: "team 1123",
        },
      ],
    ],
    1,
  );

  assert.deepEqual(picks, [["team 3142", undefined]]);
});

test("brought comes from the recorded team-preview pick, fielded from the log", () => {
  const runDir = writeSeries({ p1: "team 3142", p2: "team 2143" });
  try {
    const summaries = seriesGameSummaries(runDir, "abc123", BOARD.mons, [
      build(0, P1_REGISTERED),
      build(1, P2_REGISTERED),
    ]);
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0]!.brought, [
      ["tsareena", "raichu", "diggersby", "primarina"],
      ["heliolisk", "pelipper", "klefki", "hydreigon"],
    ]);
    assert.deepEqual(summaries[0]!.fielded, [
      ["tsareena", "raichu"],
      ["heliolisk", "pelipper"],
    ]);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("brought falls back to fielded when the pick is missing or names no registered slot", () => {
  const runDir = writeSeries({ p1: "team 9" });
  try {
    const summaries = seriesGameSummaries(runDir, "abc123", BOARD.mons, [
      build(0, P1_REGISTERED),
      build(1, P2_REGISTERED),
    ]);
    assert.deepEqual(summaries[0]!.brought, summaries[0]!.fielded);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
