import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";

import { loadBoard } from "../src/draft.js";
import { emptyMemory } from "../src/franchise-memory.js";
import { seriesGameSummaries } from "../src/game-usage.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { defaultPsDir } from "../src/paths.js";
import type { CompleteOptions, Completion, JsonObject, ProviderMessage } from "../src/types.js";
import { asRecords, text } from "../src/value.js";
import {
  describeOwnBuild,
  narrateOwnSeries,
  narratePublicSeries,
  readWeeklyReviews,
  renderWeeklyReviewPrompt,
  runWeeklyReview,
  type WeeklyReviewSeries,
  type WeeklyReviewState,
} from "../src/weekly-review.js";

const USAGE = { input_tokens: 10, output_tokens: 5 };
const BOARD = loadBoard("regmb-202607");

function reply(text: string): Completion {
  return { text, finishReason: "stop", usage: USAGE, toolCalls: [] };
}

function toolCall(name: string, arguments_: JsonObject): Completion {
  return {
    text: "",
    finishReason: "tool-calls",
    usage: USAGE,
    toolCalls: [{ id: `call-${name}`, name, arguments: arguments_ }],
  };
}

function scripted(steps: Completion[]) {
  const calls: Array<{ system: string; messages: ProviderMessage[]; options: CompleteOptions }> =
    [];
  return {
    calls,
    provider: {
      complete(
        system: string,
        messages: ProviderMessage[],
        options: CompleteOptions = {},
      ): Promise<Completion> {
        calls.push({
          system,
          messages: structuredClone(messages),
          options: structuredClone(options),
        });
        const step = steps.shift();
        assert.ok(step, "the scripted provider ran out of replies");
        return Promise.resolve(step);
      },
    },
  };
}

