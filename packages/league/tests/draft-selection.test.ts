import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { legalPicks, parseFranchiseName, parsePick, runDraft } from "../src/draft.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { ApiError } from "../src/providers.js";
import { seededRng } from "../src/random.js";
import { runTeambuild } from "../src/teambuild.js";
import type { Completion, JsonObject, Provider } from "../src/types.js";
import { asRecords } from "../src/value.js";
import {
  assertFormatAuthority,
  BOARD,
  freshState,
  GOOD_TEAM,
  mon,
  scriptedProvider,
  teambuildRequest,
} from "./draft-test-helpers.js";

test("a transient provider failure retries instead of ending the draft", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-logs-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let calls = 0;
  const flaky: Provider = {
    complete(): Promise<Completion> {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("OpenRouter API request failed (400)."));
      const picks = [
        '{"pick": "garchomp", "reasoning": "Anchor.", "notebook": "n"}',
        '{"pick": "incineroar", "reasoning": "Support.", "notebook": "n"}',
        '{"pick": "sinistcha", "reasoning": "Redirection.", "notebook": "n"}',
        '{"pick": "farigiraf", "reasoning": "Insurance.", "notebook": "n"}',
        '{"team_name":"Retry Rollouts"}',
      ];
      return Promise.resolve({
        text: picks[Math.min(calls - 2, picks.length - 1)]!,
        usage: {},
        toolCalls: [],
      });
    },
  };
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    { logDir, rng: seededRng(1), makeDraftProvider: () => flaky },
  );
  assert.equal(outcome.rosters[0]![0]!.id, "garchomp");
  assert.equal(outcome.picks[0]!.fallback, false);
  const rows = readJsonlObjects(path.join(logDir, "drafter-0-fake-model.jsonl"));
  assert.match(String(rows[0]!.error), /API request failed \(400\)/);
  assert.equal(rows[1]!.error, undefined, "the retry succeeds and the draft moves on");
});

test("drafters name their franchise only after every pick is complete", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-logs-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let receivedReasoning = "";
  const prompts: string[] = [];
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(1),
      rosterPolicy: "- A test transaction window opens after week 2.",
      reasoningByModel: { "fake:model": "high" },
      makeDraftProvider: (_spec, _apiKey, reasoning) => {
        receivedReasoning = reasoning ?? "";
        return scriptedProvider(
          [
            'I will take {"pick": "not-a-mon", "team_name": "Nowhere Nidokings", "reasoning": "bad id", "notebook": "bad"}',
            '{"pick": "garchomp", "reasoning": "Best ground type available.", "notebook": "Build around Garchomp; add Fake Out and speed control."}',
            '{"pick": "incineroar", "reasoning": "Fake Out support.", "notebook": "Garchomp plus Incineroar; add speed control and redirection."}',
            '{"pick": "sinistcha", "reasoning": "Redirection.", "notebook": "Ground offense with pivoting and redirection; add speed control."}',
            '{"pick": "farigiraf", "reasoning": "Trick Room insurance.", "notebook": "Complete flexible Ground offense with priority denial and Trick Room."}',
            '{"team_name":"Route 210 Garchomps"}',
          ],
          (messages) => prompts.push(String(messages.at(-1)?.content ?? "")),
        );
      },
    },
  );

  assert.equal(receivedReasoning, "high");
  assert.equal(outcome.teamNames[0], "Route 210 Garchomps");
  assert.equal(outcome.rosters[0]![0]!.id, "garchomp");
  assert.equal(outcome.picks[0]!.fallback, false);
  assert.match(outcome.picks[0]!.rationale, /Best ground type/);
  assert.ok(
    prompts.some((prompt) =>
      prompt.includes("Build around Garchomp; add Fake Out and speed control."),
    ),
    "the accepted private draft note reaches the next pick",
  );

  const rows = fs
    .readFileSync(path.join(logDir, "drafter-0-fake-model.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  assert.match(String(rows[0]!.error), /is not a board id/);
  assert.ok(
    String(rows[0]!.system).includes("DRAFT BOARD"),
    "the board rides in the cacheable system prompt",
  );
  assertFormatAuthority(String(rows[0]!.system));
  assert.match(String(rows[0]!.system), /test transaction window opens after week 2/);
  assert.doesNotMatch(String(rows[0]!.system), /franchise name|Shadow Cabinet|Drought Dodgers/i);

  const transcript = fs
    .readFileSync(path.join(logDir, "draft.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  assert.equal(transcript[0]!.team_name, undefined);
  assert.equal(transcript[0]!.rationale, "Best ground type available.");
  const names = readJsonlObjects(path.join(logDir, "franchise-names.jsonl"));
  assert.equal(names.find((row) => row.entrant === 0)?.team_name, "Route 210 Garchomps");
  const namingLog = readJsonlObjects(path.join(logDir, "namer-0-fake-model.jsonl"));
  assert.match(String(namingLog[0]!.system), /The Shadow Cabinet/);
  assertFormatAuthority(String(namingLog[0]!.system));
  assert.match(String(namingLog[0]!.user), /Garchomp/);
  assert.match(String(namingLog[0]!.user), /Farigiraf/);

  let replayCalls = 0;
  const replayed = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(1),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          replayCalls += 1;
          throw new Error("completed picks and names must replay");
        },
      }),
    },
  );
  assert.equal(replayCalls, 0);
  assert.deepEqual(
    replayed,
    outcome,
    "transcript replay reconstructs the live draft outcome exactly",
  );
});

