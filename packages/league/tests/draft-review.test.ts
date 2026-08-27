import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { createBoardSearch } from "../src/board-search.js";
import { draftBoardTable, draftUserPrompt } from "../src/draft.js";
import { runDraftLeague } from "../src/draftleague.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { defaultPsDir } from "../src/paths.js";
import { loadRosterPreset, presetRosters } from "../src/roster-preset.js";
import {
  parseSeasonReview,
  runSeasonReview,
  type SeasonReviewState,
} from "../src/season-review.js";
import {
  describeTransactionHistory,
  renderFreeAgencyPrompt,
  renderTradeOfferPrompt,
} from "../src/trade-window.js";
import type { Completion, JsonObject, ProviderMessage } from "../src/types.js";
import { count } from "../src/value.js";
import { accepted, rejection } from "./asserts.js";
import {
  assertFormatAuthority,
  BOARD,
  freshState,
  mon,
  transactionState,
} from "./draft-test-helpers.js";

test("the board is published price-descending the way a draft league publishes one", () => {
  const costs = draftBoardTable(BOARD, defaultPsDir())
    .split("\n")
    .slice(1)
    .map((line) => Number(line.split(" | ")[1]));
  assert.ok(costs.length > 1, "the board renders rows");
  assert.ok(
    costs.every((cost, index) => index === 0 || cost <= costs[index - 1]!),
    "contested premium entries are listed first",
  );
});

test("the draft prompt states budget rules without computing a ceiling for the coach", () => {
  const state = freshState();
  state.teamNames[1] = "Drought Dodgers";
  state.rosters[1] = [mon("charizard-mega-y")];
  state.taken.set("charizard-mega-y", 1);
  state.budgets[1] = state.budgets[1]! - mon("charizard-mega-y").cost;
  const prompt = draftUserPrompt(state, 0, ["fake:model", "random"], 0, "");
  assert.ok(
    !/most you can spend/.test(prompt),
    "the harness does not compute an affordable ceiling",
  );
  assert.match(
    prompt,
    /points to fill them from what is still on the board/,
    "the budget rule is still stated",
  );
  assert.ok(
    prompt.indexOf("YOUR ROSTER") < prompt.lastIndexOf("points to fill them"),
    "roster context comes before the budget line",
  );
  assert.ok(!/roster plan and needs/.test(prompt), "the notebook does not prescribe a needs list");
  assert.match(prompt, /random/);
  assert.doesNotMatch(prompt, /Drought Dodgers/);
});

