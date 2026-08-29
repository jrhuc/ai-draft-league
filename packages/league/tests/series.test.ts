import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  chanceEventCounts,
  foldSeriesGames,
  playBo3,
  SINGLE_ELIMINATION_GAME_LIMIT,
  seriesSeedSchedule,
} from "../src/series.js";
import type { JsonObject } from "../src/types.js";
import { asRecords, isText } from "../src/value.js";
import {
  attemptFixture,
  fakeEngines,
  recordedFixtureOptions,
  recordedIdentityFixture,
  writeGameCompletionMarkerFixture,
} from "./series-test-helpers.js";

test("chance-event counts retain uninterpreted protocol facts per side", () => {
  const counts = chanceEventCounts([
    "|move|p2a: Aerodactyl|Rock Slide|p1a: Politoed|[spread] p1a,p1b",
    "|-miss|p2a: Aerodactyl|p1b: Gengar",
    "|-crit|p1a: Politoed",
    "|cant|p1a: Politoed|flinch",
    "|cant|p1b: Tinkaton|flinch",
    "|cant|p2b: Kingambit|par",
    "|-damage|p1a: Politoed|100/196",
    "garbage line without pipe",
  ]);
  assert.deepEqual(counts.p1, { misses: 0, crits_taken: 1, flinched_turns: 2, full_paralysis: 0 });
  assert.deepEqual(counts.p2, { misses: 1, crits_taken: 0, flinched_turns: 0, full_paralysis: 1 });
});

test("game evidence separates model defaults, simulator substitutions, and timer autodefaults", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-fallback-evidence-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const engines = fakeEngines();
  let modelFallbacks = 5;
  engines.p1.decisionStats = () => ({ fallbacks: modelFallbacks });
  const result = await playBo3({
    engines,
    names: { p1: "Side One", p2: "Side Two" },
    players: { p1: "model-one", p2: "model-two" },
    teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
    gameSeeds: [[1, 2, 3, 4]],
    seriesId: "fallbacks",
    seriesDir: directory,
    format: "test",
    psDir: "",
    runBattle: async () => {
      modelFallbacks = 8;
      return {
        winner: "Side One",
        turns: 1,
        log: ["|win|Side One"],
        pov: { p1: [], p2: [] },
        errors: { p1: 0, p2: 0 },
        simulatorSubstitutions: { p1: 1, p2: 0 },
        timerAutodefaults: { p1: 2, p2: 0 },
      };
    },
  });
  assert.deepEqual(result.games[0]!.model_choice_fallbacks, { p1: 3, p2: 0 });
  assert.deepEqual(result.games[0]!.simulator_substitutions, { p1: 1, p2: 0 });
  assert.deepEqual(result.games[0]!.timer_autodefaults, { p1: 2, p2: 0 });
});

test("a result log is not adoptable until both post-game hooks finish", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-completion-marker-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const engines = fakeEngines();
  engines.p2.endGame = async () => {
    throw new Error("reflection failed");
  };
  const play = () =>
    playBo3({
      engines,
      names: { p1: "Side One", p2: "Side Two" },
      players: { p1: "model-one", p2: "model-two" },
      teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
      gameSeeds: [[1, 2, 3, 4]],
      seriesId: "marker",
      seriesDir: directory,
      format: "test",
      psDir: "",
      runBattle: async (_seed, onUpdate) => {
        onUpdate(["|win|Side One"], ["|win|Side One"]);
        return {
          winner: "Side One",
          turns: 1,
          log: ["|win|Side One"],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          simulatorSubstitutions: { p1: 0, p2: 0 },
          timerAutodefaults: { p1: 0, p2: 0 },
        };
      },
    });

  await assert.rejects(play(), /reflection failed/);
  assert.match(fs.readFileSync(path.join(directory, "game-1.log"), "utf8"), /\|win\|Side One/);
  assert.equal(fs.existsSync(path.join(directory, "game-1.complete.json")), false);

  engines.p2.endGame = async () => {};
  const result = await play();
  const marker = JSON.parse(fs.readFileSync(path.join(directory, "game-1.complete.json"), "utf8"));
  assert.equal(marker.kind, "game_complete");
  assert.equal(marker.schema_version, 2);
  assert.equal(marker.series_id, "marker");
  assert.equal(marker.game_number, 1);
  assert.ok(isText(marker.attempt_id) && marker.attempt_id !== "");
  assert.deepEqual(marker.seed, [1, 2, 3, 4]);
  assert.equal(
    marker.log_sha256,
    createHash("sha256")
      .update(fs.readFileSync(path.join(directory, "game-1.log")))
      .digest("hex"),
  );
  assert.deepEqual(
    { number: marker.game_number, seed: marker.seed, ...marker.summary },
    result.games[0],
  );
});

