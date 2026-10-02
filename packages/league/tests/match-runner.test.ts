import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import type { AgentRunner } from "../src/agent-runtime.js";
import { RandomEngine } from "../src/battle-agent.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { defaultPsDir } from "../src/paths.js";
import { readCompletedSeriesDecisionRows } from "../src/recorded-series.js";
import type { RecordedSeries, RecordedSeriesContext } from "../src/recorded-series.js";
import { MatchRunner, playBo3 } from "../src/series.js";
import { listStoredSeries, readStoredSeries } from "../src/series-store.js";
import { loadPool } from "../src/teams.js";
import type { JsonObject } from "../src/types.js";
import { asRecord } from "../src/value.js";
import { agentReply, agentRuntime } from "./agent-test-helpers.js";

interface Failures {
  decision?: number;
  review?: number;
  recordedReview?: number;
}

function concedingCoach(runDir: string, failures: Failures) {
  const pool = loadPool();
  const counts = { decisions: 0, reviews: 0, recordedReviews: 0 };
  const run: AgentRunner = async (task) => {
    if (task.task === "reflection") {
      counts.reviews += 1;
      if (counts.reviews === failures.review) throw new Error("coach disconnected");
      return agentReply(task, { summary: `Review ${counts.reviews}` });
    }
    counts.decisions += 1;
    if (counts.decisions === failures.decision) throw new Error("coach disconnected");
    const forfeit = /^ {2}(\d+)\. Forfeit the game/m.exec(task.prompt);
    return agentReply(task, { choices: forfeit ? [Number(forfeit[1]), 0] : [0, 1, 2, 3] });
  };
  const context: RecordedSeriesContext = {
    seriesIndex: 0,
    players: { p1: "scripted:conceder", p2: "random" },
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    engineSeeds: { p1: 1, p2: 2 },
    format: pool.format,
    psDir: defaultPsDir(),
    runDir,
    agents: agentRuntime(run),
    onDecision: (_pid, row) => {
      if (row.kind !== "game_reflection") return;
      counts.recordedReviews += 1;
      if (counts.recordedReviews === failures.recordedReview) throw new Error("database is locked");
    },
  };
  return { context, counts };
}

function reviewsOf(rows: JsonObject[]) {
  return rows
    .filter((row) => row.kind === "game_reflection")
    .map((row) => [row.game_number, row.summary]);
}

function countsOf(series: RecordedSeries) {
  const { decisions, reflections } = asRecord(series.fields.decision_stats.p1);
  return { decisions, reflections };
}

test("a review finished on resume stays with its game in completed evidence", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-match-runner-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const { context, counts } = concedingCoach(runDir, { decision: 2, review: 1 });

  await assert.rejects(new MatchRunner(context).run(), /coach disconnected/);
  const seriesId = listStoredSeries(runDir)[0]!.seriesId;
  assert.equal(readStoredSeries(runDir, seriesId)!.games.length, 0, "game 1 dies unresolved");

  await assert.rejects(new MatchRunner(context).run(), /coach disconnected/);
  const interrupted = readStoredSeries(runDir, seriesId)!;
  assert.equal(interrupted.games.length, 1);
  assert.equal(
    interrupted.adaptations.find((row) => row.pid === "p1")?.completedAt,
    undefined,
    "the attempt that resolved game 1 dies with the coach's review of it pending",
  );

  const finished = await new MatchRunner(context).run();
  assert.deepEqual(finished.fields.score, { p1: 0, p2: 2 });
  const stored = readStoredSeries(runDir, seriesId)!;
  const owners = stored.games.map((game) => game.attemptId);
  assert.deepEqual(owners, [interrupted.games[0]!.attemptId, stored.completedAttemptId]);

  const rows = readCompletedSeriesDecisionRows(runDir, seriesId, "p1");
  assert.deepEqual(reviewsOf(rows), [
    [1, "Review 2"],
    [2, "Review 3"],
  ]);
  assert.equal(
    rows.find((row) => row.kind === "game_reflection")?.attempt_id,
    stored.completedAttemptId,
    "the review of game 1 was written by a later attempt than the one that resolved it",
  );
  const decisionRows = rows.filter((row) => row.kind === "decision");
  assert.deepEqual(
    decisionRows.map((row) => [row.game_number, row.attempt_id]),
    [1, 1, 2, 2].map((game) => [game, owners[game - 1]]),
    "the decision of the attempt that died inside game 1 is not part of the resolved game",
  );

  assert.deepEqual(countsOf(finished), { decisions: 4, reflections: 2 });
  assert.deepEqual(countsOf(await new MatchRunner(context).run()), countsOf(finished));
  assert.equal(counts.reviews, 3, "adopting a completed series buys no review");
});

test("a series interrupted again after a review was finished on resume still resumes", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-match-runner-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const { context } = concedingCoach(runDir, { review: 1, decision: 4 });

  await assert.rejects(new MatchRunner(context).run(), /coach disconnected/);
  await assert.rejects(
    new MatchRunner(context).run(),
    /coach disconnected/,
    "the resumed attempt finishes game 1's review, then dies inside game 2",
  );
  const finished = await new MatchRunner(context).run();
  assert.deepEqual(finished.fields.score, { p1: 0, p2: 2 });
});

test("a review repeated on resume replaces the one whose commit failed", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-match-runner-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const { context } = concedingCoach(runDir, { recordedReview: 1 });

  await assert.rejects(new MatchRunner(context).run(), /database is locked/);
  const seriesId = listStoredSeries(runDir)[0]!.seriesId;
  assert.deepEqual(
    reviewsOf(readJsonlObjects(path.join(runDir, "series", seriesId, "p1-decisions.jsonl"))),
    [[1, "Review 1"]],
    "the review is on disk although its memory was never committed",
  );

  const finished = await new MatchRunner(context).run();
  assert.deepEqual(reviewsOf(readCompletedSeriesDecisionRows(runDir, seriesId, "p1")), [
    [1, "Review 2"],
    [2, "Review 3"],
  ]);
  assert.deepEqual(countsOf(finished), { decisions: 4, reflections: 2 });
  assert.deepEqual(countsOf(await new MatchRunner(context).run()), countsOf(finished));
});

test("a game winner that names neither side fails the series instead of recording a tie", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-winner-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    playBo3({
      engines: { p1: new RandomEngine("p1", 1), p2: new RandomEngine("p2", 2) },
      names: { p1: "p1-model-one", p2: "p2-model-two" },
      players: { p1: "model-one", p2: "model-two" },
      teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
      gameSeeds: [[1, 2, 3, 4]],
      seriesId: "series",
      seriesDir: directory,
      runDir: directory,
      format: "test",
      psDir: "",
      runBattle: async () => ({
        winner: "model-one",
        turns: 1,
        log: ["|win|model-one"],
        pov: { p1: [], p2: [] },
        errors: { p1: 0, p2: 0 },
        simulatorSubstitutions: { p1: 0, p2: 0 },
        timerAutodefaults: { p1: 0, p2: 0 },
      }),
    }),
    /winner "model-one" is neither "p1-model-one" nor "p2-model-two"/,
  );
  assert.equal(readStoredSeries(directory, "series")?.games.length, 0);
});
