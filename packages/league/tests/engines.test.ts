import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RandomEngine } from "../src/battle-agent.js";
import { LLMEngine } from "../src/llm-engine.js";
import {
  CLOSED_SERIES_REFLECTION_SYSTEM,
  DRAFT_SERIES_REFLECTION_SYSTEM,
  REFLECTION_SYSTEM,
} from "../src/prompts.js";
import { ApiError } from "../src/providers.js";
import { SimBattle } from "../src/sim.js";
import { loadPool } from "../src/teams.js";
import type {
  AgentContext,
  BattleRequest,
  Completion,
  JsonObject,
  SubmissionContext,
} from "../src/types.js";
import { asRecord, asRecords, text } from "../src/value.js";
import {
  acceptedAct,
  decision,
  emptyStats,
  oneMoveStats,
  request,
  ScriptedProvider,
  notebook,
} from "./engine-test-helpers.js";

test("a decision written only in the reasoning channel is salvaged without a retry", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      reasoning: `Let me weigh the options carefully. Protect risks a double-up. Final answer: ${decision([1], "salvaged from reasoning", "noted")}`,
      usage: { input_tokens: 10, output_tokens: 900, reasoning_tokens: 899 },
      toolCalls: [],
    },
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 2");
  assert.equal(provider.calls.length, 1, "the answer already paid for is used instead of a retry");
  assert.equal(decisions[0]!.fallback, false);
  assert.equal(decisions[0]!.rationale, "salvaged from reasoning");
});

test("primed replay requires an exact request digest and seat provenance", async () => {
  const game = { gameId: "game-1", gameNumber: 1, seriesId: "series-1" };
  const recorded: JsonObject[] = [];
  const source = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([decision([0], "recorded choice", "carried plan")]),
    decisionLog: recorded,
  });
  source.beginGame(game);
  const first = await source.submit(request(), {
    povLines: ["|turn|1"],
    submissionId: "attempt-one:p1:1",
  });
  assert.ok(first);
  source.resolveSubmission(first, "rejected", "|error|[Invalid choice] test rejection");
  const row = structuredClone(recorded[0]!);
  assert.match(text(row.request_digest), /^battle-decision-request-v1:[a-f0-9]{64}$/);

  const provider = new ScriptedProvider([decision([1], "live again")]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  engine.beginGame(game);
  engine.primeReplay([row]);
  const replayed = await engine.submit(request(), {
    povLines: ["|turn|1"],
    submissionId: "attempt-two:p1:1",
  });
  assert.ok(replayed);
  assert.equal(replayed.choice, "move 1");
  engine.resolveSubmission(replayed, "rejected", "|error|[Invalid choice] test rejection");
  assert.equal(
    provider.calls.length,
    0,
    "an exactly matching reject replay costs no provider call",
  );
  assert.equal(decisions.length, 0, "a replayed terminal row is not logged again");
  assert.equal(engine.coachingNote(), "carried plan");
  const live = await engine.submit(request(), {
    povLines: ["|turn|2"],
    submissionId: "attempt-two:p1:2",
  });
  assert.ok(live);
  engine.resolveSubmission(live, "accepted");
  assert.equal(provider.calls.length, 1);
  assert.equal(decisions[0]?.submission_id, "attempt-two:p1:2");
  assert.match(String(provider.calls[0]!.messages[0]!.content), /Decision: move 1/);

  const expectLiveDecision = async (
    label: string,
    replayRow: JsonObject,
    battleRequest = request(),
    liveChoice = 1,
  ) => {
    const liveProvider = new ScriptedProvider([decision([liveChoice], "bound live")]);
    const liveEngine = new LLMEngine("p1", "scripted", { provider: liveProvider, decisionLog: [] });
    liveEngine.beginGame(game);
    liveEngine.primeReplay([replayRow]);
    assert.equal(
      await acceptedAct(liveEngine, battleRequest, { povLines: ["|turn|1"] }),
      "move 2",
      label,
    );
    assert.equal(liveProvider.calls.length, 1, label);
  };

  await expectLiveDecision("wrong pid", { ...row, pid: "p2" });
  await expectLiveDecision("wrong series", { ...row, series_id: "series-2" });
  await expectLiveDecision("wrong game number", { ...row, game_number: 2 });
  await expectLiveDecision("wrong turn", { ...row, turn: 2 });
  await expectLiveDecision("wrong phase", { ...row, phase: "forced_switch" });

  const changed = request();
  changed.active = [
    {
      moves: [
        { move: "First", id: "first", pp: 9, maxpp: 10, target: "self", disabled: false },
        { move: "Second", id: "second", pp: 10, maxpp: 10, target: "self", disabled: false },
      ],
    },
  ];
  await expectLiveDecision("same-turn request and menu changed", row, changed, 1);

  const unbound = { ...row };
  delete unbound.request_digest;
  await expectLiveDecision("row without a request digest", unbound);
});

