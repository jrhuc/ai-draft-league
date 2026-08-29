import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";

import { loadBoard } from "../src/draft.js";
import { seriesGameSummaries, teamPreviewPicks } from "../src/game-usage.js";
import type { TeamBuildView } from "../src/views.js";

const BOARD = loadBoard("regmb-202607");
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
  const seriesDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-game-usage-"));
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
  fs.writeFileSync(path.join(seriesDir, "game-1.log"), gameLog);
  const head = { context_id: null, sequence: 0, byte_length: 0, sha256: "0".repeat(64) };
  fs.writeFileSync(
    path.join(seriesDir, "series-attempts.jsonl"),
    `${JSON.stringify({
      kind: "attempt_started",
      schema_version: 1,
      timestamp: "2026-08-20T00:00:00.000Z",
      attempt_id: "canonical",
      series_id: "abc123",
      adopted_completed_games: 0,
      context_heads: { start: { p1: head, p2: head }, end: { p1: head, p2: head } },
    })}\n`,
  );
  const zeros = { p1: 0, p2: 0 };
  const chance = { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 };
  fs.writeFileSync(
    path.join(seriesDir, "game-1.complete.json"),
    `${JSON.stringify({
      kind: "game_complete",
      schema_version: 2,
      series_id: "abc123",
      game_number: 1,
      attempt_id: "canonical",
      seed: [1, 2, 3, 4],
      log_sha256: createHash("sha256").update(gameLog).digest("hex"),
      coach_notes: { p1: "", p2: "" },
      summary: {
        winner: "test:alpha",
        winner_side: "p1",
        turns: 1,
        errors: zeros,
        model_choice_fallbacks: zeros,
        simulator_substitutions: zeros,
        timer_autodefaults: zeros,
        chance_events: { p1: chance, p2: chance },
        log: path.join(seriesDir, "game-1.log"),
      },
    })}\n`,
  );
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
  return seriesDir;
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
  const seriesDir = writeSeries({ p1: "team 3142", p2: "team 2143" });
  try {
    const summaries = seriesGameSummaries(seriesDir, "abc123", BOARD.mons, [
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
    fs.rmSync(seriesDir, { recursive: true, force: true });
  }
});

test("brought falls back to fielded when the pick is missing or names no registered slot", () => {
  const seriesDir = writeSeries({ p1: "team 9" });
  try {
    const summaries = seriesGameSummaries(seriesDir, "abc123", BOARD.mons, [
      build(0, P1_REGISTERED),
      build(1, P2_REGISTERED),
    ]);
    assert.deepEqual(summaries[0]!.brought, summaries[0]!.fielded);
  } finally {
    fs.rmSync(seriesDir, { recursive: true, force: true });
  }
});