function writeRun() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-weekly-review-"));
  const seriesDir = path.join(runDir, "series", "abc123");
  fs.mkdirSync(seriesDir, { recursive: true });
  const gameLog = [
    "|gametype|doubles",
    "|poke|p1|Charizard, L50, M|",
    "|poke|p2|Altaria, L50, M|",
    "|start",
    "|switch|p1a: Blaze|Charizard, L50, M|100/100",
    "|switch|p2a: Altaria|Altaria, L50, M|100/100",
    "|turn|1",
    "|-mega|p1a: Blaze|Charizard|Charizardite Y",
    "|detailschange|p1a: Blaze|Charizard-Mega-Y, L50, M",
    "|move|p1a: Blaze|Heat Wave|p2a: Altaria",
    "|faint|p1a: Blaze",
    "|win|p1-test:alpha",
    "",
  ].join("\n");
  const gameLogPath = path.join(seriesDir, "game-1.log");
  fs.writeFileSync(gameLogPath, gameLog);
  const head = { context_id: null, sequence: 0, byte_length: 0, sha256: "0".repeat(64) };
  const attempt = (attemptId: string) => ({
    kind: "attempt_started",
    schema_version: 1,
    timestamp: "2026-08-20T00:00:00.000Z",
    attempt_id: attemptId,
    series_id: "abc123",
    adopted_completed_games: 0,
    context_heads: { start: { p1: head, p2: head }, end: { p1: head, p2: head } },
  });
  fs.writeFileSync(
    path.join(seriesDir, "series-attempts.jsonl"),
    `${JSON.stringify(attempt("abandoned"))}\n${JSON.stringify(attempt("canonical"))}\n`,
  );
  fs.writeFileSync(
    path.join(seriesDir, "p1-decisions.jsonl"),
    `${JSON.stringify({ kind: "decision", attempt_id: "abandoned", game_number: 1, turn: 1, phase: "move", action: "move 4, move 4", rationale: "Stale branch.", outcome: "accepted", submission_id: "stale" })}\n${JSON.stringify({ kind: "decision", attempt_id: "canonical", game_number: 1, turn: 1, phase: "move", action: "move 1, move 1", rationale: "Pressure early.", outcome: "accepted", submission_id: "committed" })}\n${JSON.stringify({ kind: "game_reflection", attempt_id: "canonical", game_number: 1, result: "won", summary: "Earthquake landed.", adjustment: "Keep it." })}\n`,
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
        log: gameLogPath,
      },
    })}\n`,
  );
  fs.writeFileSync(path.join(seriesDir, "game-2.log"), "|switch|p1a: Stale|Ditto, L50|100/100\n");
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
        context: {
          0: "Round-robin week 1: beat random 2-0. Plan: lead Garchomp.",
          1: "Round-robin week 1: lost to test:alpha 0-2.",
        },
        builds: {
          0: {
            seriesIndex: 0,
            entrant: 0,
            opponent: 1,
            brought: [rosters[0]![0]!.id],
            sets: [
              {
                species: rosters[0]![0]!.species,
                item: "Charizardite Y",
                ability: "Blaze",
                nature: "Timid",
                moves: ["Heat Wave"],
                evs: { hp: 0, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
                note: "",
                spriteId: rosters[0]![0]!.id,
                repaired: false,
                repairs: [],
              },
            ],
            rationale: "Lead Mega Charizard Y.",
            attempts: 1,
          },
          1: {
            seriesIndex: 0,
            entrant: 1,
            opponent: 0,
            brought: ["altaria"],
            sets: [
              {
                species: "Altaria",
                item: "Leftovers",
                ability: "Natural Cure",
                nature: "Calm",
                moves: ["Protect"],
                evs: { hp: 32, atk: 0, def: 0, spa: 0, spd: 32, spe: 2 },
                note: "",
                spriteId: "altaria",
                repaired: false,
                repairs: [],
              },
            ],
            rationale: "Lead Altaria.",
            attempts: 1,
          },
        },
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
  return { runDir, state };
}

test("the weekly review prompt states the barrier, the period, the schedule, and the window ahead", () => {
  const { runDir, state } = writeRun();
  try {
    const prompt = renderWeeklyReviewPrompt(state, 0);
    assert.match(prompt, /week 1 of 3 is complete/);
    assert.match(prompt, /A transaction window opens as soon as this review closes/);
    assert.match(
      prompt,
      /YOUR SERIES THIS PERIOD:\n- Series 0, week 1: Round-robin week 1: beat random 2-0/,
    );
    assert.match(prompt, /YOUR REMAINING SCHEDULE[^\n]*\n- Week 2 \| random \|/);
    assert.match(prompt, /YOUR NOTEBOOK:\nStart with Garchomp\./);
    assert.match(
      renderWeeklyReviewPrompt({ ...state, nextWindowWeek: null }, 0),
      /Rosters are now locked/,
    );
    assert.match(
      renderWeeklyReviewPrompt({ ...state, nextWindowWeek: 3 }, 0),
      /next transaction window opens after week 3/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("own-build evidence lists what was left behind on the roster of the time, brought, and Mega Evolved", () => {
  const { runDir, state } = writeRun();
  try {
    const series = state.series[0]!;
    const builds = [
      series.builds[series.entrants[0]]!,
      series.builds[series.entrants[1]]!,
    ] as const;
    const summaries = seriesGameSummaries(
      path.join(runDir, "series", series.seriesId),
      series.seriesId,
      BOARD.mons,
      builds,
    );
    const description = describeOwnBuild(series, 0, summaries);
    assert.deepEqual(summaries, [
      {
        brought: [["charizard-mega-y"], ["altaria"]],
        fielded: [["charizard-mega-y"], ["altaria"]],
        megaEvolved: ["charizard-mega-y", null],
        faints: [{ "charizard-mega-y": 1 }, {}],
      },
    ]);
    assert.match(description, new RegExp(`Left behind: .*${state.rosters[0]![1]!.name}`));
    assert.doesNotMatch(description, new RegExp(state.rosters[1]![0]!.name));
    assert.match(description, /Game 1: brought Mega Charizard Y; Mega Evolved Mega Charizard Y$/m);
    assert.doesNotMatch(description, /Game 2:/);
    const traded: WeeklyReviewSeries = {
      ...series,
      rosters: { ...series.rosters, 0: [BOARD.mons[30]!] },
    };
    assert.match(describeOwnBuild(traded, 0), new RegExp(`Left behind: ${BOARD.mons[30]!.name}`));
    assert.doesNotMatch(describeOwnBuild(traded, 0), new RegExp(state.rosters[0]![1]!.name));
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("a reconciliation reviews only the changed seats against both rosters", async (t) => {
  const { runDir, state } = writeRun();
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const previousRosters = state.rosters.map((roster) => [...roster]);
  const swapped = BOARD.mons[20]!;
  state.rosters[0] = [...state.rosters[0]!.slice(1), swapped];
  const reconcile: WeeklyReviewState = {
    ...state,
    stage: "transactions",
    rosterVersion: 1,
    previousRosters,
    seats: [0],
    nextWindowWeek: 2,
  };
  const prompt = renderWeeklyReviewPrompt(reconcile, 0);
  assert.match(prompt, /window after round-robin week 1 of 3 has closed and your roster changed/);
  assert.match(
    prompt,
    new RegExp(`YOUR ROSTER BEFORE THE WINDOW: ${previousRosters[0]![0]!.name}`),
  );
  assert.match(prompt, new RegExp(`YOUR ROSTER NOW: .*${swapped.name}`));
  assert.doesNotMatch(prompt, /YOUR SERIES THIS PERIOD/);
  assert.match(prompt, /next transaction window opens after week 2/);
  const script = scripted([reply('{"notebook":"Rebuilt around the new six."}')]);
  const reviews = await runWeeklyReview(reconcile, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => script.provider,
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.stage, "transactions");
  assert.equal(reviews[0]!.roster_version, 1);
  assert.ok(fs.existsSync(path.join(runDir, "reviews", "week-1-transactions.jsonl")));
  assert.deepEqual(readWeeklyReviews(runDir, 1), [], "the week review file is untouched");
  assert.equal(state.memories[0]!.notebook, "Rebuilt around the new six.");
});

test("a coach keeps named pages, reads them back, and is refused an over-limit page with the reason", async (t) => {
  const { runDir, state } = writeRun();
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const week1 = scripted([
    reply(
      '{"notebook":"Lead Garchomp.","set_pages":{"opp.random":"Random brings nothing.","lessons":"' +
        "x".repeat(9_000) +
        '"}}',
    ),
    reply('{"notebook":"Lead Garchomp.","set_pages":{"opp.random":"Random brings nothing."}}'),
  ]);
  await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => week1.provider,
  });
  assert.equal(week1.calls.length, 2);
  assert.match(
    JSON.stringify(week1.calls[1]!.messages.at(-1)!.content),
    /page \\"lessons\\" is 9000 characters; the limit is 8000/,
  );
  assert.deepEqual(state.memories[0], {
    notebook: "Lead Garchomp.",
    "opp.random": "Random brings nothing.",
  });
  const stored = readWeeklyReviews(runDir, 1).find((row) => row.entrant === 0)!;
  assert.deepEqual(stored.memory, state.memories[0]);

  const week2State: WeeklyReviewState = { ...state, week: 2, period: [], nextWindowWeek: null };
  const prompt = renderWeeklyReviewPrompt(week2State, 0);
  assert.match(
    prompt,
    /YOUR NOTEBOOK:\nLead Garchomp\.\n\nYOUR MEMORY PAGES \(name \| characters \| first line\):\n- opp\.random \| 22 \| Random brings nothing\./,
  );
  const week2 = scripted([
    toolCall("read_memory_page", { name: "opp.random" }),
    toolCall("read_memory_history", { week: 1 }),
    toolCall("read_memory_history", { week: 1, stage: "transactions" }),
    toolCall("read_memory_history", { week: 2 }),
    reply('{"reasoning":"Nothing new."}'),
  ]);
  await runWeeklyReview(week2State, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => week2.provider,
  });
  const seatLog = readJsonlObjects(
    path.join(runDir, "reviews", "week-2", "seat-0-test-alpha.jsonl"),
  );
  const lookups = asRecords(seatLog[0]!.tool_lookups);
  assert.equal(lookups[0]!.result, "Random brings nothing.");
  assert.match(text(lookups[1]!.result), /YOUR MEMORY PAGE opp\.random:\nRandom brings nothing\./);
  assert.match(
    text(lookups[2]!.result),
    /no stored reconciliation for week 1\. Stored barriers: week 1 week\./,
  );
  assert.match(text(lookups[3]!.result), /no stored review for week 2/);
  assert.deepEqual(
    state.memories[0],
    { notebook: "Lead Garchomp.", "opp.random": "Random brings nothing." },
    "an empty reply keeps every page",
  );
});

test("set_pages merges, delete_pages removes, and the reconciliation snapshot is addressable by stage", async (t) => {
  const { runDir, state } = writeRun();
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  state.memories[0] = { notebook: "Start.", lessons: "Old lesson.", scouting: "Scouted." };
  const week1 = scripted([
    reply('{"set_pages":{"lessons":"New lesson."},"delete_pages":["scouting"]}'),
  ]);
  await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => week1.provider,
  });
  assert.deepEqual(state.memories[0], { notebook: "Start.", lessons: "New lesson." });
  const reconcile: WeeklyReviewState = {
    ...state,
    stage: "transactions",
    rosterVersion: 1,
    previousRosters: state.rosters.map((roster) => [...roster]),
    seats: [0],
  };
  const reconciled = scripted([
    toolCall("read_memory_history", { week: 1 }),
    reply('{"notebook":"Reconciled."}'),
  ]);
  await runWeeklyReview(reconcile, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => reconciled.provider,
  });
  const reconcileLog = readJsonlObjects(
    path.join(runDir, "reviews", "week-1-transactions", "seat-0-test-alpha.jsonl"),
  );
  const history = asRecords(reconcileLog[0]!.tool_lookups)[0]!;
  assert.match(
    text(history.result),
    /YOUR NOTEBOOK:\nStart\./,
    "the same-week review precedes its reconciliation",
  );
  const week2 = scripted([
    toolCall("read_memory_history", { week: 1, stage: "transactions" }),
    reply("{}"),
  ]);
  await runWeeklyReview(
    { ...state, week: 2, period: [], nextWindowWeek: null },
    { runDir, psDir: defaultPsDir(), makeReviewProvider: () => week2.provider },
  );
  const week2Log = readJsonlObjects(
    path.join(runDir, "reviews", "week-2", "seat-0-test-alpha.jsonl"),
  );
  const snapshot = asRecords(week2Log[0]!.tool_lookups)[0]!;
  assert.match(text(snapshot.result), /YOUR NOTEBOOK:\nReconciled\./);
});

test("a coach reads a series through its tools, replaces its notebook, and the row replays without a model", async (t) => {
  const { runDir, state } = writeRun();
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const script = scripted([
    toolCall("read_public_series", { series_index: 0 }),
    toolCall("read_own_series", { series_index: 0 }),
    reply('{"notebook":"Garchomp leads work; keep it.","reasoning":"Won cleanly."}'),
  ]);
  const reviews = await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => script.provider,
  });
  assert.equal(script.calls.length, 3, "two tool steps then the answer");
  assert.equal(reviews.length, 2);
  const alpha = reviews.find((review) => review.entrant === 0)!;
  assert.equal(alpha.memory.notebook, "Garchomp leads work; keep it.");
  assert.equal(alpha.reasoning, "Won cleanly.");
  assert.equal(alpha.fallback, false);
  const random = reviews.find((review) => review.entrant === 1)!;
  assert.equal(random.memory.notebook, "");
  assert.equal(random.fallback, false, "a random seat files no review and is not a fallback");
  assert.deepEqual(state.memories, [emptyMemory("Garchomp leads work; keep it."), emptyMemory()]);

  const series = state.series[0]!;
  const publicEvidence = narratePublicSeries(runDir, series, state.models);
  assert.match(publicEvidence, /test:alpha beat random 2-0/);
  assert.match(publicEvidence, /registers Charizard/);
  assert.match(publicEvidence, /T1 Blaze used Heat Wave/);
  const ownEvidence = narrateOwnSeries(runDir, series, 0);
  assert.match(ownEvidence, /T1: move 1, move 1 — Pressure early\./);
  assert.match(ownEvidence, /After the game \(won\): Earthquake landed\. Adjustment: Keep it\./);
  assert.doesNotMatch(ownEvidence, /Stale branch/);

  const replayed = await runWeeklyReview(
    { ...state, memories: [emptyMemory("Start with Garchomp."), emptyMemory()] },
    { runDir, psDir: defaultPsDir(), makeReviewProvider: () => scripted([]).provider },
  );
  assert.deepEqual(replayed, reviews, "a completed review replays from its rows");
});

test("a rejected reply is re-prompted with the reason and the attempt is logged", async (t) => {
  const { runDir, state } = writeRun();
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const script = scripted([reply("I would keep my plan."), reply('{"notebook":"Keep the plan."}')]);
  await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => script.provider,
  });
  assert.equal(script.calls.length, 2);
  const second = script.calls[1]!.messages.at(-1)!;
  assert.equal(second.role, "user");
  assert.match(
    JSON.stringify(second.content),
    /That review was rejected: the reply contained no JSON object/,
  );
  const seatLog = readJsonlObjects(
    path.join(runDir, "reviews", "week-1", "seat-0-test-alpha.jsonl"),
  );
  assert.equal(seatLog.length, 2);
  assert.equal(seatLog[0]!.error, "the reply contained no JSON object");
  assert.equal(seatLog[1]!.error, undefined);
  assert.equal(state.memories[0]!.notebook, "Keep the plan.");
});

test("a stored review stays attached to its entrant identity", async (t) => {
  const { runDir, state } = writeRun();
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewProvider: () => scripted([reply('{"notebook":"Next."}')]).provider,
  });
  const file = path.join(runDir, "reviews", "week-1.jsonl");
  const rows = readJsonlObjects(file);
  rows[0]!.model = "wrong:model";
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await assert.rejects(
    runWeeklyReview(
      { ...state, memories: [emptyMemory("Start with Garchomp."), emptyMemory()] },
      { runDir, psDir: defaultPsDir(), makeReviewProvider: () => scripted([]).provider },
    ),
    /holds a review .* entrant \d/,
  );
});
