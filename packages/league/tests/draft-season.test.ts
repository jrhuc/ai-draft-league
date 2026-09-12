import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import type { DraftLeagueEvent } from "../src/draftleague-protocol.js";
import { runDraftLeague } from "../src/draftleague.js";
import { rankedTable } from "../src/draftleague-protocol.js";
import { roundRobinWeeks } from "../src/draftleague-topology.js";
import { readFranchiseCheckpoints, readFranchiseRosterVersion } from "../src/league-journal.js";
import { draftLeagueConfigSchema } from "../src/league-store.js";
import { defaultPsDir } from "../src/paths.js";
import { monitorRun, renderMonitorReport } from "../src/monitor.js";
import { loadSeriesRecords } from "../src/records.js";
import { commitRunArtifact, readRunArtifacts } from "../src/run-artifact-store.js";
import {
  parseTradeDecision,
  readTradeWindowArtifact,
  runTradeWindow,
  type TradeWindowState,
} from "../src/trade-window.js";
import { asRecord, asStrings } from "../src/value.js";
import { scriptedAgent } from "./agent-test-helpers.js";
import { BOARD } from "./draft-test-helpers.js";

test("a full draft league drafts, plays weekly rounds, and crowns a champion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const events: DraftLeagueEvent[] = [];
  const rows = await runDraftLeague(["random", "random", "random", "random"], directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    onEvent: (event) => events.push(event),
  });

  assert.equal(rows.length, 6 + 1, "a four-coach round robin is six series, plus a top-two final");
  const report = monitorRun(directory);
  assert.equal(report.completedSeries, rows.length);
  assert.equal(report.usage.length, 4 * BOARD.picks);
  assert.ok(report.usage.every((entry) => entry.weeks.length === 3));
  assert.equal(report.memory.length, readFranchiseCheckpoints(directory).length);
  assert.ok(report.decisions.every((seat) => seat.decisions > 0));
  assert.match(renderMonitorReport(report), /## Roster usage\n\n- entrant 0 \| random \| /);
  assert.deepEqual(
    [...new Set(readFranchiseCheckpoints(directory, "week").map((row) => row.week))],
    [1, 2, 3],
    "every round-robin week ends with a review",
  );
  for (const row of rows) {
    assert.equal(row.mode, "draft");
    assert.equal(row.board, "regmc-202609");
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
  assert.equal(Object.hasOwn(config, "draft_notes"), false);
  assert.equal(Object.hasOwn(config, "rosters"), false);
  const stored = readFranchiseRosterVersion(directory, 0);
  const rosters = stored.map((roster) => roster.roster.map((mon) => mon.id));
  assert.equal(rosters.length, 4);
  for (const roster of rosters) assert.equal(roster.length, 10);
  assert.equal(new Set(rosters.flat()).size, 40, "no entry is drafted twice");
  assert.deepEqual(
    stored.map((entry) => entry.entrant),
    [0, 1, 2, 3],
  );
  for (const entry of stored) {
    assert.ok(
      entry.roster.reduce((total, mon) => total + mon.cost, 0) <= 100,
      "no coach overspends",
    );
  }
  const window = readTradeWindowArtifact(directory, 3)!;
  assert.equal(window.after_week, 3);
  assert.equal(window.decisions.length, 4);
  assert.equal(window.offers.length, 4);
  assert.ok(window.offers.every((offer) => offer.to === null));
  assert.ok(window.decisions.every((decision) => decision.swaps.length === 0));
  assert.deepEqual(
    window.rosters.map((roster) => roster.entrant),
    [0, 1, 2, 3],
  );
  assert.equal(window.order.length, 4);

  const teambuilds = readRunArtifacts(directory, "teambuild").map(({ value }) => asRecord(value));
  assert.equal(teambuilds.length, rows.length * 2, "both coaches build before every series");
  for (const build of teambuilds) {
    const action = asRecord(asRecord(build.artifact).action);
    assert.equal(asStrings(action.selected).length, 6);
    assert.deepEqual(Object.keys(build), ["artifact"]);
  }

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
  const replayBracket = replayEvents
    .filter(
      (event): event is Extract<DraftLeagueEvent, { type: "bracket" }> => event.type === "bracket",
    )
    .at(-1)!.bracket;
  assert.deepEqual(
    replayBracket,
    liveBracket,
    "live playoffs and stored adoption produce the same bracket",
  );
});

