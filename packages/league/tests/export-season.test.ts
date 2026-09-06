import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "vite-plus/test";

import { buildDraftLeagueSchedule } from "../src/draftleague-protocol.js";
import { exportSeasonBundle } from "../src/export-season.js";
import { storeFranchiseRosterVersion } from "../src/league-journal.js";
import { commitRunArtifact } from "../src/run-artifact-store.js";
import { seriesRecordFixture } from "./fixtures/records.js";
import { storeCompletedSeriesFixture } from "./series-store-fixture.js";

test.each(["nested", "shared", "write failure"])(
  "exports a completed draw (%s destination)",
  (destination) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-export-season-draw-"));
    const runsDir = path.join(root, "runs");
    const runId = "20260826T120000.000000Z-draw0001";
    const runDir = path.join(runsDir, runId);
    const recordsPath = path.join(root, "records.jsonl");
    const models = ["openai:alpha", "openai:beta"];
    const names = ["Alpha Aces", "Beta Bandits"];
    const plan = buildDraftLeagueSchedule(2, 17).plans[0]!;
    assert.ok(plan.entrants);
    fs.mkdirSync(runDir, { recursive: true });
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
    storeFranchiseRosterVersion(runDir, [
      {
        rosterVersion: 0,
        entrant: 0,
        teamName: names[0]!,
        budget: 80,
        roster: [{ id: "charizard-mega-y", name: "Mega Charizard Y", cost: 20 }],
      },
      {
        rosterVersion: 0,
        entrant: 1,
        teamName: names[1]!,
        budget: 80,
        roster: [{ id: "floette-mega", name: "Mega Floette", cost: 20 }],
      },
    ]);
    commitRunArtifact(runDir, "draft-pick", "000001", {
      pick: 1,
      model: models[0]!,
      mon: "charizard-mega-y",
      name: "Mega Charizard Y",
      cost: 20,
      budget_left: 80,
    });
    commitRunArtifact(runDir, "draft-pick", "000002", {
      pick: 2,
      model: models[1]!,
      mon: "floette-mega",
      name: "Mega Floette",
      cost: 20,
      budget_left: 80,
    });
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
    storeCompletedSeriesFixture(
      runDir,
      seriesId,
      terminals.map((_terminal, index) => ({
        number: index + 1,
        logPath: path.join(seriesDir, `game-${index + 1}.log`),
        winner: index === 0 ? models[sides[0]]! : index === 1 ? models[sides[1]]! : null,
        winnerSide: index === 0 ? "p1" : index === 1 ? "p2" : null,
        turns: 5,
        seed: plan.gameSeeds[index]!,
      })),
    );

    const decisionBase = {
      kind: "decision",
      attempt_id: "canonical",
      game_id: `${seriesId}-1`,
      series_id: seriesId,
      game_number: 1,
      turn: 1,
      pid: "p1",
      phase: "turn",
      selection: ["Protect"],
      action: "move 1",
      rationale: "stated",
      automatic: false,
      fallback: false,
      latency_ms: 1200,
      total_tokens: 900,
      reasoning_tokens: 300,
      submission_source: "model",
      outcome: "accepted",
    };
    fs.writeFileSync(
      path.join(seriesDir, "p1-decisions.jsonl"),
      `${JSON.stringify({ ...decisionBase, submission_id: "sub-1" })}\n`,
    );
    const traceBase = {
      kind: "decision_trace",
      game_id: `${seriesId}-1`,
      game_number: 1,
      turn: 1,
      pid: "p1",
      phase: "turn",
      prompt: "PROMPT",
      raw_response: '{"choices":[0]}',
      usage: { output_tokens: 900, reasoning_tokens: 300 },
      latency_ms: 1200,
      max_tokens: 4096,
      timer: null,
      tool_calls: [{ name: "lookup_move", arguments: { name: "Protect" }, result: "Protect: ..." }],
      fallback: false,
      error: null,
    };
    fs.writeFileSync(
      path.join(seriesDir, "p1-trace.jsonl"),
      `${JSON.stringify({ ...traceBase, reasoning: "ABANDONED" })}\n${JSON.stringify({ ...traceBase, submission_id: "sub-1", reasoning: "FULL_TRACE" })}\n`,
    );

    try {
      const out = path.join(root, "public", "season-bundle.json");
      const tracesDir =
        destination === "shared" ? path.dirname(out) : path.join(root, "public", "traces");
      fs.mkdirSync(tracesDir, { recursive: true });
      const unrelated = path.join(tracesDir, "keep.txt");
      fs.writeFileSync(unrelated, "caller-owned file");
      fs.writeFileSync(out, "previous bundle");
      const options = {
        out,
        tracesDir,
        recordsPath,
        runsDir,
        runId,
        title: "Draw season",
        releasedThroughWeek: "all" as const,
        generatedAt: "2026-08-26T13:00:00.000Z",
      };
      if (destination === "write failure") {
        const manifestFile = path.join(tracesDir, "manifest.json");
        fs.writeFileSync(manifestFile, "previous manifest");
        fs.mkdirSync(path.join(tracesDir, `${runId}.jsonl.gz`));
        assert.throws(() => exportSeasonBundle(options));
        assert.equal(fs.readFileSync(out, "utf8"), "previous bundle");
        assert.equal(fs.readFileSync(manifestFile, "utf8"), "previous manifest");
        assert.equal(fs.readFileSync(unrelated, "utf8"), "caller-owned file");
        return;
      }
      const { bundle, traces } = exportSeasonBundle(options);
      assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), bundle);
      assert.equal(fs.readFileSync(unrelated, "utf8"), "caller-owned file");

      assert.equal(bundle.season.releasedThroughWeek, 1);
      assert.equal(bundle.weeks[0]?.matches[0]?.status, "complete");
      assert.equal(bundle.weeks[0]?.matches[0]?.winnerId, null);
      assert.deepEqual(bundle.weeks[0]?.matches[0]?.score, [1, 1]);
      assert.equal(bundle.replays[seriesId]?.games.length, 3);
      const decision = bundle.replays[seriesId]?.games[0]?.decisions[0];
      assert.equal(decision?.rationale, "stated");
      assert.equal(decision?.reasoningChars, "FULL_TRACE".length);
      assert.ok(!JSON.stringify(bundle).includes("FULL_TRACE"));
      const trace = traces.get(seriesId)?.[0]?.decisions[0];
      assert.equal(trace?.reasoning, "FULL_TRACE");
      assert.equal(trace?.franchiseId, `franchise-${sides[0]}`);
      assert.deepEqual(trace?.toolCalls[0]?.arguments, { name: "Protect" });

      const gameFile = JSON.parse(
        fs.readFileSync(path.join(tracesDir, seriesId, "game-1.json"), "utf8"),
      );
      assert.deepEqual(gameFile, traces.get(seriesId)?.[0]);
      assert.equal(gameFile?.runId, runId);
      const archive = gunzipSync(fs.readFileSync(path.join(tracesDir, `${runId}.jsonl.gz`)))
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(archive.length, 1);
      assert.equal(archive[0].seriesId, seriesId);
      assert.equal(archive[0].reasoning, "FULL_TRACE");
      const manifest = JSON.parse(fs.readFileSync(path.join(tracesDir, "manifest.json"), "utf8"));
      assert.deepEqual(manifest, {
        runId,
        generatedAt: "2026-08-26T13:00:00.000Z",
        archive: `${runId}.jsonl.gz`,
        digests: {
          [seriesId]: Object.fromEntries(
            traces
              .get(seriesId)!
              .map((game) => [
                game.game,
                createHash("sha256").update(JSON.stringify(game)).digest("hex"),
              ]),
          ),
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