test("transitive replay preserves accepted prefixes, rejected retries, and a live tail without re-journaling", async () => {
  const game = { gameId: "game-lineage", gameNumber: 1, seriesId: "series-lineage" };
  const rowsA: JsonObject[] = [];
  const attemptA = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([decision([0]), decision([1])]),
    decisionLog: rowsA,
  });
  attemptA.beginGame(game);
  const a1 = await attemptA.submit(request(), { povLines: ["|turn|1"], submissionId: "A:p1:1" });
  assert.ok(a1);
  attemptA.resolveSubmission(a1, "accepted");
  const a2 = await attemptA.submit(request(), { povLines: ["|turn|2"], submissionId: "A:p1:2" });
  assert.ok(a2);
  attemptA.resolveSubmission(a2, "rejected", "|error|[Invalid choice] retry");

  const rowsB: JsonObject[] = [];
  const providerB = new ScriptedProvider([decision([0])]);
  const attemptB = new LLMEngine("p1", "scripted", { provider: providerB, decisionLog: rowsB });
  attemptB.beginGame(game);
  attemptB.primeReplay(rowsA);
  const b1 = await attemptB.submit(request(), { povLines: ["|turn|1"], submissionId: "B:p1:1" });
  assert.ok(b1);
  attemptB.resolveSubmission(b1, "accepted");
  const b2 = await attemptB.submit(request(), { povLines: ["|turn|2"], submissionId: "B:p1:2" });
  assert.ok(b2);
  attemptB.resolveSubmission(b2, "rejected", "|error|[Invalid choice] retry");
  const b3 = await attemptB.submit(request(), {
    povLines: [],
    error: "|error|[Invalid choice] retry",
    submissionId: "B:p1:3",
  });
  assert.ok(b3);
  attemptB.resolveSubmission(b3, "accepted");
  assert.equal(providerB.calls.length, 1);
  assert.equal(rowsB.length, 1, "A replay rows are not journaled into B");

  const rowsC: JsonObject[] = [];
  const providerC = new ScriptedProvider([]);
  const attemptC = new LLMEngine("p1", "scripted", { provider: providerC, decisionLog: rowsC });
  attemptC.beginGame(game);
  attemptC.primeReplay([...rowsA, ...rowsB]);
  for (const [povLines, outcome, error] of [
    [["|turn|1"], "accepted", undefined],
    [["|turn|2"], "rejected", "|error|[Invalid choice] retry"],
    [[], "accepted", undefined],
  ] as const) {
    const context: SubmissionContext = {
      povLines: [...povLines],
      submissionId: `C:p1:${povLines.join()}:${outcome}`,
    };
    if (error) context.error = error;
    const replayed = await attemptC.submit(request(), context);
    assert.ok(replayed);
    attemptC.resolveSubmission(replayed, outcome, error);
  }
  assert.equal(providerC.calls.length, 0);
  assert.equal(rowsC.length, 0, "the full A to B lineage remains single-copy evidence");
  assert.equal(new Set([...rowsA, ...rowsB].map((row) => row.submission_id)).size, 3);
});

