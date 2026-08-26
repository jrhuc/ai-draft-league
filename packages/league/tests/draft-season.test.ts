import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DraftLeagueEvent } from "../src/draftleague-protocol.js";
import { runDraftLeague } from "../src/draftleague.js";
import { roundRobinWeeks } from "../src/draftleague-topology.js";
import { emptyMemory } from "../src/franchise-memory.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { draftLeagueConfigSchema } from "../src/league-store.js";
import { defaultPsDir } from "../src/paths.js";
import { loadSeriesRecords } from "../src/records.js";
import { canonicalJson } from "../src/serialization.js";
import { decodeTeamBuildJournalRow } from "../src/teambuild.js";
import { parseTradeDecision, runTradeWindow, type TradeWindowState } from "../src/trade-window.js";
import type { JsonObject } from "../src/types.js";
import { asRecord, asStrings } from "../src/value.js";
import { runWeeklyReview } from "../src/weekly-review.js";
import { BOARD } from "./draft-test-helpers.js";

test("a full draft league drafts, plays weekly rounds, and crowns a champion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const events: DraftLeagueEvent[] = [];
  const rows = await runDraftLeague(["random", "random", "random", "random"], directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    onEvent: (event) => events.push(event),
  });

  assert.equal(rows.length, 6 + 1, "a four-coach round robin is six series, plus a top-two final");
  assert.deepEqual(
    fs
      .readdirSync(path.join(directory, "reviews"))
      .filter((file) => file.endsWith(".jsonl"))
      .sort(),
    ["week-1.jsonl", "week-2.jsonl", "week-3.jsonl"],
    "a parallel league reviews at each window and the end of the round robin",
  );
  for (const row of rows) {
    assert.equal(row.mode, "draft");
    assert.equal(row.board, "regmb-202607");
    assert.deepEqual(row.transactions, [
      { after_week: 1, trades_allowed: 2 },
      { after_week: 2, trades_allowed: 2 },
      { after_week: 3, trades_allowed: 2 },
    ]);
    assert.equal(
      row.roster_version,
      row.stage === "playoff" ? 3 : Number(row.round) - 1,
      "each series binds the roster version it was built on",
    );
  }

  const config = draftLeagueConfigSchema.parse(
    JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")),
  );
  assert.equal(config.mode, "draft");
  assert.equal(config.weeks, 3);
  assert.equal(config.sequential_weeks, false, "round-robin series run concurrently by default");
  assert.equal(
    config.closed_sheets,
    false,
    "the stock format keeps its open team sheets by default",
  );
  assert.deepEqual(
    config.transactions,
    [
      { after_week: 1, trades_allowed: 2 },
      { after_week: 2, trades_allowed: 2 },
      { after_week: 3, trades_allowed: 2 },
    ],
    "a window after each of the first three weeks is the default",
  );
  assert.deepEqual(config.draft_notes, ["", "", "", ""]);
  const rosters = config.rosters!;
  assert.equal(rosters.length, 4);
  for (const roster of rosters) assert.equal(roster.length, 10);
  assert.equal(new Set(rosters.flat()).size, 40, "no entry is drafted twice");

  const stored: Array<JsonObject> = JSON.parse(
    fs.readFileSync(path.join(directory, "rosters.json"), "utf8"),
  );
  assert.deepEqual(
    stored.map((entry) => entry.entrant),
    [0, 1, 2, 3],
  );
  for (const entry of stored) assert.ok(Number(entry.spent) <= 100, "no coach overspends");
  const window: {
    after_week: number;
    order: number[];
    offers: Array<{
      to: number | null;
      proposerFallback: boolean;
      responderFallback: boolean | null;
    }>;
    decisions: Array<{ swaps: unknown[] }>;
    rosters: Array<{ entrant: number }>;
  } = JSON.parse(
    fs.readFileSync(path.join(directory, "transactions", "after-week-3", "window.json"), "utf8"),
  );
  assert.equal(window.after_week, 3);
  assert.equal(window.decisions.length, 4);
  assert.equal(window.offers.length, 4);
  assert.ok(
    window.offers.every(
      (offer) =>
        offer.to === null && offer.proposerFallback === false && offer.responderFallback === null,
    ),
  );
  assert.ok(window.decisions.every((decision) => decision.swaps.length === 0));
  assert.deepEqual(
    window.rosters.map((roster) => roster.entrant),
    [0, 1, 2, 3],
  );
  assert.equal(window.order.length, 4);

  const teambuilds = fs
    .readFileSync(path.join(directory, "teambuild", "teambuild.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  assert.equal(teambuilds.length, rows.length * 2, "both coaches build before every series");
  for (const build of teambuilds) {
    const artifact = asRecord(build.artifact);
    const action = asRecord(artifact.action);
    assert.equal(artifact.status, "valid");
    assert.equal(asStrings(action.selected).length, 6);
    assert.deepEqual(Object.keys(build), ["artifact"]);
  }
  const coaching = fs
    .readFileSync(path.join(directory, "coaching.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  assert.equal(
    coaching.length,
    rows.length * 2,
    "each coach receives resumable private playoff context",
  );
  assert.ok(coaching.every((entry) => String(entry.context).includes("Registered sets:")));

  const draftEvents = events.filter(
    (event): event is Extract<DraftLeagueEvent, { type: "draft" }> => event.type === "draft",
  );
  assert.ok(
    draftEvents.some((event) => event.draft.phase === "window"),
    "the live UI exposes the barrier",
  );
  const finalDraft = draftEvents[draftEvents.length - 1]!.draft;
  assert.equal(finalDraft.phase, "done");
  assert.equal(finalDraft.weeks, 3);
  assert.ok(finalDraft.teambuilds.length > 0);
  assert.equal(loadSeriesRecords(recordsPath).length, rows.length);
  const replayEvents: DraftLeagueEvent[] = [];
  const resumed = await runDraftLeague(["random", "random", "random", "random"], directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    resume: true,
    onEvent: (event) => replayEvents.push(event),
  });
  assert.deepEqual(
    resumed.map((row) => row.series_id),
    rows.map((row) => row.series_id),
    "a completed final is adopted only after both exact constructions and series identity replay",
  );
  const liveBracket = events
    .filter(
      (event): event is Extract<DraftLeagueEvent, { type: "bracket" }> => event.type === "bracket",
    )
    .at(-1)!.bracket;
  const replayBracket = replayEvents.find(
    (event): event is Extract<DraftLeagueEvent, { type: "bracket" }> => event.type === "bracket",
  )!.bracket;
  assert.deepEqual(
    replayBracket,
    liveBracket,
    "live playoffs and stored adoption produce the same bracket",
  );
});