test("season reviews are written once per coach and replayed on resume", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-season-review-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = ["test:champion", "test:eliminated"];
  const state: SeasonReviewState = {
    board: BOARD,
    models,
    picks: [
      {
        pick: 0,
        entrant: 0,
        mon: mon("charizard-mega-y").id,
        rationale: "Sun opener.",
        fallback: false,
      },
      { pick: 1, entrant: 1, mon: mon("tyranitar").id, rationale: "Sand anchor.", fallback: false },
    ],
    rosters: [[mon("charizard-mega-y")], [mon("tyranitar")]],
    windows: [
      {
        after_week: 3,
        order: [1, 0],
        swaps_used: [1, 0],
        offers: [],
        decisions: [
          { entrant: 1, model: models[1]!, swaps: [], reasoning: "Kept it.", fallback: false },
          {
            entrant: 0,
            model: models[0]!,
            swaps: [{ drop: mon("venusaur").id, add: mon("absol").id }],
            reasoning: "Traded up.",
            fallback: false,
          },
        ],
        rosters: [],
      },
    ],
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    series: [
      ["Round-robin week 1: beat test:eliminated 2-0"],
      ["Round-robin week 1: lost to test:champion 0-2"],
    ],
    notebooks: ["champion plan", "eliminated plan"],
  };
  const prompts = new Map<string, string>();
  const reply = JSON.stringify({
    summary: "It went as the record says.",
    did_well: "The draft covered rain.",
    did_poorly: "The mega slot was idle.",
    would_change: "Buy the backup mega.",
  });
  const reviewOptions = {
    runDir: directory,
    psDir: defaultPsDir(),
    makeReviewProvider: (spec: string) => ({
      complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
        prompts.set(spec, `${system}\n${messages[0]?.content ?? ""}`);
        return Promise.resolve({ text: reply, usage: {}, toolCalls: [] });
      },
    }),
  };
  const initial = await runSeasonReview(
    [{ entrant: 1, outcome: "You missed the playoffs." }],
    state,
    reviewOptions,
  );
  assert.deepEqual(
    initial.map((review) => review.entrant),
    [1],
  );
  fs.appendFileSync(path.join(directory, "season.jsonl"), '{"entrant":');
  const reviews = await runSeasonReview(
    [
      { entrant: 1, outcome: "You missed the playoffs." },
      { entrant: 0, outcome: "You won the final." },
    ],
    state,
    reviewOptions,
  );

  assert.deepEqual(
    reviews.map((review) => review.entrant),
    [1, 0],
  );
  assert.ok(reviews.every((review) => !review.fallback));
  assert.match(prompts.get(models[0]!) ?? "", /Traded up\./);
  assertFormatAuthority(prompts.get(models[0]!) ?? "");
  assertFormatAuthority(prompts.get(models[1]!) ?? "");
  assert.match(prompts.get(models[1]!) ?? "", /You are test:eliminated, manager of a franchise/);
  assert.doesNotMatch(prompts.get(models[1]!) ?? "", /\b(?:Champion|Eliminated)\b/);
  assert.match(prompts.get(models[1]!) ?? "", /You made no swaps/);
  assert.match(prompts.get(models[1]!) ?? "", /Sand anchor\./);
  assert.equal(readJsonlObjects(path.join(directory, "season.jsonl")).length, 2);

  const replayed = await runSeasonReview([{ entrant: 0, outcome: "You won the final." }], state, {
    runDir: directory,
    psDir: defaultPsDir(),
    makeReviewProvider: () => ({
      complete(): Promise<Completion> {
        throw new Error("a replayed season review must not call a provider");
      },
    }),
  });
  const byEntrant = (rows: typeof reviews) => [...rows].sort((a, b) => a.entrant - b.entrant);
  assert.deepEqual(byEntrant(replayed), byEntrant(reviews));

  const started: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve, reject) => {
    releaseFirst = resolve;
    setTimeout(
      () => reject(new Error("the second seat never started: season reviews ran one at a time")),
      5_000,
    ).unref();
  });
  const concurrent = await runSeasonReview(
    [
      { entrant: 0, outcome: "You won the final." },
      { entrant: 1, outcome: "You missed the playoffs." },
    ],
    state,
    {
      runDir: fs.mkdtempSync(path.join(os.tmpdir(), "vgc-season-review-parallel-")),
      psDir: defaultPsDir(),
      makeReviewProvider: (spec) => ({
        async complete(): Promise<Completion> {
          const entrant = models.indexOf(spec);
          started.push(entrant);
          if (started.length === 1) await bothStarted;
          else releaseFirst?.();
          return { text: reply, usage: {}, toolCalls: [] };
        },
      }),
    },
  );
  assert.deepEqual(
    concurrent.map((review) => review.entrant),
    [0, 1],
    "reviews return in the order the seats finished their seasons, whatever order they answer in",
  );
  assert.ok(
    concurrent.every((review) => !review.fallback),
    "both seats were in flight at once",
  );
});

test("a season review must fill every field", () => {
  rejection(parseSeasonReview("no json here"));
  rejection(
    parseSeasonReview(
      JSON.stringify({ summary: "a", did_well: "b", did_poorly: "c", would_change: "  " }),
    ),
  );
  accepted(
    parseSeasonReview(
      JSON.stringify({ summary: "a", did_well: "b", did_poorly: "c", would_change: "d", extra: 1 }),
    ),
  );
});

test("search_board filters the board by price, type, ability, and legal movepool", () => {
  const search = createBoardSearch(BOARD, defaultPsDir());
  const ids = (result: string): string[] =>
    result
      .split("\n")
      .slice(1)
      .map((line) => line.slice(2).split(" | ")[0]!);

  const cheapFire = search.run({ types: ["fire"], max_cost: 10, limit: 100 });
  const cheapFireIds = ids(cheapFire);
  assert.ok(cheapFireIds.length > 0, "the board has cheap Fire types");
  for (const id of cheapFireIds) {
    const entry = mon(id);
    assert.ok(entry.cost <= 10, `${id} respects max_cost`);
    assert.ok(
      entry.types.some((type) => type.toLowerCase() === "fire"),
      `${id} is Fire`,
    );
  }

  const fakeOut = ids(search.run({ learns: "Fake Out", limit: 100 }));
  assert.ok(fakeOut.includes("incineroar"), "Incineroar learns Fake Out");
  assert.ok(!fakeOut.includes("archaludon"), "Archaludon does not learn Fake Out");

  const intimidate = ids(search.run({ ability: "Intimidate", limit: 100 }));
  assert.ok(intimidate.includes("incineroar"), "Incineroar has Intimidate");

  const dual = ids(search.run({ types: ["Fire", "Flying"], limit: 100 }));
  assert.ok(dual.includes("charizard-mega-y"), "both listed types must match");
  assert.ok(!dual.includes("incineroar"), "a Fire/Dark entry does not match Fire/Flying");

  assert.match(search.run({ learns: "Nonexistent Move" }), /No move data/);
  assert.match(search.run({ max_cost: 0 }), /No board entries match/);
});