test("exact replay includes automatic transitions while model-position eligibility stays narrow", async () => {
  const game = { gameId: "game-automatic", gameNumber: 1, seriesId: "series-automatic" };
  const automatic = request();
  automatic.active = [
    { moves: [{ move: "Only", id: "only", pp: 10, maxpp: 10, target: "self", disabled: false }] },
  ];
  const recorded: JsonObject[] = [];
  const source = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([decision([0]), decision([1])]),
    decisionLog: recorded,
  });
  source.beginGame(game);
  for (const [battleRequest, povLines, id] of [
    [request(), ["|turn|1"], "model-1"],
    [automatic, ["|turn|2"], "automatic"],
    [request(), ["|turn|3"], "model-2"],
  ] as const) {
    const submission = await source.submit(battleRequest, {
      povLines: [...povLines],
      submissionId: id,
    });
    assert.ok(submission);
    source.resolveSubmission(submission, "accepted");
  }
  assert.deepEqual(
    recorded.map((row) => row.submission_source),
    ["model", "automatic", "model"],
  );
  assert.equal(
    recorded.filter(
      (row) =>
        row.outcome === "accepted" && row.submission_source === "model" && row.fallback !== true,
    ).length,
    2,
  );

  const replayLog: JsonObject[] = [];
  const provider = new ScriptedProvider([]);
  const replay = new LLMEngine("p1", "scripted", { provider, decisionLog: replayLog });
  replay.beginGame(game);
  replay.primeReplay(recorded);
  for (const [battleRequest, povLines, id] of [
    [request(), ["|turn|1"], "replay-model-1"],
    [automatic, ["|turn|2"], "replay-automatic"],
    [request(), ["|turn|3"], "replay-model-2"],
  ] as const) {
    const submission = await replay.submit(battleRequest, {
      povLines: [...povLines],
      submissionId: id,
    });
    assert.ok(submission);
    replay.resolveSubmission(submission, "accepted");
  }
  assert.equal(provider.calls.length, 0);
  assert.equal(replayLog.length, 0);
});

test("LLM choices parse prose, retry, and record fallbacks", async () => {
  const cases: Array<[Array<string>, string, boolean, number, number]> = [
    [[decision([1], "remember speed", "remember speed")], "move 2", false, 1, 0],
    [[`I choose this: ${decision([1], "reason", "x")}.`], "move 2", false, 1, 0],
    [[`${decision([0])} then ${decision([1])}`], "move 2", false, 1, 0],
    [[`${decision([1])} earlier draft was {"choices":[9]}`], "move 2", false, 1, 0],
    [["invalid", decision([1])], "move 2", false, 2, 1],
    [["invalid", decision([9]), "invalid", decision([9])], "move 1", true, 4, 4],
  ];
  for (const [responses, expected, fallback, calls, parseFailures] of cases) {
    const provider = new ScriptedProvider(responses);
    const decisions: JsonObject[] = [];
    const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
    assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), expected);
    assert.equal(decisions[0]!.fallback, fallback);
    assert.equal(decisions[0]!.parse_failures, parseFailures);
    assert.deepEqual(engine.decisionStats(), {
      ...oneMoveStats,
      fallbacks: Number(fallback),
      parse_failures: parseFailures,
    });
    assert.equal(provider.calls.length, calls);
  }
});