test("a four-seed draft playoff advances and replays the same exact bracket", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-playoff-bracket-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = Array.from({ length: 5 }, () => "random");
  const liveEvents: DraftLeagueEvent[] = [];
  const rows = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 17,
    concurrency: 4,
    transactions: null,
    onEvent: (event) => liveEvents.push(event),
  });
  assert.equal(rows.filter((row) => row.stage === "playoff").length, 3);
  const liveBracket = liveEvents
    .filter(
      (event): event is Extract<DraftLeagueEvent, { type: "bracket" }> => event.type === "bracket",
    )
    .at(-1)!.bracket;
  assert.deepEqual(
    liveBracket.rounds[1]![0]!.slots,
    liveBracket.rounds[0]!.map((match) => match.winner),
    "each semifinal advances only into its corresponding final slot",
  );

  const replayEvents: DraftLeagueEvent[] = [];
  await runDraftLeague(models, directory, {
    recordsPath,
    seed: 17,
    concurrency: 4,
    transactions: null,
    resume: true,
    onEvent: (event) => replayEvents.push(event),
  });
  const replayBracket = replayEvents.find(
    (event): event is Extract<DraftLeagueEvent, { type: "bracket" }> => event.type === "bracket",
  )!.bracket;
  assert.deepEqual(replayBracket, liveBracket);
});

test("a draft league checkpoints after a week and resumes to a champion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-resume-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = ["random", "random", "random", "random"];
  const first = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    throughWeek: 1,
  });
  assert.equal(first.length, 2, "week one is two series");
  assert.ok(first.every((row) => row.stage === "roundrobin" && row.round === 1));
  assert.ok(
    fs.existsSync(path.join(directory, "transactions", "after-week-1", "window.json")),
    "stopping after week 1 closes its transaction window",
  );
  assert.ok(
    !fs.existsSync(path.join(directory, "transactions", "after-week-2")),
    "later windows stay closed",
  );

  const resumed = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    resume: true,
  });
  assert.equal(resumed.length, 6 + 1, "the resumed league finishes the round robin and the final");
  assert.equal(new Set(resumed.map((row) => row.series_index)).size, 7, "no series repeats");
  assert.equal(loadSeriesRecords(recordsPath).length, 7, "each series is recorded exactly once");
  const final = resumed[resumed.length - 1]!;
  assert.equal(final.stage, "playoff");
  assert.ok(final.advanced, "the resumed league crowns a champion");
  for (const week of [1, 2, 3]) {
    assert.ok(
      fs.existsSync(path.join(directory, "transactions", `after-week-${week}`, "window.json")),
      `resume completes the week-${week} window`,
    );
  }
});

