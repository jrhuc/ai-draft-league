import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { emptyMemory } from "../src/franchise-memory.js";
import { defaultPsDir } from "../src/paths.js";
import type { TeamBuildView } from "../src/views.js";
import {
  narrateOwnSeries,
  narratePublicSeries,
  parseWeeklyReviewResult,
  readWeeklyReviews,
  renderWeeklyReviewPrompt,
  runWeeklyReview,
  type WeeklyReviewState,
} from "../src/weekly-review.js";
import { agentReply, scriptedAgent } from "./agent-test-helpers.js";
import { BOARD, mon } from "./draft-test-helpers.js";
import { storeCompletedSeriesFixture } from "./series-store-fixture.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const GAME_LOG =
  "|gametype|doubles\n|poke|p1|Charizard, L50, M|\n|poke|p2|Altaria, L50, M|\n|start\n|switch|p1a: Blaze|Charizard, L50, M|100/100\n|switch|p2a: Altaria|Altaria, L50, M|100/100\n|turn|1\n|move|p1a: Blaze|Heat Wave|p2a: Altaria\n|win|p1-test:alpha\n";

function fixture(gameLog = GAME_LOG) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-weekly-review-"));
  directories.push(runDir);
  const seriesDir = path.join(runDir, "series", "abc123");
  fs.mkdirSync(seriesDir, { recursive: true });
  const logPath = path.join(seriesDir, "game-1.log");
  fs.writeFileSync(logPath, gameLog);
  fs.writeFileSync(
    path.join(seriesDir, "p1-decisions.jsonl"),
    [
      {
        kind: "decision",
        attempt_id: "abandoned",
        game_number: 1,
        turn: 1,
        action: "move 4",
        rationale: "Stale branch",
        outcome: "accepted",
        submission_id: "stale",
      },
      {
        kind: "decision",
        attempt_id: "canonical",
        game_number: 1,
        turn: 1,
        action: "move 1",
        rationale: "Pressure early",
        outcome: "accepted",
        submission_id: "committed",
      },
      {
        kind: "game_reflection",
        attempt_id: "canonical",
        game_number: 1,
        result: "won",
        summary: "Conserve speed",
        adjustment: "Keep it",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  storeCompletedSeriesFixture(runDir, "abc123", [
    { number: 1, logPath, winner: "test:alpha", winnerSide: "p1" },
  ]);
  const rosters = [BOARD.mons.slice(0, 10), BOARD.mons.slice(10, 20)];
  const state: WeeklyReviewState = {
    board: BOARD,
    models: ["test:alpha", "random"],
    stage: "week",
    week: 1,
    weeks: 3,
    rosterVersion: 0,
    rosters,
    memories: [emptyMemory("Start with Garchomp."), emptyMemory()],
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    series: [
      {
        index: 0,
        week: 1,
        seriesId: "abc123",
        entrants: [0, 1],
        score: [2, 0],
        winner: 0,
        context: { 0: "Round-robin week 1: beat random 2-0", 1: "Lost 0-2" },
        builds: {},
        rosters: { 0: rosters[0]!, 1: rosters[1]! },
      },
    ],
    period: [0],
    schedule: [
      { index: 0, week: 1, entrants: [0, 1] },
      { index: 1, week: 2, entrants: [1, 0] },
    ],
    transactions: [],
    nextWindowWeek: 1,
  };
  return { runDir, state, options: { runDir, psDir: defaultPsDir() } };
}

test("weekly context states the review barrier, schedule, and private notebook", () => {
  const { state } = fixture();
  const prompt = renderWeeklyReviewPrompt(state, 0);
  assert.match(prompt, /week 1 of 3 is complete/);
  assert.match(prompt, /A transaction window opens as soon as this review closes/);
  assert.match(prompt, /Series 0, week 1: Round-robin week 1: beat random 2-0/);
  assert.match(prompt, /Week 2 \| random/);
  assert.match(prompt, /Start with Garchomp/);
  assert.match(
    renderWeeklyReviewPrompt({ ...state, nextWindowWeek: null }, 0),
    /Rosters are now locked/,
  );
});

test("review tools expose authoritative series evidence and completed reviews replay without inference", async () => {
  const { runDir, state, options } = fixture();
  const reviews = await runWeeklyReview(state, {
    ...options,
    runAgent: async (task) => {
      const own = task
        .tools!.find((tool) => tool.definition.name === "read_own_series")!
        .run({ series_index: 0 });
      assert.match(own, /Pressure early/);
      assert.match(own, /Conserve speed/);
      assert.doesNotMatch(own, /Stale branch/);
      const publicEvidence = task
        .tools!.find((tool) => tool.definition.name === "read_public_series")!
        .run({ series_index: 0 });
      assert.match(publicEvidence, /Blaze used Heat Wave/);
      assert.doesNotMatch(publicEvidence, /Pressure early|Conserve speed/);
      assert.throws(() => task.validate({ set_pages: { lessons: "x".repeat(9000) } }), /8000/);
      return agentReply(task, {
        plan: "Lead Garchomp",
        set_pages: { scouting: "Public tells" },
      });
    },
  });
  assert.equal(state.memories[0]!.scouting, "Public tells");
  assert.deepEqual(
    await runWeeklyReview(state, { ...options, runAgent: scriptedAgent([]).run }),
    reviews,
  );
  assert.match(narrateOwnSeries(runDir, state.series[0]!, 0), /Pressure early/);
  assert.match(narratePublicSeries(runDir, state.series[0]!, state.models), /Heat Wave/);
  await assert.rejects(
    runWeeklyReview(
      { ...state, models: ["wrong:model", "random"] },
      { ...options, runAgent: scriptedAgent([]).run },
    ),
    /stored week review/,
  );
});

test("read_own_build reports the registered six, who stayed home, and each game's bring, Mega, and losses", async () => {
  const { runDir, state, options } = fixture(
    [
      "|gametype|doubles",
      "|start",
      "|switch|p1a: Zard|Charizard, L50, M|100/100",
      "|switch|p1b: Chomp|Garchomp, L50, M|100/100",
      "|switch|p2a: Altaria|Altaria, L50, M|100/100",
      "|turn|1",
      "|-mega|p1a: Zard|Charizard|Charizardite Y",
      "|detailschange|p1a: Zard|Charizard-Mega-Y, L50, M",
      "|move|p1a: Zard|Heat Wave|p2a: Altaria",
      "|faint|p1b: Chomp",
      "|win|p1-test:alpha",
      "",
    ].join("\n"),
  );
  const roster = [
    "charizard-mega-y",
    "garchomp",
    "incineroar",
    "sinistcha",
    "farigiraf",
    "whimsicott",
    "pelipper",
    "toxapex",
    "grimmsnarl",
    "gholdengo",
  ].map(mon);
  const brought = roster.slice(0, 6);
  const build: TeamBuildView = {
    seriesIndex: 0,
    entrant: 0,
    opponent: 1,
    brought: brought.map((entry) => entry.id),
    sets: brought.map((entry) => ({
      species: entry.forme ?? entry.species,
      spriteId: entry.id,
      item: entry.item ?? "Leftovers",
      ability: "Blaze",
      nature: "Timid",
      moves: ["Protect"],
      evs: { hp: 4, spa: 252, spe: 252 },
    })),
    rationale: "Sun with Chomp as the physical breaker.",
    attempts: 1,
  };
  fs.appendFileSync(
    path.join(runDir, "series", "abc123", "p1-decisions.jsonl"),
    `${JSON.stringify({
      kind: "decision",
      attempt_id: "canonical",
      phase: "team_preview",
      outcome: "accepted",
      game_number: 1,
      action: "team 1234",
    })}\n`,
  );
  state.rosters[0] = roster;
  state.series[0]!.rosters[0] = roster;
  state.series[0]!.builds[0] = build;
  let report = "";
  await runWeeklyReview(state, {
    ...options,
    runAgent: async (task) => {
      report = task
        .tools!.find((tool) => tool.definition.name === "read_own_build")!
        .run({ series_index: 0 });
      return agentReply(task, {});
    },
  });
  assert.match(report, /Plan: Sun with Chomp/);
  assert.match(report, /^- Charizard-Mega-Y @ Charizardite Y;/m);
  assert.match(report, /^Left behind: Pelipper, Toxapex, Grimmsnarl, Gholdengo$/m);
  assert.match(
    report,
    /^Game 1: brought Mega Charizard Y, Garchomp, Incineroar, Sinistcha; Mega Evolved Mega Charizard Y; fainted Garchomp$/m,
  );
});

test("a weekly review reply keeps unmentioned pages and rejects invalid memory edits", () => {
  const current = { notebook: "Start", lessons: "Old" };
  assert.deepEqual(
    parseWeeklyReviewResult({ set_pages: { scouting: "Seen" }, reasoning: "  noted  " }, current),
    { memory: { notebook: "Start", lessons: "Old", scouting: "Seen" }, reasoning: "noted" },
  );
  assert.throws(
    () => parseWeeklyReviewResult({ delete_pages: ["notebook"] }, current),
    /cannot be deleted/,
  );
  assert.throws(
    () => parseWeeklyReviewResult({ set_pages: { "Bad Name": "x" } }, current),
    /page name "Bad Name"/,
  );
  assert.throws(() => parseWeeklyReviewResult({ plan: 5 }, current), /plan/);
  assert.equal(
    parseWeeklyReviewResult({ reasoning: "r".repeat(2500) }, current).reasoning,
    `${"r".repeat(2000)} [clipped]`,
  );
});

test("a retry after an oversized page resends only that page and keeps what was saved", async () => {
  const { state, options } = fixture();
  const script = scriptedAgent([
    { plan: "p".repeat(8001), set_pages: { scouting: "Public tells" } },
    { plan: "Short plan" },
  ]);
  await runWeeklyReview(state, { ...options, runAgent: script.run });
  assert.equal(script.rejections.length, 1);
  assert.match(script.rejections[0]!, /Not saved: plan is 8001 characters/);
  assert.match(script.rejections[0]!, /Saved: page "scouting"/);
  assert.equal(state.memories[0]!.notebook, "Short plan");
  assert.equal(state.memories[0]!.scouting, "Public tells");
});

test("reconciliation updates only changed seats and later reviews retrieve the exact memory snapshot", async () => {
  const { state, options } = fixture();
  state.memories[0] = { notebook: "Start", lessons: "Old lesson", scouting: "Scouted" };
  await runWeeklyReview(state, {
    ...options,
    runAgent: scriptedAgent([{ set_pages: { lessons: "New lesson" }, delete_pages: ["scouting"] }])
      .run,
  });
  const reconcile: WeeklyReviewState = {
    ...state,
    stage: "transactions",
    rosterVersion: 1,
    previousRosters: state.rosters.map((roster) => [...roster]),
    seats: [0],
  };
  assert.match(renderWeeklyReviewPrompt(reconcile, 0), /YOUR ROSTER BEFORE THE WINDOW/);
  const reviews = await runWeeklyReview(reconcile, {
    ...options,
    runAgent: scriptedAgent([{ plan: "Reconciled" }]).run,
  });
  assert.equal(reviews.length, 1);
  await runWeeklyReview(
    { ...state, week: 2, period: [], nextWindowWeek: null },
    {
      ...options,
      runAgent: async (task) => {
        const tool = task.tools!.find((tool) => tool.definition.name === "read_memory_history")!;
        assert.match(tool.run({ week: 1 }), /YOUR NOTEBOOK:\nStart/);
        assert.match(tool.run({ week: 1, stage: "transactions" }), /YOUR NOTEBOOK:\nReconciled/);
        assert.match(tool.run({ week: 2 }), /no stored review/);
        assert.equal(
          task
            .tools!.find((tool) => tool.definition.name === "read_memory_page")!
            .run({ name: "lessons" }),
          "New lesson",
        );
        return agentReply(task, {});
      },
    },
  );
  assert.deepEqual(state.memories[0], { notebook: "Reconciled", lessons: "New lesson" });
  assert.equal(readWeeklyReviews(options.runDir, 1).length, 2);
});

test("history pagination reaches the end of a long private series", async () => {
  const { runDir, state, options } = fixture();
  const rows = Array.from({ length: 35 }, (_, turn) => ({
    kind: "decision",
    attempt_id: "canonical",
    game_number: 1,
    turn: turn + 2,
    action: "move 1",
    rationale: "e".repeat(1000),
  }));
  fs.appendFileSync(
    path.join(runDir, "series", "abc123", "p1-decisions.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") +
      '\n{"kind":"game_reflection","attempt_id":"canonical","game_number":1,"result":"won","summary":"Recoverable ending"}\n',
  );
  await runWeeklyReview(state, {
    ...options,
    runAgent: async (task) => {
      const tool = task.tools!.find((tool) => tool.definition.name === "read_own_series")!;
      assert.match(tool.run({ series_index: 0 }), /repeat this query with offset 24000/);
      assert.match(tool.run({ series_index: 0, offset: 24000 }), /Recoverable ending/);
      return agentReply(task, {});
    },
  });
});