test("battle evidence flags follow model field presence rather than harness summaries", async () => {
  const cases: Array<{
    name: string;
    responses: string[];
    expectedEvidence: { rationale: boolean; notebook_update: boolean };
    expectedNotebook: string;
    expectedRationale: string | RegExp;
    fallback?: boolean;
  }> = [
    {
      name: "rationale only",
      responses: [JSON.stringify({ choices: [1], rationale: "  model reason  " })],
      expectedEvidence: { rationale: true, notebook_update: false },
      expectedNotebook: "Keep the current plan.",
      expectedRationale: "model reason",
    },
    {
      name: "notebook only",
      responses: [JSON.stringify({ choices: [1], notebook: notebook("  Revised plan.  ") })],
      expectedEvidence: { rationale: false, notebook_update: true },
      expectedNotebook: "Revised plan.",
      expectedRationale: "No rationale supplied.",
    },
    {
      name: "explicit empty strings",
      responses: [JSON.stringify({ choices: [1], rationale: "   ", notebook: notebook("   ") })],
      expectedEvidence: { rationale: true, notebook_update: true },
      expectedNotebook: "",
      expectedRationale: "No rationale supplied.",
    },
    {
      name: "absent non-string evidence",
      responses: [JSON.stringify({ choices: [1], rationale: null, notebook: false })],
      expectedEvidence: { rationale: false, notebook_update: false },
      expectedNotebook: "Keep the current plan.",
      expectedRationale: "No rationale supplied.",
    },
    {
      name: "parse fallback",
      responses: ["invalid", "invalid", "invalid", "invalid"],
      expectedEvidence: { rationale: false, notebook_update: false },
      expectedNotebook: "Keep the current plan.",
      expectedRationale: /defaulted to the first legal option/,
      fallback: true,
    },
  ];

  for (const item of cases) {
    const logs: JsonObject[] = [];
    const engine = new LLMEngine("p1", "scripted", {
      provider: new ScriptedProvider(item.responses),
      decisionLog: logs,
      initialNotebook: "Keep the current plan.",
    });
    await acceptedAct(engine, request(), { povLines: ["|turn|1"] });

    assert.deepEqual(logs[0]!.evidence_supplied, item.expectedEvidence, item.name);
    assert.equal(engine.coachingNote(), item.expectedNotebook, item.name);
    if (item.expectedRationale instanceof RegExp)
      assert.match(text(logs[0]!.rationale), item.expectedRationale, item.name);
    else assert.equal(logs[0]!.rationale, item.expectedRationale, item.name);
    assert.equal(logs[0]!.fallback, item.fallback ?? false, item.name);
  }

  const logs: JsonObject[] = [];
  const provider = new ScriptedProvider([]);
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    decisionLog: logs,
    initialNotebook: "Keep the current plan.",
  });
  const automatic = request();
  automatic.active = [
    {
      moves: [{ move: "First", id: "first", pp: 10, maxpp: 10, target: "self", disabled: false }],
    },
  ];
  assert.equal(await acceptedAct(engine, automatic, { povLines: ["|turn|1"] }), "move 1");
  assert.equal(provider.calls.length, 0);
  assert.equal(logs[0]!.rationale, "Automatic: only one legal joint action.");
  assert.deepEqual(logs[0]!.evidence_supplied, { rationale: false, notebook_update: false });
  assert.equal(engine.coachingNote(), "Keep the current plan.");
});