test("a rejected pick is told which rule it broke", () => {
  const state = freshState();
  const zardY = mon("charizard-mega-y");
  state.teamNames[1] = "Rival Rotoms";
  state.taken.set(zardY.id, 1);
  state.rosters[1] = [zardY];
  const garchomp = mon("garchomp");
  state.taken.set(garchomp.id, 0);
  state.rosters[0] = [garchomp];
  state.budgets[0] = BOARD.budget - garchomp.cost;

  const reasons = ["nonsense-id", "charizard-mega-y", "garchomp-mega", "basculegion"].map((id) => {
    const legal = legalPicks(state, 0);
    const parsed = parsePick(
      JSON.stringify({ pick: id, reasoning: "x", notebook: "plan" }),
      legal,
      state,
      0,
      ["fake:model", "fake:rival"],
    );
    return typeof parsed === "string" ? parsed : "accepted";
  });

  assert.match(reasons[0]!, /is not a board id/);
  assert.match(reasons[1]!, /already drafted by fake:rival/);
  assert.doesNotMatch(reasons[1]!, /Rival Rotoms/);
  assert.match(reasons[2]!, /shares the species Garchomp with your Garchomp/);
  assert.equal(reasons[3], "accepted", "an affordable, untaken, unclashing pick is fine");

  state.budgets[0] = 12;
  const tight = legalPicks(state, 0);
  const denied = parsePick(
    JSON.stringify({ pick: "basculegion", reasoning: "x", notebook: "plan" }),
    tight,
    state,
    0,
  );
  assert.match(String(denied), /costs 19, but you can spend at most \d+ points?/);
});

test("picks do not request a franchise name and franchise names normalize separately", () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  assert.notEqual(
    typeof parsePick('{"pick":"garchomp","notebook":"Build around Garchomp"}', legal, state, 0),
    "string",
  );
  assert.deepEqual(parseFranchiseName(JSON.stringify({ team_name: "  Prankster\n  Paradise  " })), {
    teamName: "Prankster Paradise",
  });
  assert.match(String(parseFranchiseName('{"team_name":""}')), /non-empty/);
});

test("a legal pick is not rejected when optional evidence is omitted", () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  const id = legal[0]?.id;
  assert.ok(id);
  const parsed = parsePick(JSON.stringify({ pick: id }), legal, state, 0);
  assert.notEqual(typeof parsed, "string");
  if (typeof parsed !== "string") {
    assert.equal(parsed.mon.id, id);
    assert.equal(parsed.reasoning, "");
    assert.equal(parsed.notebook, undefined);
    assert.deepEqual(parsed.evidence.supplied, { rationale: false, notebookUpdate: false });
  }
});

test("a pick may be written as the board id or the name shown beside it", () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  for (const spelling of ["lucario-mega", "Mega Lucario", "mega-lucario", "MEGA LUCARIO"]) {
    const parsed = parsePick(
      JSON.stringify({ pick: spelling, reasoning: "x", notebook: "plan" }),
      legal,
      state,
      0,
    );
    assert.notEqual(typeof parsed, "string", `${spelling} should resolve`);
    assert.equal(typeof parsed === "string" ? "" : parsed.mon.id, "lucario-mega");
  }
});