test("single-elimination seed schedule precommits all deterministic regulation and extension seeds", () => {
  const regulation: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const schedule = seriesSeedSchedule(regulation, true);
  assert.equal(schedule.length, SINGLE_ELIMINATION_GAME_LIMIT);
  assert.deepEqual(schedule.slice(0, 3), regulation);
  const tiedPrefix = schedule.slice(0, 4).map((seed, index) => ({
    number: index + 1,
    seed,
    winner_side: null,
  }));
  assert.deepEqual(
    foldSeriesGames(regulation, tiedPrefix, { requireWinner: true }).nextSeed,
    schedule[4],
  );
  assert.deepEqual(seriesSeedSchedule(regulation, false), regulation);
});

test("foldSeriesGames derives deterministic terminal playoff tiebreaks for games four through nine", () => {
  const regulation: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  for (let terminalGame = 4; terminalGame <= SINGLE_ELIMINATION_GAME_LIMIT; terminalGame += 1) {
    const games: Array<JsonObject> = [];
    const playedSeeds: Array<[number, number, number, number]> = [];
    while (games.length < terminalGame) {
      const folded = foldSeriesGames(regulation, games, { requireWinner: true });
      assert.equal(folded.complete, false);
      assert.ok(folded.nextSeed);
      playedSeeds.push(folded.nextSeed);
      const winnerSide = games.length + 1 === terminalGame ? "p1" : null;
      games.push({
        number: games.length + 1,
        seed: folded.nextSeed,
        winner_side: winnerSide,
        winner: winnerSide ? "one" : null,
      });
    }
    const terminal = foldSeriesGames(regulation, games, {
      requireWinner: true,
      players: { p1: "one", p2: "two" },
    });
    assert.equal(terminal.complete, true);
    assert.equal(terminal.winnerSide, "p1");
    assert.deepEqual(
      playedSeeds,
      games.map((game) => game.seed),
    );
  }
});

test("single elimination plays deterministic tiebreak games until one side wins", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-tiebreak-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planned: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const run = async (name: string) => {
    const seriesDir = path.join(directory, name);
    fs.mkdirSync(seriesDir);
    const seeds: Array<[number, number, number, number]> = [];
    let game = 0;
    const result = await playBo3({
      engines: fakeEngines(),
      names: { p1: "Side One", p2: "Side Two" },
      players: { p1: "model-one", p2: "model-two" },
      teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
      gameSeeds: planned,
      seriesId: name,
      seriesDir,
      format: "test",
      psDir: "",
      requireWinner: true,
      runBattle: async (seed) => {
        seeds.push(seed);
        game += 1;
        const winner = game === 4 ? "Side Two" : null;
        return {
          winner,
          turns: 1,
          log: [winner ? `|win|${winner}` : "|tie"],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          simulatorSubstitutions: { p1: 0, p2: 0 },
          timerAutodefaults: { p1: 0, p2: 0 },
        };
      },
    });
    return { result, seeds };
  };

  const first = await run("first");
  const second = await run("second");
  assert.equal(first.result.winnerSide, "p2");
  assert.deepEqual(first.result.score, { p1: 0, p2: 1 });
  assert.equal(first.result.games.length, 4);
  assert.deepEqual(first.result.games[0]!.model_choice_fallbacks, { p1: 0, p2: 0 });
  assert.deepEqual(first.result.games[0]!.simulator_substitutions, { p1: 0, p2: 0 });
  assert.deepEqual(first.result.games[0]!.timer_autodefaults, { p1: 0, p2: 0 });
  assert.deepEqual(first.seeds.slice(0, 3), planned);
  assert.deepEqual(first.seeds[3], second.seeds[3]);
});