test("the real league window updates the outer roster used by later construction", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-outer-roster-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = ["random", "random"];
  await runDraftLeague(models, directory, {
    recordsPath,
    seed: 41,
    concurrency: 1,
    throughWeek: 1,
    transactions: [{ afterWeek: 1, tradesAllowed: 0 }],
  });
  /** The through-week stop closed the real (all-pass) window; clear it so the manual replay below owns the epoch. */
  fs.rmSync(path.join(directory, "transactions"), { recursive: true, force: true });

  const config: {
    entrants: string[];
    team_names: string[];
    rosters: string[][];
    draft_notes: string[];
  } = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"));
  const rosters = config.rosters.map((ids) =>
    ids.map((id) => BOARD.mons.find((candidate) => candidate.id === id)!),
  );
  const result = loadSeriesRecords(recordsPath)[0]!;
  const [a, b] = roundRobinWeeks(2)[0]![0]!;
  const { score } = result;
  const table = [
    {
      entrant: a,
      w: result.winner_side === "p1" ? 1 : 0,
      l: result.winner_side === "p2" ? 1 : 0,
      gw: score.p1,
      gl: score.p2,
    },
    {
      entrant: b,
      w: result.winner_side === "p2" ? 1 : 0,
      l: result.winner_side === "p1" ? 1 : 0,
      gw: score.p2,
      gl: score.p1,
    },
  ].sort(
    (first, second) =>
      second.w - first.w ||
      second.gw - second.gl - (first.gw - first.gl) ||
      second.gw - first.gw ||
      first.entrant - second.entrant,
  );
  const first = table.at(-1)!.entrant;
  const state: TradeWindowState = {
    board: BOARD,
    models: config.entrants,
    teamNames: config.team_names,
    rosters,
    budgets: rosters.map(
      (roster) => BOARD.budget - roster.reduce((sum, candidate) => sum + candidate.cost, 0),
    ),
    memories: config.draft_notes.map((note) => emptyMemory(note)),
    standings: table,
    results: models.map(() => []),
    reflections: models.map(() => []),
    history: [],
    swapsAllowed: 6,
    swapsUsed: models.map(() => 0),
  };
  const owned = new Set(rosters.flatMap((roster) => roster.map((candidate) => candidate.id)));
  let replayed: { drop: string; add: string; reasoning: string } | undefined;
  for (const drop of rosters[first]!) {
    for (const add of BOARD.mons) {
      if (owned.has(add.id)) continue;
      const parsed = parseTradeDecision(
        JSON.stringify({
          swaps: [{ drop: drop.id, add: add.id }],
          reasoning: "replayed roster plan",
        }),
        state,
        first,
      );
      if (typeof parsed === "string") continue;
      replayed = {
        drop: parsed.swaps[0]!.drop,
        add: parsed.swaps[0]!.add,
        reasoning: parsed.reasoning,
      };
      break;
    }
    if (replayed) break;
  }
  assert.ok(replayed, "the board must offer one legal post-draft swap");
  await runWeeklyReview(
    {
      board: BOARD,
      models: config.entrants,
      stage: "week",
      week: 1,
      weeks: 1,
      rosterVersion: 0,
      rosters,
      memories: config.draft_notes.map((note) => emptyMemory(note)),
      standings: config.entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 })),
      series: [],
      period: [],
      schedule: [],
      transactions: [],
      nextWindowWeek: 1,
    },
    { runDir: directory, psDir: defaultPsDir() },
  );
  const epochDir = path.join(directory, "transactions", "after-week-1");
  fs.mkdirSync(epochDir, { recursive: true });
  fs.writeFileSync(
    path.join(epochDir, "window.jsonl"),
    `${canonicalJson({
      kind: "free_agency",
      entrant: first,
      model: config.entrants[first],
      swaps: [{ drop: replayed.drop, add: replayed.add }],
      reasoning: replayed.reasoning,
      fallback: false,
      timestamp: new Date(0).toISOString(),
    })}\n`,
  );
  const preWindowRosters = rosters.map((roster) => [...roster]);
  await runTradeWindow(state, {
    epochDir,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 0,
  });
  await runWeeklyReview(
    {
      board: BOARD,
      models: config.entrants,
      stage: "transactions",
      week: 1,
      weeks: 1,
      rosterVersion: 1,
      rosters,
      previousRosters: preWindowRosters,
      seats: [first],
      memories: [...state.memories],
      standings: config.entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 })),
      series: [],
      period: [],
      schedule: [],
      transactions: [],
      nextWindowWeek: null,
    },
    { runDir: directory, psDir: defaultPsDir() },
  );

  const teambuildLog = path.join(directory, "teambuild", "teambuild.jsonl");
  const donor = readJsonlObjects(teambuildLog)
    .map((row) => decodeTeamBuildJournalRow(row))
    .find(
      ({ artifact }) =>
        artifact.task.provenance.seriesIndex === 0 && artifact.task.provenance.entrant === first,
    )!;
  donor.artifact.task.provenance.seriesIndex = 1;
  donor.artifact.task.provenance.opponent = first === 0 ? 1 : 0;
  fs.appendFileSync(teambuildLog, `${JSON.stringify({ artifact: donor.artifact })}\n`);

  await runDraftLeague(models, directory, { recordsPath, seed: 41, concurrency: 1, resume: true });
  const postWindowBuilds = readJsonlObjects(teambuildLog)
    .map((row) => decodeTeamBuildJournalRow(row))
    .filter(
      ({ artifact }) =>
        artifact.task.provenance.seriesIndex === 1 && artifact.task.provenance.entrant === first,
    );
  assert.equal(
    postWindowBuilds.length,
    2,
    "a stored build bound to the dropped candidate is rebuilt",
  );
  const candidates = postWindowBuilds
    .at(-1)!
    .artifact.task.constraint.candidates.map((candidate) => candidate.id);
  assert.ok(candidates.includes(replayed.add));
  assert.ok(!candidates.includes(replayed.drop));
});