test("drafters can look up the dex before committing a pick", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-tools-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let offered: string[] = [];
  let toolResult = "";
  let call = 0;
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(7),
      makeDraftProvider: () => ({
        complete(_system, messages, options): Promise<Completion> {
          call += 1;
          if (options?.tools?.length) offered = options.tools.map((tool) => tool.name);
          if (call === 1) {
            return Promise.resolve({
              text: "",
              usage: { total_tokens: 5 },
              toolCalls: [
                {
                  id: "c1",
                  name: "lookup_species",
                  arguments: { name: "Blastoise", item: "Blastoisinite" },
                },
              ],
            });
          }
          if (call === 2) toolResult = String(messages[messages.length - 1]?.content ?? "");
          const picks = ["garchomp", "incineroar", "sinistcha", "farigiraf"];
          return Promise.resolve({
            text: `{"pick": "${picks[Math.min(call - 2, picks.length - 1)]}", "team_name": "Calc Chompers", "reasoning": "Checked the Mega first.", "notebook": "Keep checking exact mechanics."}`,
            usage: { total_tokens: 9 },
            toolCalls: [],
          });
        },
      }),
    },
  );

  assert.ok(offered.includes("lookup_species"), "the dex tools are offered while drafting");
  assert.ok(
    offered.includes("estimate_damage"),
    "including the damage calculator, for counter-picking",
  );
  assert.match(
    toolResult,
    /Blastoise-Mega/,
    "the lookup is resolved against the simulator and fed back",
  );
  assert.equal(outcome.picks[0]!.fallback, false);
  assert.equal(outcome.rosters[0]![0]!.id, "garchomp");

  const rows = fs
    .readFileSync(path.join(logDir, "drafter-0-fake-model.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  const lookups = asRecords(rows[0]!.tool_lookups);
  assert.equal(lookups.length, 1, "lookups are logged for the audit trail");
  assert.equal(lookups[0]!.name, "lookup_species");
  assert.match(
    String(lookups[0]!.result),
    /Blastoise-Mega/,
    "the result content is preserved for audits",
  );
});

test("teambuilders can look up the dex while writing sets", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-tools-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let offered: string[] = [];
  let toolResult = "";
  let call = 0;
  const { view } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(7),
    makeTeambuildProvider: () => ({
      complete(_system, messages, options): Promise<Completion> {
        call += 1;
        offered = (options?.tools ?? []).map((tool) => tool.name);
        if (call === 1) {
          return Promise.resolve({
            text: "",
            usage: { total_tokens: 5 },
            toolCalls: [
              {
                id: "c1",
                name: "estimate_damage",
                arguments: { attacker: "Garchomp", defender: "Incineroar", move: "Earthquake" },
              },
            ],
          });
        }
        toolResult = String(messages[messages.length - 1]?.content ?? "");
        return Promise.resolve({ text: GOOD_TEAM, usage: { total_tokens: 9 }, toolCalls: [] });
      },
    }),
  });

  assert.ok(
    offered.includes("estimate_damage"),
    "the calculator is offered while building spreads",
  );
  assert.match(toolResult, /Earthquake/, "the calc is resolved and fed back");
  assert.equal(view.attempts, 1, "a tool round is not a failed attempt");
});

test("a pick cut off by its token budget is told so, not blamed for formatting", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-truncated-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const long = "y".repeat(4_000);
  let secondPrompt = "";
  let call = 0;
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(8),
      makeDraftProvider: () => ({
        complete(_system, messages, options): Promise<Completion> {
          call += 1;
          if (call === 1) {
            return Promise.resolve({
              text: `Weighing the board ${long}`,
              usage: { output_tokens: options?.maxTokens ?? 0 },
              toolCalls: [],
            });
          }
          if (call === 2)
            secondPrompt = messages.map((message) => String(message.content ?? "")).join("\n");
          const picks = ["garchomp", "incineroar", "sinistcha", "farigiraf"];
          return Promise.resolve({
            text: `{"pick": "${picks[Math.min(call - 2, picks.length - 1)]}", "team_name": "Budget Chompers", "reasoning": "Kept it short.", "notebook": "Build balanced offense."}`,
            usage: { output_tokens: 40 },
            toolCalls: [],
          });
        },
      }),
    },
  );

  assert.ok(
    !secondPrompt.includes(long),
    "the overrun reasoning must not be replayed into the retry",
  );
  assert.match(secondPrompt, /used the whole \d+-token budget before naming a pick/);
  assert.equal(outcome.picks[0]!.fallback, false, "the model still gets to make its own pick");

  const rows = fs
    .readFileSync(path.join(logDir, "drafter-0-fake-model.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  assert.match(String(rows[0]!.error), /whole 65536-token budget before naming a pick/);
});