test("search_board sorts by price by default and reaches entries the board buries", () => {
  const search = createBoardSearch(BOARD, defaultPsDir());
  const rows = search.run({ limit: 100 }).split("\n").slice(1);
  const costs = rows.map((line) => Number(line.split(" | ")[1]));
  assert.ok(
    costs.every((cost, index) => index === 0 || cost <= costs[index - 1]!),
    "default sort is price-descending",
  );

  const byName = search.run({ sort: "name", limit: 100 }).split("\n").slice(1);
  const names = byName.map((line) => line.split(" | ")[2]!);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
    "name sort is alphabetical",
  );

  const bst = search.run({ min_bst: 600, limit: 100 });
  assert.ok(ids(bst).length > 0, "the base stat filter returns entries");
  function ids(result: string): string[] {
    return result
      .split("\n")
      .slice(1)
      .map((line) => line.slice(2).split(" | ")[0]!);
  }
});

test("window prompts name their place in the schedule and the public moves of earlier windows", () => {
  const state = transactionState();
  const first = { afterWeek: 1, index: 0, count: 3 };
  const last = { afterWeek: 3, index: 2, count: 3 };
  const opening = renderTradeOfferPrompt(state, 0, defaultPsDir(), { position: first });
  assert.match(
    opening,
    /transaction window 1 of 3, open after round-robin week 1\. 2 more windows follow/,
  );
  assert.ok(
    !opening.includes("PUBLIC TRANSACTIONS FROM EARLIER WINDOWS"),
    "the first window has no history",
  );
  const closing = renderFreeAgencyPrompt(
    {
      ...state,
      history: describeTransactionHistory(
        [
          {
            after_week: 1,
            order: [1, 0],
            swaps_used: [0, 0],
            offers: [
              {
                from: 1,
                to: 0,
                give: "a",
                get: "b",
                message: "swap?",
                accepted: true,
                proposerFallback: false,
                responderFallback: false,
                offerReasoning: "",
                responseReasoning: "",
              },
            ],
            decisions: [
              {
                entrant: 0,
                model: "random",
                swaps: [{ drop: "c", add: "d" }],
                reasoning: "",
                fallback: false,
              },
            ],
            rosters: [],
          },
        ],
        state.models,
      ),
    },
    0,
    defaultPsDir(),
    { position: last },
  );
  assert.match(
    closing,
    /transaction window 3 of 3, open after round-robin week 3\. Rosters lock when this window closes/,
  );
  assert.match(
    closing,
    /PUBLIC TRANSACTIONS FROM EARLIER WINDOWS:\n- After week 1: random traded a to random for b\.\n- After week 1: random dropped c and added d\./,
  );
});

test("a league stopped after its second window resumes on the right roster version", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-epochs-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = ["random", "random", "random", "random"];
  const first = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 23,
    concurrency: 2,
    throughWeek: 2,
    transactions: [
      { afterWeek: 1, tradesAllowed: 0 },
      { afterWeek: 2, tradesAllowed: 0 },
    ],
  });
  assert.equal(first.length, 4, "two weeks of a four-coach league are four series");
  assert.ok(fs.existsSync(path.join(directory, "transactions", "after-week-1", "window.json")));
  assert.ok(
    fs.existsSync(path.join(directory, "transactions", "after-week-2", "window.json")),
    "stopping after week 2 closes its window too",
  );
  assert.ok(
    fs.existsSync(path.join(directory, "reviews", "week-1.jsonl")),
    "week 1 was reviewed before its window",
  );
  assert.ok(
    fs.existsSync(path.join(directory, "reviews", "week-2.jsonl")),
    "pausing after week 2 keeps its review",
  );
  const resumed = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 23,
    concurrency: 2,
    resume: true,
  });
  assert.equal(resumed.length, 7);
  assert.ok(fs.existsSync(path.join(directory, "transactions", "after-week-2", "window.json")));
  for (const week of [1, 2, 3]) {
    const reviews = readJsonlObjects(path.join(directory, "reviews", `week-${week}.jsonl`));
    assert.equal(reviews.length, 4, `every coach reviews week ${week}`);
    assert.ok(reviews.every((row) => row.roster_version === Math.min(week - 1, 2)));
  }
  for (const week of [1, 2]) {
    const windowFile = path.join(directory, "transactions", `after-week-${week}`, "window.json");
    const window: {
      decisions: Array<{ entrant: number; swaps: unknown[] }>;
    } = JSON.parse(fs.readFileSync(windowFile, "utf8"));
    const changed = window.decisions
      .filter((decision) => decision.swaps.length)
      .map((decision) => decision.entrant);
    const reconciliations = readJsonlObjects(
      path.join(directory, "reviews", `week-${week}-transactions.jsonl`),
    );
    assert.deepEqual(
      reconciliations.map((row) => row.entrant).sort((a, b) => count(a) - count(b)),
      [...changed].sort((a, b) => a - b),
      `every coach whose roster changed after week ${week} reconciles its notebook`,
    );
    assert.ok(
      reconciliations.every((row) => row.roster_version === week && row.stage === "transactions"),
    );
  }
  const config: JsonObject = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.equal(config.sequential_weeks, true);
  for (const row of resumed) {
    assert.deepEqual(row.transactions, [
      { after_week: 1, trades_allowed: 0 },
      { after_week: 2, trades_allowed: 0 },
    ]);
    assert.equal(
      row.roster_version,
      row.stage === "playoff" ? 2 : Math.min(Number(row.round) - 1, 2),
    );
  }
  const replayed = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 23,
    concurrency: 2,
    resume: true,
  });
  assert.deepEqual(
    replayed.map((row) => row.series_id),
    resumed.map((row) => row.series_id),
    "a complete league replays without new series",
  );
});