test("full seat context retains request snapshots and complete accepted decision menus", async () => {
  const provider = new ScriptedProvider(['{"choices":[1]}']);
  const contextRows: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, contextLog: contextRows });
  const battleRequest = request();
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });
  assert.equal(await acceptedAct(engine, battleRequest, { povLines: ["|turn|1"] }), "move 2");
  battleRequest.active![0]!.moves = [];

  const context = engine.readContext();
  assert.deepEqual(
    context.events.map((event) => event.kind),
    ["episode", "observation", "observation", "decision"],
  );
  assert.equal(context.nextCursor, "ctx-00000004");
  assert.equal(context.headCursor, "ctx-00000004");
  assert.deepEqual(context.events[1]!.payload.lines, ["|turn|1"]);
  assert.equal(context.events[2]!.payload.event, "battle_request");
  assert.deepEqual(context.events[2]!.payload.request, request());
  assert.equal("opponent" in asRecord(context.events[2]!.payload.request), false);
  assert.deepEqual(context.events[3]!.payload.menus, [
    [
      { label: "First", part: "move 1", kind: "move" },
      { label: "Second", part: "move 2", kind: "move" },
      { label: "Forfeit the game (concede the loss)", part: "forfeit", kind: "forfeit" },
    ],
  ]);
  const page = engine.readContext({ after: "ctx-00000001", limit: 1 });
  assert.deepEqual(page.events[0]?.payload.lines, ["|turn|1"]);
  assert.equal(page.nextCursor, "ctx-00000002");
  assert.equal(page.headCursor, "ctx-00000004");
  assert.deepEqual(
    contextRows.map((row) => ({
      context_id: row.context_id,
      pid: row.pid,
      series_id: row.series_id,
    })),
    [
      { context_id: "ctx-00000001", pid: "p1", series_id: "series-1" },
      { context_id: "ctx-00000002", pid: "p1", series_id: "series-1" },
      { context_id: "ctx-00000003", pid: "p1", series_id: "series-1" },
      { context_id: "ctx-00000004", pid: "p1", series_id: "series-1" },
    ],
  );
});

test("a context log failure does not expose an unpersisted cursor and retry reuses it", () => {
  const contextRows: JsonObject[] = [];
  let fail = true;
  const engine = new LLMEngine("p1", "scripted", {
    provider: new ScriptedProvider([]),
    contextLog: (row) => {
      if (fail) {
        fail = false;
        throw new Error("disk append failed");
      }
      contextRows.push(row);
    },
  });
  const game = { gameId: "game-1", gameNumber: 1, seriesId: "series-1" };

  assert.throws(() => engine.beginGame(game), /disk append failed/);
  assert.equal(engine.readContext().headCursor, null);
  assert.deepEqual(engine.readContext().events, []);
  engine.beginGame(game);
  assert.equal(engine.readContext().headCursor, "ctx-00000001");
  assert.deepEqual(
    engine.readContext().events.map((event) => event.id),
    ["ctx-00000001"],
  );
  assert.deepEqual(
    contextRows.map((row) => row.context_id),
    ["ctx-00000001"],
  );
});

test("Gemini-like nested candidate objects preserve the complete top-level decision", async () => {
  const longCandidate = "candidate ".repeat(40);
  const provider = new ScriptedProvider([
    JSON.stringify({
      choices: [1],
      rationale: "use the top-level choice",
      notebook: notebook("n".repeat(1800)),
      threats: [
        "direct threat",
        { rationale: "not a threat" },
        7,
        "second threat",
        "third threat",
        "capped",
      ],
      candidates: [
        { choices: [0], rationale: longCandidate, notebook: "nested notebook" },
        { choices: [0], rationale: "second nested line", notebook: "nested notebook" },
        { choices: [0], rationale: 7 },
        { choices: [0], rationale: "third nested line" },
        { choices: [0], rationale: "capped line" },
      ],
    }),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });

  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 2");
  assert.equal(provider.calls.length, 1);
  assert.equal(decisions[0]!.fallback, false);
  assert.equal(decisions[0]!.parse_failures, 0);
  assert.equal(decisions[0]!.rationale, "use the top-level choice");
  assert.equal(
    text(decisions[0]!.notebook).length,
    1800,
    "well under the notebook backstop, kept whole",
  );
});