test("a four-seed draft playoff advances and replays the same exact bracket", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-playoff-bracket-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
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
  const replayBracket = replayEvents
    .filter(
      (event): event is Extract<DraftLeagueEvent, { type: "bracket" }> => event.type === "bracket",
    )
    .at(-1)!.bracket;
  assert.deepEqual(replayBracket, liveBracket);
});

test("a draft league checkpoints after a week and resumes to a champion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-resume-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
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
  assert.ok(readTradeWindowArtifact(directory, 1), "stopping after week 1 closes its window");
  assert.equal(readTradeWindowArtifact(directory, 2), undefined, "later windows stay closed");

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
    assert.ok(readTradeWindowArtifact(directory, week), `resume completes the week-${week} window`);
  }
});

test("a resumed league keeps roster version 0 and plays on from a changed roster", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-outer-roster-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = ["random", "random"];
  await runDraftLeague(models, directory, {
    recordsPath,
    seed: 41,
    concurrency: 1,
    throughWeek: 1,
    transactions: [{ afterWeek: 1, tradesAllowed: 0 }],
  });
  const drafted = readFranchiseRosterVersion(directory, 0);
  const rosters = drafted.map(({ roster }) =>
    roster.map((mon) => BOARD.mons.find((candidate) => candidate.id === mon.id)!),
  );
  const config: { entrants: string[] } = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  const result = loadSeriesRecords(recordsPath)[0]!;
  const [a, b] = roundRobinWeeks(2)[0]![0]!;
  const table = rankedTable(
    [
      {
        entrant: a,
        w: result.winner_side === "p1" ? 1 : 0,
        l: result.winner_side === "p2" ? 1 : 0,
      },
      {
        entrant: b,
        w: result.winner_side === "p2" ? 1 : 0,
        l: result.winner_side === "p1" ? 1 : 0,
      },
    ].map((row) => ({ ...row, gw: row.w * 2, gl: row.l * 2 })),
  );
  const first = table.at(-1)!.entrant;
  const state: TradeWindowState = {
    board: BOARD,
    models: config.entrants,
    teamNames: drafted.map((roster) => roster.teamName),
    rosters,
    budgets: drafted.map((roster) => roster.budget),
    memories: readFranchiseCheckpoints(directory, "week", 1).map((checkpoint) => checkpoint.memory),
    standings: table,
    results: models.map(() => []),
    reflections: models.map(() => []),
    history: [],
    afterWeek: 0,
    schedule: [],
    usage: [],
    swapsAllowed: 6,
    swapsUsed: models.map(() => 0),
  };
  const owned = new Set(rosters.flatMap((roster) => roster.map((candidate) => candidate.id)));
  let replayed: { drop: string; add: string } | undefined;
  for (const drop of rosters[first]!) {
    for (const add of BOARD.mons) {
      if (owned.has(add.id)) continue;
      try {
        replayed = parseTradeDecision({ swaps: [{ drop: drop.id, add: add.id }] }, state, first)
          .swaps[0]!;
      } catch {
        continue;
      }
      break;
    }
    if (replayed) break;
  }
  assert.ok(replayed, "the board must offer one legal post-draft swap");
  fs.rmSync(path.join(directory, "transactions"), { recursive: true, force: true });
  const seasonDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-outer-roster-season-"));
  t.onTestFinished(() => fs.rmSync(seasonDir, { recursive: true, force: true }));
  fs.cpSync(directory, seasonDir, { recursive: true });
  const changed = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-window-outer-roster-window-"));
  t.onTestFinished(() => fs.rmSync(changed, { recursive: true, force: true }));
  commitRunArtifact(changed, "transaction-event:1", "000001", {
    kind: "free_agency",
    entrant: first,
    model: config.entrants[first]!,
    swaps: [replayed],
    reasoning: "replayed roster plan",
    timestamp: new Date(0).toISOString(),
  });
  const artifact = await runTradeWindow(state, {
    runDir: changed,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 0,
    runAgent: scriptedAgent([]).run,
  });
  assert.ok(artifact.rosters[first]!.roster.some((mon) => mon.id === replayed.add));
  assert.deepEqual(
    readFranchiseRosterVersion(seasonDir, 0),
    drafted,
    "the stored draft roster is the version-0 snapshot",
  );
  assert.deepEqual(
    (
      await runDraftLeague(models, seasonDir, {
        recordsPath: path.join(seasonDir, "results.jsonl"),
        seed: 41,
        concurrency: 1,
        resume: true,
      })
    ).length,
    2,
  );
  assert.deepEqual(readFranchiseRosterVersion(seasonDir, 0), drafted);
});