test("a tied terminal game assigns tournament status from the series winner", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-terminal-tie-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const engines = fakeEngines();
  const statuses = { p1: new Array<string>(), p2: new Array<string>() };
  engines.p1.endGame = (context) => {
    statuses.p1.push(context.tournamentStatus ?? "none");
  };
  engines.p2.endGame = (context) => {
    statuses.p2.push(context.tournamentStatus ?? "none");
  };
  let game = 0;
  const result = await playBo3({
    engines,
    names: { p1: "Side One", p2: "Side Two" },
    players: { p1: "model-one", p2: "model-two" },
    teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    seriesId: "terminal-tie",
    seriesDir: directory,
    format: "test",
    psDir: "",
    requireWinner: true,
    tournamentRound: "round",
    runBattle: async () => {
      game += 1;
      const winner = game === 1 ? "Side One" : null;
      return {
        winner,
        turns: 1,
        log: [winner ? `|win|${winner}` : "|tie"],
        pov: { p1: [], p2: [] },
        errors: { p1: 0, p2: 0 },
        simulatorSubstitutions: { p1: 0, p2: 0 },
        timerAutodefaults: { p1: 0, p2: 0 },
      };
    },
  });

  assert.equal(result.winnerSide, "p1");
  assert.deepEqual(statuses.p1, ["active", "active", "advancing"]);
  assert.deepEqual(statuses.p2, ["active", "active", "eliminated"]);
});

test("single elimination fails rather than fabricating a winner after the safety cap", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-tiebreak-cap-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  let games = 0;
  await assert.rejects(
    playBo3({
      engines: fakeEngines(),
      names: { p1: "Side One", p2: "Side Two" },
      players: { p1: "model-one", p2: "model-two" },
      teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
      gameSeeds: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ],
      seriesId: "cap",
      seriesDir: directory,
      format: "test",
      psDir: "",
      requireWinner: true,
      runBattle: async () => {
        games += 1;
        return {
          winner: null,
          turns: 1,
          log: ["|tie"],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          simulatorSubstitutions: { p1: 0, p2: 0 },
          timerAutodefaults: { p1: 0, p2: 0 },
        };
      },
    }),
    /remained tied after 9 games/,
  );
  assert.equal(games, SINGLE_ELIMINATION_GAME_LIMIT);
});

test("a tied playoff resumes with its deterministic non-null tiebreak seed", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-tiebreak-resume-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 19, undefined, {
    requireWinner: true,
  });
  const seriesId = "tiebreakresume";
  const seriesDir = path.join(runDir, "series", seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, "series.json"),
    `${JSON.stringify({
      schema_version: 3,
      series_id: seriesId,
      started: "2026-01-01T00:00:00.000Z",
      identity: recordedIdentityFixture(options),
    })}
`,
  );
  const attemptId = "tiebreak-attempt";
  fs.writeFileSync(
    path.join(seriesDir, "series-attempts.jsonl"),
    `${JSON.stringify(attemptFixture("attempt_started", attemptId, seriesId))}
`,
  );
  const names = { p1: "p1-random", p2: "p2-random" };
  const regulation = options.gameSeeds.map((seed, index) => ({
    number: index + 1,
    winner: null,
    winner_side: null,
    seed,
  }));
  const expectedTiebreak = foldSeriesGames(options.gameSeeds, regulation, {
    requireWinner: true,
  }).nextSeed!;
  const scheduledSeeds = [...options.gameSeeds, expectedTiebreak];
  for (let game = 1; game <= 4; game += 1) {
    const terminal = game === 4 ? `|win|${names.p2}` : "|tie";
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      [
        `|player|p1|${names.p1}|1|`,
        `|player|p2|${names.p2}|2|`,
        `|turn|${game}`,
        terminal,
        "",
      ].join("\n"),
    );
    writeGameCompletionMarkerFixture(
      seriesDir,
      seriesId,
      game,
      attemptId,
      scheduledSeeds[game - 1]!,
      {
        winner: game === 4 ? "random" : null,
        winner_side: game === 4 ? "p2" : null,
        turns: game,
      },
    );
  }

  const { fields } = await playRecordedSeries(options);
  const games = asRecords(fields.games);
  assert.equal(games.length, 4);
  assert.equal(games[3]!.resumed, undefined);
  assert.deepEqual(games[3]!.seed, expectedTiebreak);
  assert.notEqual(games[3]!.seed, null);
  assert.equal(fields.winner_side, "p2");
});