test("timer context reaches the provider request", async () => {
  const provider = new ScriptedProvider([decision([0])]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  const timed = request();
  timed.timer = { turnSeconds: 55, seconds: 420 };
  assert.equal(await acceptedAct(engine, timed, { povLines: [] }), "move 1");
  const call = provider.calls[0]!;
  assert.match(String(call.messages.at(-1)!.content), /Showdown timer: 55 seconds/);
});

test(
  "simulator timer restarts while an invalid choice is retried",
  { timeout: 20_000 },
  async () => {
    class InvalidOnceEngine extends RandomEngine {
      private invalid = true;
      readonly timerBanks: number[] = [];

      override async act(battleRequest: BattleRequest, context: AgentContext): Promise<string> {
        if (battleRequest.active && battleRequest.timer?.seconds !== undefined)
          this.timerBanks.push(battleRequest.timer.seconds);
        if (this.invalid && battleRequest.active && !battleRequest.teamPreview) {
          this.invalid = false;
          return "move 99";
        }
        return super.act(battleRequest, context);
      }
    }

    const pool = loadPool();
    const timerLines: string[] = [];
    const retrying = new InvalidOnceEngine("p1", 1);
    const battle = new SimBattle(
      pool.format,
      {
        p1: { name: "invalid-once", team: pool.teams[0]!.packed },
        p2: { name: "random", team: pool.teams[1]!.packed },
      },
      [1, 2, 3, 4],
      undefined,
      1,
    );
    const outcome = await battle.run({ p1: retrying, p2: new RandomEngine("p2", 2) }, (lines) =>
      timerLines.push(...lines.filter((line) => line.includes("vgctimer"))),
    );
    assert.ok(outcome.errors.p1 >= 1);
    assert.ok(retrying.timerBanks[1]! < retrying.timerBanks[0]!);
    assert.equal(
      timerLines.filter((line) => line.startsWith("|-vgctimer|p1|")).length,
      timerLines.filter((line) => line === "|-vgctimerstop|p1").length,
    );
  },
);

test("doubles use one call and retain compact private context", async () => {
  const provider = new ScriptedProvider([
    decision([0, 1], "Preserve the observed speed order.", "Garchomp was faster"),
    decision([1, 0], "Use the speed read.", "keep the speed read"),
  ]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  assert.equal(
    await acceptedAct(engine, request(2), {
      povLines: ["|switch|p2a: Garchomp|Garchomp, L50|100/100", "|turn|1"],
    }),
    "move 1, move 2",
  );
  assert.equal(
    await acceptedAct(engine, request(2), { povLines: ["|move|p2a: Garchomp|Rock Slide"] }),
    "move 2, move 1",
  );
  const prompt = String(provider.calls[1]!.messages.at(-1)!.content);
  assert.match(prompt, /Garchomp was faster/);
  assert.match(prompt, /Decision: move 1, move 2/);
  assert.match(prompt, /Rock Slide/);
  assert.doesNotMatch(prompt, /\|move\|p2a/);
  assert.doesNotMatch(prompt, /\bL50\b/);
  assert.match(prompt, /Garchomp; types Dragon\/Ground/);
  assert.match(prompt, /Rock Slide \[Rock\/Physical\/75\/spread\/accuracy 90%\]/);
  assert.doesNotMatch(prompt, /Compact Showdown reference/);
});

test("provider failures abort while persistent empty answers use a legal fallback", async () => {
  const broken = new LLMEngine("p1", "broken", {
    provider: new ScriptedProvider([new Error("bad credentials")]),
    decisionLog: [],
  });
  await assert.rejects(acceptedAct(broken, request(), { povLines: [] }), /bad credentials/);
  assert.deepEqual(broken.decisionStats(), emptyStats);

  const empty = new LLMEngine("p1", "empty", {
    provider: new ScriptedProvider(["", "", ""]),
    decisionLog: [],
  });
  assert.match(await acceptedAct(empty, request(), { povLines: [] }), /move/);
  assert.deepEqual(empty.decisionStats(), { ...oneMoveStats, fallbacks: 1 });
});

test("DSML tool-call markup gets a reprompt naming the problem", async () => {
  const provider = new ScriptedProvider([
    '<｜｜DSML｜｜invoke name="estimate_damage"><｜｜DSML｜｜parameter name="attacker">Gholdengo</｜｜DSML｜｜parameter>',
    decision([1]),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 2");
  assert.equal(decisions[0]!.fallback, false);
  const reprompt = String(provider.calls[1]!.messages.at(-1)?.content);
  assert.match(reprompt, /tool-call markup as plain text/);
});

test("unoffered native tools are recorded, refused, and reprompted without dispatch", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      usage: { output_tokens: 3 },
      toolCalls: [
        { id: "unoffered-1", name: "search_board", arguments: { type: "Water" } },
        { id: "unknown-1", name: "change_battle_result", arguments: { winner: "p1" } },
      ],
    },
    decision([1], "The researched choice remains mine.", "preserve the plan"),
  ]);
  const decisions: JsonObject[] = [];
  const traces: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", {
    provider,
    decisionLog: decisions,
    traceLog: traces,
  });
  assert.equal(await acceptedAct(engine, request(), { povLines: [] }), "move 2");
  const refusals = provider.calls[1]!.messages.filter((message) => message.role === "tool");
  assert.match(
    String(refusals[0]?.content),
    /Not executed: tool "search_board" was not offered for this decision/,
  );
  assert.match(
    String(refusals[1]?.content),
    /Not executed: tool "change_battle_result" was not offered for this decision/,
  );
  const toolTrace = asRecords(traces[0]!.tool_calls);
  assert.equal(toolTrace.length, 2);
  assert.ok(toolTrace.every((entry) => /Not executed/.test(text(entry.result))));
  assert.equal(decisions[0]!.rationale, "The researched choice remains mine.");
  assert.deepEqual(decisions[0]!.evidence_supplied, { rationale: true, notebook_update: true });
  assert.equal(
    engine.decisionStats().tool_lookups,
    2,
    "refused requests remain visible in audit counts",
  );
});