test("a teambuild cut off by its token budget is told so", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-truncated-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const long = "z".repeat(4_000);
  let secondPrompt = "";
  let call = 0;
  const { view } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(8),
    makeTeambuildProvider: () => ({
      complete(_system, messages, options): Promise<Completion> {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            text: `Considering the matchup ${long}`,
            usage: { output_tokens: options?.maxTokens ?? 0 },
            toolCalls: [],
          });
        }
        secondPrompt = messages.map((message) => String(message.content ?? "")).join("\n");
        return Promise.resolve({ text: GOOD_TEAM, usage: { output_tokens: 60 }, toolCalls: [] });
      },
    }),
  });

  assert.ok(
    !secondPrompt.includes(long),
    "the overrun reasoning must not be replayed into the retry",
  );
  assert.match(secondPrompt, /used the whole 65536-token budget before finishing the team/);
  assert.equal(view.attempts, 2);
  assert.ok(
    view.sets.every((set) => !set.repaired),
    "the model still writes its own team once it fits inside the budget",
  );
});

test("a drafter that never answers falls back to a random legal pick", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-fallback-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(3),
      makeDraftProvider: () => scriptedProvider(["no json here"]),
    },
  );
  assert.equal(outcome.picks[0]!.fallback, true);
  assert.match(outcome.picks[0]!.rationale, /random legal pick after 3 rejected replies/);
  assert.match(outcome.notebooks[0]!, /Harness note: every reply for pick 1 was rejected/);
  const seatLog = fs
    .readFileSync(path.join(logDir, "drafter-0-fake-model.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line): { pick: number; attempt: number; user: string } => JSON.parse(line));
  const laterFirstAttempt = seatLog.find((row) => row.pick > 1 && row.attempt === 1);
  assert.match(
    laterFirstAttempt!.user,
    /Harness note: every reply for pick 1 was rejected/,
    "the fallback note reaches the next pick through the notebook",
  );
});

test("a credential failure stops the draft instead of making random picks", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-terminal-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  await assert.rejects(
    runDraft(
      ["openrouter:google/gemini-test", "random"],
      { ...BOARD, picks: 4 },
      {
        logDir,
        rng: seededRng(2),
        makeDraftProvider: () => ({
          complete: () => Promise.reject(new ApiError(401, "invalid api key")),
        }),
      },
    ),
    /credentials/i,
  );
});

test("a pick written only in the reasoning channel is salvaged without another attempt", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-salvage-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(4),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          return Promise.resolve({
            text: "",
            reasoning:
              'Garchomp anchors the roster. Committing: {"pick": "garchomp", "team_name": "Salvage Sneaslers", "reasoning": "Best value.", "notebook": "Build around Garchomp."}',
            usage: { total_tokens: 400 },
            toolCalls: [],
          });
        },
      }),
    },
  );
  assert.equal(outcome.rosters[0]![0]!.id, "garchomp");
  assert.equal(outcome.picks[0]!.fallback, false, "the pick inside the reasoning is used directly");
  const firstPickAttempts = readJsonlObjects(
    path.join(logDir, "drafter-0-fake-model.jsonl"),
  ).filter((row) => row.pick === 1);
  assert.equal(firstPickAttempts.length, 1, "the first pick salvages in one call");
});