test("adopted completed games fast-forward the series and only remaining games play", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-fastforward-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const seeds: Array<[number, number, number, number]> = [];
  const result = await playBo3({
    engines: fakeEngines(),
    names: { p1: "Side One", p2: "Side Two" },
    players: { p1: "model-one", p2: "model-two" },
    teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    completedGames: [
      {
        number: 1,
        winner: "model-one",
        winner_side: "p1",
        turns: 9,
        seed: [1, 2, 3, 4],
        resumed: true,
      },
    ],
    seriesId: "fastforward",
    seriesDir: directory,
    format: "test",
    psDir: "",
    runBattle: async (seed) => {
      seeds.push(seed);
      return {
        winner: "Side One",
        turns: 3,
        log: ["|win|Side One"],
        pov: { p1: [], p2: [] },
        errors: { p1: 0, p2: 0 },
        simulatorSubstitutions: { p1: 0, p2: 0 },
        timerAutodefaults: { p1: 0, p2: 0 },
      };
    },
  });
  assert.deepEqual(seeds, [[5, 6, 7, 8]], "only game two plays, on its planned seed");
  assert.equal(result.winnerSide, "p1");
  assert.deepEqual(result.score, { p1: 2, p2: 0 });
  assert.equal(result.games.length, 2);
  assert.equal(result.games[0]!.resumed, true);
  assert.equal(result.games[1]!.number, 2);
});

test("a decided adopted series plays nothing at all", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-decided-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await playBo3({
    engines: fakeEngines(),
    names: { p1: "Side One", p2: "Side Two" },
    players: { p1: "model-one", p2: "model-two" },
    teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    completedGames: [
      { number: 1, winner: "model-two", winner_side: "p2", turns: 4, seed: [1, 2, 3, 4] },
      { number: 2, winner: "model-two", winner_side: "p2", turns: 6, seed: [5, 6, 7, 8] },
    ],
    seriesId: "decided",
    seriesDir: directory,
    format: "test",
    psDir: "",
    runBattle: async () => {
      throw new Error("no game should run");
    },
  });
  assert.equal(result.winnerSide, "p2");
  assert.deepEqual(result.score, { p1: 0, p2: 2 });
  assert.equal(result.games.length, 2);
});