test("a tool-call-only final answer is retried untimed instead of defaulting", async () => {
  const toolOnly: Completion = {
    text: "",
    usage: { input_tokens: 5, output_tokens: 1 },
    toolCalls: [{ id: "call_1", name: "lookup_move", arguments: { name: "protect" } }],
    finishReason: "stop",
  };
  const provider = new ScriptedProvider([
    toolOnly,
    toolOnly,
    toolOnly,
    toolOnly,
    toolOnly,
    decision([1]),
  ]);
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: decisions });
  assert.equal(await acceptedAct(engine, request(), { povLines: ["|turn|1"] }), "move 2");
  assert.equal(decisions[0]!.fallback, false);
  assert.equal(provider.calls.length, 6);
});

test("the timeline renders Protect blocks explicitly instead of a generic activation", async () => {
  const provider = new ScriptedProvider([decision([0], "noted")]);
  const engine = new LLMEngine("p1", "scripted", { provider, decisionLog: [] });
  engine.beginGame({ gameId: "game-1", gameNumber: 1, seriesId: "series-1" });
  engine.observe([
    "|move|p1b: Metagross|Protect|p1b: Metagross",
    "|move|p2b: Politoed|Encore|p1b: Metagross",
    "|-activate|p1b: Metagross|move: Protect",
    "|-activate|p2a: Gengar|move: Destiny Bond",
  ]);
  await acceptedAct(engine, request(), { povLines: [] });

  const prompt = String(provider.calls[0]!.messages[0]!.content);
  assert.match(prompt, /Metagross's Protect blocked the incoming move/);
  assert.match(prompt, /Gengar activated move: Destiny Bond/);
});

test("transient provider failures with a live timer leave the choice to the battle timer", async () => {
  const decisions: JsonObject[] = [];
  const logged = Promise.withResolvers<void>();
  const engine = new LLMEngine("p1", "dead", {
    provider: new ScriptedProvider([new ApiError(503, "overloaded")]),
    traceLog: (row) => {
      decisions.push(row);
      logged.resolve();
    },
  });
  const timed = request();
  timed.timer = { turnSeconds: 10, seconds: 420 };
  let resolved = false;
  const pending = acceptedAct(engine, timed, { povLines: [] }).then((choice) => {
    resolved = true;
    return choice;
  });
  await logged.promise;
  assert.equal(resolved, false, "the engine waits for the battle timer instead of throwing");
  assert.equal(decisions[0]!.fallback, true);
  assert.equal(decisions[0]!.error_summary, "Dead API is temporarily unavailable (503).");
  assert.deepEqual(engine.decisionStats(), { ...emptyStats, abandoned_decisions: 1 });
  engine.abandonDecision();
  assert.equal(await pending, "");
});

test("an empty timed response fails the run and leaves the choice to the timer", async () => {
  const engine = new LLMEngine("p1", "prime:test-model", {
    provider: new ScriptedProvider([""]),
    decisionLog: [],
  });
  const timed = request();
  timed.timer = { turnSeconds: 55, seconds: 420 };
  await assert.rejects(
    acceptedAct(engine, timed, { povLines: [] }),
    /returned no usable response.*cannot continue/,
  );
});

test("empty reflections record a fallback review", async () => {
  const decisions: JsonObject[] = [];
  const engine = new LLMEngine("p1", "prime:test-model", {
    provider: new ScriptedProvider(["", ""]),
    decisionLog: decisions,
  });
  await engine.endGame({
    gameNumber: 1,
    seriesOver: false,
    outcome: { winner: "opponent", won: false, turns: 8 },
    seriesScore: { p1: 0, p2: 1 },
  });
  assert.equal(decisions[0]!.kind, "game_reflection");
  assert.equal(decisions[0]!.fallback, true);
  assert.match(text(decisions[0]!.summary), /model reflection unavailable/);
});

test("a draft roster switches only the series-final reflection to the prep-review variant", async () => {
  const reflection = JSON.stringify({ summary: "s", adjustment: "a", notebook: "n" });
  const roster = "registered for this series: Ampharos, Beartic; left behind: Corviknight.";
  const finalGame = {
    gameNumber: 3,
    seriesOver: true,
    outcome: { winner: "opponent", won: false, turns: 9 },
    seriesScore: { p1: 1, p2: 2 },
  };

  const draftFinal = new ScriptedProvider([reflection]);
  await new LLMEngine("p1", "scripted", {
    provider: draftFinal,
    decisionLog: [],
    draftRoster: roster,
  }).endGame(finalGame);
  assert.equal(draftFinal.calls[0]!.system, DRAFT_SERIES_REFLECTION_SYSTEM);
  assert.match(draftFinal.calls[0]!.system, /six you registered/);
  assert.match(draftFinal.calls[0]!.system, /full roster/);
  assert.match(draftFinal.calls[0]!.messages[0]!.content ?? "", /left behind: Corviknight/);

  const draftMidSeries = new ScriptedProvider([reflection]);
  await new LLMEngine("p1", "scripted", {
    provider: draftMidSeries,
    decisionLog: [],
    draftRoster: roster,
  }).endGame({
    gameNumber: 1,
    seriesOver: false,
    outcome: { winner: "opponent", won: false, turns: 9 },
    seriesScore: { p1: 0, p2: 1 },
  });
  assert.equal(draftMidSeries.calls[0]!.system, REFLECTION_SYSTEM);
  assert.doesNotMatch(draftMidSeries.calls[0]!.messages[0]!.content ?? "", /left behind/);

  const constructedFinal = new ScriptedProvider([reflection]);
  await new LLMEngine("p1", "scripted", { provider: constructedFinal, decisionLog: [] }).endGame(
    finalGame,
  );
  assert.equal(constructedFinal.calls[0]!.system, CLOSED_SERIES_REFLECTION_SYSTEM);
  assert.doesNotMatch(constructedFinal.calls[0]!.system, /six you registered|full roster/);
});