test("a resumed draft replays its transcript and continues from the next pick", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-replay-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const garchomp = mon("garchomp");
  const incineroar = mon("incineroar");
  const whimsicott = mon("whimsicott");
  const stored = [
    {
      pick: 1,
      model: "fake:model",
      team_name: "Replayed Rotoms",
      mon: garchomp.id,
      name: garchomp.name,
      cost: garchomp.cost,
      budget_left: BOARD.budget - garchomp.cost,
      rationale: "Original pick before the crash.",
      notebook: "Carry this plan across the resume.",
      fallback: false,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      pick: 2,
      model: "random",
      team_name: "Random Coach 2",
      mon: incineroar.id,
      name: incineroar.name,
      cost: incineroar.cost,
      budget_left: BOARD.budget - incineroar.cost,
      rationale: "random baseline pick",
      fallback: false,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      pick: 3,
      model: "random",
      team_name: "Random Coach 2",
      mon: whimsicott.id,
      name: whimsicott.name,
      cost: whimsicott.cost,
      budget_left: BOARD.budget - incineroar.cost - whimsicott.cost,
      rationale: "random baseline pick",
      fallback: false,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ];
  fs.writeFileSync(
    path.join(logDir, "draft.jsonl"),
    `${stored.map((row) => JSON.stringify(row)).join("\n")}\n{"pick":`,
    "utf8",
  );
  let calls = 0;
  const prompts: string[] = [];
  const outcome = await runDraft(
    ["fake:model", "random"],
    { ...BOARD, picks: 3 },
    {
      logDir,
      rng: seededRng(9),
      makeDraftProvider: () => ({
        complete(_system, messages): Promise<Completion> {
          calls += 1;
          prompts.push(String(messages.at(-1)?.content ?? ""));
          const text =
            calls === 1
              ? '{"pick": "sinistcha", "reasoning": "Resume pick.", "notebook": "Updated plan."}'
              : '{"pick": "farigiraf", "reasoning": "Final pick.", "notebook": "Done."}';
          return Promise.resolve({ text, usage: { total_tokens: 10 }, toolCalls: [] });
        },
      }),
    },
  );

  assert.equal(calls, 2, "replayed picks consume no provider calls");
  assert.equal(outcome.teamNames[0], "Replayed Rotoms");
  assert.deepEqual(
    outcome.rosters[0]!.map((entry) => entry.id),
    [garchomp.id, "sinistcha", "farigiraf"],
  );
  assert.deepEqual(
    outcome.rosters[1]!.map((entry) => entry.id),
    [incineroar.id, whimsicott.id, outcome.rosters[1]![2]!.id],
  );
  assert.equal(outcome.picks[0]!.rationale, "Original pick before the crash.");
  assert.equal(outcome.picks.length, 6);
  assert.ok(
    prompts[0]!.includes("Carry this plan across the resume."),
    "the replayed notebook reaches the first live pick",
  );
  const transcript = fs
    .readFileSync(path.join(logDir, "draft.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim());
  assert.equal(transcript.length, 6, "replayed picks are not rewritten to the transcript");
});

test("an explicit empty draft notebook survives transcript replay", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-empty-notebook-"));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const replies = new Map<string, string[]>(
    Object.entries({
      "fake:a": [
        '{"pick":"garchomp","reasoning":"Start here.","notebook":"Keep this until the final pick."}',
        '{"pick":"incineroar","reasoning":"Roster complete.","notebook":""}',
        '{"team_name":"Empty Notes"}',
      ],
      "fake:b": [
        '{"pick":"sinistcha","reasoning":"Support.","notebook":"Tea mode."}',
        '{"pick":"farigiraf","reasoning":"Speed control.","notebook":"Room mode."}',
        '{"team_name":"Room Notes"}',
      ],
    }),
  );
  const calls = new Map<string, number>();
  const first = await runDraft(
    ["fake:a", "fake:b"],
    { ...BOARD, picks: 2 },
    {
      logDir,
      rng: seededRng(12),
      makeDraftProvider: (spec) => ({
        complete(): Promise<Completion> {
          const call = calls.get(spec) ?? 0;
          calls.set(spec, call + 1);
          return Promise.resolve({ text: replies.get(spec)![call]!, usage: {}, toolCalls: [] });
        },
      }),
    },
  );
  assert.equal(first.notebooks[0], "");
  const transcript = readJsonlObjects(path.join(logDir, "draft.jsonl"));
  const cleared = transcript.find((row) => row.model === "fake:a" && row.mon === "incineroar")!;
  assert.equal(cleared.notebook, "");
  assert.deepEqual(cleared.evidence_supplied, { rationale: true, notebook_update: true });

  let replayCalls = 0;
  const replayed = await runDraft(
    ["fake:a", "fake:b"],
    { ...BOARD, picks: 2 },
    {
      logDir,
      rng: seededRng(12),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          replayCalls += 1;
          throw new Error("completed draft must replay without provider calls");
        },
      }),
    },
  );
  assert.equal(replayCalls, 0);
  assert.equal(
    replayed.notebooks[0],
    "",
    "replay must not resurrect the earlier non-empty notebook",
  );
});