test("a live restart has no lineage link and keeps prior rows append-only", async (t) => {
  const { playRecordedSeries } = await import("../src/series.js");
  const { loadPool } = await import("../src/teams.js");
  const { defaultPsDir } = await import("../src/paths.js");
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-series-adopt-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 4);
  const priorDir = path.join(runDir, "series", "priorattempt1");
  fs.mkdirSync(priorDir, { recursive: true });
  const metadata = {
    schema_version: 3,
    series_id: "priorattempt1",
    started: "2026-01-01T00:00:00.000Z",
    identity: recordedIdentityFixture(options),
  };
  fs.writeFileSync(path.join(priorDir, "series.json"), `${JSON.stringify(metadata)}\n`);
  fs.writeFileSync(
    path.join(priorDir, "game-1.log"),
    [
      "|player|p1|p1-random|1|",
      "|player|p2|p2-random|2|",
      "|turn|1",
      "|turn|7",
      "|win|p1-random",
      "",
    ].join("\n"),
  );
  writeGameCompletionMarkerFixture(
    priorDir,
    "priorattempt1",
    1,
    "prior-attempt",
    options.gameSeeds[0]!,
    {
      winner: "random",
      winner_side: "p1",
      turns: 7,
      errors: { p1: 2, p2: 3 },
      model_choice_fallbacks: { p1: 4, p2: 5 },
      simulator_substitutions: { p1: 6, p2: 7 },
      timer_autodefaults: { p1: 8, p2: 9 },
      chance_events: {
        p1: { misses: 1, crits_taken: 2, flinched_turns: 3, full_paralysis: 4 },
        p2: { misses: 5, crits_taken: 6, flinched_turns: 7, full_paralysis: 8 },
      },
    },
  );
  fs.writeFileSync(
    path.join(priorDir, "game-2.log"),
    ["|player|p1|p1-random|1|", "|player|p2|p2-random|2|", "|turn|1", "|turn|3", ""].join("\n"),
  );
  const decisionFile = path.join(priorDir, "p1-decisions.jsonl");
  const submittedDecisions = [
    JSON.stringify({
      kind: "decision",
      attempt_id: "prior-attempt",
      submission_id: "prior-attempt:1:p1:1",
      submission_source: "random",
      outcome: "accepted",
      action: "move 1",
      game_number: 1,
      turn: 5,
      notebook: "kept: lead pelipper",
    }),
    JSON.stringify({
      kind: "decision",
      attempt_id: "prior-attempt",
      submission_id: "prior-attempt:2:p1:1",
      submission_source: "random",
      outcome: "accepted",
      action: "move 1",
      game_number: 2,
      turn: 2,
      notebook: "stale: from abandoned game",
    }),
    "",
  ].join("\n");
  fs.writeFileSync(decisionFile, submittedDecisions);
  fs.writeFileSync(
    path.join(priorDir, "series-attempts.jsonl"),
    `${JSON.stringify(attemptFixture("attempt_started", "prior-attempt", "priorattempt1"))}\n`,
  );

  const { fields } = await playRecordedSeries(options);
  assert.equal(fields.series_id, "priorattempt1", "the prior directory is adopted, not replaced");
  const games = asRecords(fields.games);
  assert.equal(games[0]!.resumed, undefined);
  assert.equal(games[0]!.winner_side, "p1");
  assert.equal(games[0]!.turns, 7);
  assert.equal(games[0]!.winner, "random");
  assert.deepEqual(games[0]!.errors, { p1: 2, p2: 3 });
  assert.deepEqual(games[0]!.model_choice_fallbacks, { p1: 4, p2: 5 });
  assert.deepEqual(games[0]!.simulator_substitutions, { p1: 6, p2: 7 });
  assert.deepEqual(games[0]!.timer_autodefaults, { p1: 8, p2: 9 });
  assert.deepEqual(games[0]!.chance_events, {
    p1: { misses: 1, crits_taken: 2, flinched_turns: 3, full_paralysis: 4 },
    p2: { misses: 5, crits_taken: 6, flinched_turns: 7, full_paralysis: 8 },
  });
  assert.ok(games.length >= 2, "the unfinished second game replays");
  assert.equal(games[1]!.resumed, undefined);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(priorDir, "series.json"), "utf8")),
    metadata,
  );
  const appendedDecisions = fs.readFileSync(decisionFile, "utf8");
  assert.ok(appendedDecisions.startsWith(submittedDecisions));
  const appendedRows = appendedDecisions
    .slice(submittedDecisions.length)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    appendedRows.some((row) => row.kind === "decision" && row.submission_source === "random"),
  );
  assert.ok(appendedRows.some((row) => row.kind === "decision" && row.outcome === "accepted"));
  const submissionIds = appendedRows.flatMap((row) =>
    row.kind === "decision" ? [row.submission_id] : [],
  );
  assert.equal(new Set(submissionIds).size, submissionIds.length);
  assert.ok(submissionIds.every((id) => String(id).startsWith(`${String(fields.attempt_id)}:`)));
  const attemptRows = fs
    .readFileSync(path.join(priorDir, "series-attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const liveStart = attemptRows.find(
    (row) => row.kind === "attempt_started" && row.attempt_id === fields.attempt_id,
  );
  assert.ok(liveStart);
  assert.equal(liveStart.resumed_from, undefined);
  assert.equal(attemptRows.at(-1)!.kind, "attempt_completed");

  await playRecordedSeries(options);
  assert.equal(fs.readFileSync(decisionFile, "utf8"), appendedDecisions);
  const retriedStarts = fs
    .readFileSync(path.join(priorDir, "series-attempts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind === "attempt_started");
  assert.equal(retriedStarts.at(-1)!.resumed_from, undefined);
  const { score } = fields;
  assert.ok(score.p1 === 2 || score.p2 === 2, "the series still finishes with a winner");
  assert.ok(score.p1! >= 1, "the adopted game one win persists in the score");
});