test("a roster preset seeds the league without a draft and resumes on its rosters", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-league-preset-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, "results.jsonl");
  const models = ["random", "random", "random", "random"];
  const preset = loadRosterPreset(path.join(process.cwd(), "presets", "noise-quartet.json"));
  assert.equal(preset.teams.length, 4);
  const rows = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 5,
    concurrency: 2,
    throughWeek: 1,
    preset,
  });
  assert.equal(rows.length, 2);
  assert.ok(!fs.existsSync(path.join(directory, "draft")), "no draft log is written");
  const config: {
    preset: string;
    team_names: string[];
    rosters: string[][];
    draft_notes: string[];
  } = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"));
  assert.equal(config.preset, "noise-quartet");
  assert.deepEqual(
    config.team_names,
    preset.teams.map((team) => team.name),
  );
  assert.deepEqual(
    config.rosters,
    preset.teams.map((team) => team.roster),
  );
  assert.deepEqual(config.draft_notes, ["", "", "", ""]);
  const resumed = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 5,
    concurrency: 2,
    resume: true,
  });
  assert.equal(resumed.length, 7);
  const after: { preset: string } = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  assert.equal(after.preset, "noise-quartet");
});

test("a roster preset is refused when it breaks the board rules", () => {
  const preset = loadRosterPreset(path.join(process.cwd(), "presets", "noise-quartet.json"));
  const board = BOARD;
  assert.equal(presetRosters(preset, board, 4).length, 4);
  const octet = loadRosterPreset(path.join(process.cwd(), "presets", "noise-octet.json"));
  assert.equal(presetRosters(octet, board, 8).length, 8);
  assert.deepEqual(
    octet.teams.slice(0, 4),
    preset.teams,
    "the quartet is the first half of the octet",
  );
  assert.throws(() => presetRosters(preset, board, 2), /4 teams for 2 entrants/);
  assert.throws(
    () => presetRosters({ ...preset, board: "other" }, board, 4),
    /drawn from board other/,
  );
  const clone = structuredClone(preset);
  clone.teams[1]!.roster[0] = clone.teams[0]!.roster[0]!;
  assert.throws(() => presetRosters(clone, board, 4), /repeats/);
  const costly = structuredClone(preset);
  costly.teams[0]!.roster[9] = "gengar-mega";
  assert.throws(() => presetRosters(costly, board, 4), /above the 100-point budget/);
  const unknown = structuredClone(preset);
  unknown.teams[0]!.roster[0] = "missingno";
  assert.throws(() => presetRosters(unknown, board, 4), /does not hold/);
});

test("Mega board rows carry the base forme price and base rows do not", () => {
  const search = createBoardSearch(BOARD, defaultPsDir());
  const rows = search.run({ limit: 1000 }).split("\n").slice(1);
  const row = (id: string) => rows.find((line) => line.startsWith(`- ${id} |`))!;
  const base = mon("charizard");
  assert.match(row("charizard-mega-y"), new RegExp(`\\| base Charizard costs ${base.cost}$`));
  assert.ok(!/\| base /.test(row("charizard")), "a base row names no base price");
  assert.ok(draftBoardTable(BOARD, defaultPsDir()).includes(`| base Charizard costs ${base.cost}`));
});
