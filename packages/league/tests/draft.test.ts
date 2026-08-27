import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import type { DraftBoardMon, DraftState } from "../src/draft.js";
import {
  applyDraftPick,
  boardInfo,
  legalPicks,
  loadBoard,
  maxAffordable,
  snakeOrder,
} from "../src/draft.js";
import { runDraftLeague } from "../src/draftleague.js";
import { draftLeagueTopology, roundRobinWeeks } from "../src/draftleague-topology.js";
import { emptyMemory } from "../src/franchise-memory.js";
import { readJsonlObjects } from "../src/jsonl.js";
import { defaultPsDir } from "../src/paths.js";
import { loadShowdown } from "../src/showdown.js";
import {
  applyFreeAgency,
  applyTradeOffer,
  MAX_TRADE_OFFERS,
  parseTradeDecision,
  parseTradeOffer,
  parseTradeResponse,
  readValidatedTradeWindow,
  runTradeWindow,
  type TradeWindowState,
} from "../src/trade-window.js";
import type { Completion, JsonObject, ProviderMessage } from "../src/types.js";
import { isCount, isText } from "../src/value.js";
import { accepted, rejection } from "./asserts.js";
import {
  assertFormatAuthority,
  BOARD,
  freshState,
  mon,
  transactionState,
} from "./draft-test-helpers.js";

test("the bundled board fits eight coaches", () => {
  assert.equal(BOARD.format, "gen9championsvgc2026regmbbo3");
  assert.equal(BOARD.budget, 100);
  assert.equal(BOARD.picks, 10);
  assert.equal(new Set(BOARD.mons.map((entry) => entry.id)).size, BOARD.mons.length);
  const info = boardInfo(BOARD);
  assert.ok(info.maxEntrants >= 8, `board must seat eight coaches, seats ${info.maxEntrants}`);
  assert.ok(
    new Set(BOARD.mons.map((entry) => entry.base)).size >= 8 * BOARD.picks,
    "exclusivity needs one distinct species per pick across the field",
  );
});

test("mega entries register the base forme and lock their stone", () => {
  const { Dex } = loadShowdown();
  const dex = Dex.mod("champions");
  const megas = BOARD.mons.filter((entry) => entry.item);
  assert.ok(megas.length > 60, "the board should carry the Champions mega roster");
  for (const entry of megas) {
    const registered = dex.species.get(entry.species);
    assert.ok(
      registered.exists && !registered.name.includes("-Mega"),
      `${entry.id} registers a base forme`,
    );
    const stone = dex.items.get(entry.item!);
    assert.ok(stone.exists, `${entry.id} names a real stone`);
    const megaStone = stone.megaStone;
    const target = isText(megaStone) ? megaStone : megaStone?.[registered.name];
    assert.equal(target, entry.forme, `${entry.id} stone must produce its forme`);
  }
  const zard = mon("charizard-mega-y");
  assert.equal(zard.species, "Charizard");
  assert.equal(zard.item, "Charizardite Y");
  assert.equal(mon("charizard").item, undefined, "the base entry may never hold a stone");
  assert.equal(mon("charizard").base, zard.base, "base and mega share a species-clause key");
});

test("re-priced entries keep the prior listing and the usage that moved it", () => {
  const adjusted = BOARD.mons.filter((entry) => entry.usage);
  assert.ok(
    adjusted.length > 40,
    "the usage pass should have moved a meaningful share of the board",
  );
  for (const entry of adjusted) {
    assert.ok(isCount(entry.listed) && entry.listed !== entry.cost);
    assert.match(entry.usage!, /^#\d+ at [\d.]+%$/);
  }
  assert.equal(mon("farigiraf").cost, 18, "a Reg M-B staple should not stay at its Reg M-A price");
  assert.equal(mon("toxapex").listed, 3, "Toxapex was exploitably cheap on the prior board");
  assert.ok(mon("toxapex").cost > 3);
});

test("a board id must match its filename", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-board-id-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "foo.json"), JSON.stringify({ ...BOARD, id: "bar" }));
  assert.throws(() => loadBoard("foo", directory), /id must match its filename/);
});

test("a board entry naming an unknown species is rejected", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-board-species-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mons = BOARD.mons.map((entry, index) =>
    index === 0 ? { ...entry, species: "Missingno" } : entry,
  );
  fs.writeFileSync(path.join(directory, "bad.json"), JSON.stringify({ ...BOARD, id: "bad", mons }));
  assert.throws(() => loadBoard("bad", directory), /not a legal species/);
});

test("a board rejects inconsistent battle metadata and an unaffordable budget", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-board-invariants-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (id: string, mons: DraftBoardMon[], budget = BOARD.budget) => {
    fs.writeFileSync(
      path.join(directory, `${id}.json`),
      JSON.stringify({ ...BOARD, id, budget, mons }),
    );
  };

  write(
    "bad-base",
    BOARD.mons.map((entry, index) => (index ? entry : { ...entry, base: "Missing" })),
  );
  assert.throws(() => loadBoard("bad-base", directory), /wrong base species/);

  const mega = BOARD.mons.findIndex((entry) => entry.item);
  write(
    "bad-mega",
    BOARD.mons.map((entry, index) => (index === mega ? { ...entry, item: "Leftovers" } : entry)),
  );
  assert.throws(() => loadBoard("bad-mega", directory), /invalid Mega forme or stone/);

  write("bad-budget", BOARD.mons, 1);
  assert.throws(() => loadBoard("bad-budget", directory), /budget that can afford/);
});

test("snake order reverses on every round", () => {
  assert.deepEqual(snakeOrder(4, 3), [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]);
  assert.deepEqual(snakeOrder(2, 2), [0, 1, 1, 0]);
});

test("draft pick transitions enforce the exact turn without mutating prior state", () => {
  const snapshot = (state: DraftState) => ({
    taken: [...state.taken],
    rosters: state.rosters.map((roster) => roster.map((entry) => entry.id)),
    budgets: [...state.budgets],
    teamNames: [...state.teamNames],
  });
  const initial = freshState();
  const untouched = snapshot(initial);
  const action = { pick: 1, entrant: 0, mon: "garchomp" };
  const picked = applyDraftPick(initial, action);

  assert.deepEqual(snapshot(initial), untouched);

  const afterAccepted = snapshot(picked);
  assert.throws(() => applyDraftPick(picked, action), /pick 1 is stale; expected pick 2/);
  assert.deepEqual(snapshot(picked), afterAccepted);
  assert.throws(
    () => applyDraftPick(initial, { ...action, entrant: 1 }),
    /pick 1 belongs to entrant 0, not entrant 1/,
  );
  assert.deepEqual(snapshot(initial), untouched);
});

test("draft pick transitions reject unavailable, species-clashing, and over-budget picks atomically", () => {
  const first = applyDraftPick(freshState(), { pick: 1, entrant: 0, mon: "garchomp" });
  const afterFirst = {
    taken: [...first.taken],
    rosters: first.rosters.map((roster) => [...roster]),
    budgets: [...first.budgets],
  };
  assert.throws(
    () => applyDraftPick(first, { pick: 2, entrant: 1, mon: "garchomp" }),
    /already drafted by coach 1/,
  );
  assert.deepEqual(
    { taken: [...first.taken], rosters: first.rosters, budgets: first.budgets },
    afterFirst,
  );

  const second = applyDraftPick(first, { pick: 2, entrant: 1, mon: "charizard-mega-y" });
  const beforeClash = structuredClone(second);
  assert.throws(
    () => applyDraftPick(second, { pick: 3, entrant: 1, mon: "charizard" }),
    /shares the species Charizard/,
  );
  assert.deepEqual(second, beforeClash);

  const tight = freshState({ budgets: [1, BOARD.budget] });
  const beforeBudget = structuredClone(tight);
  assert.throws(
    () => applyDraftPick(tight, { pick: 1, entrant: 0, mon: "garchomp" }),
    /costs .* but you can spend at most/,
  );
  assert.deepEqual(tight, beforeBudget);
});

test("the round robin pairs every coach once and plays one match a week", () => {
  for (const size of [2, 4, 7, 8]) {
    const weeks = roundRobinWeeks(size);
    assert.equal(weeks.length, size % 2 ? size : size - 1, `${size} coaches`);
    const seen = new Set<string>();
    for (const week of weeks) {
      const playing = new Set<number>();
      for (const [home, away] of week) {
        assert.ok(
          !playing.has(home) && !playing.has(away),
          `${size}: a coach plays twice in one week`,
        );
        playing.add(home);
        playing.add(away);
        const key = [home, away].sort((a, b) => a - b).join("-");
        assert.ok(!seen.has(key), `${size}: ${key} is scheduled twice`);
        seen.add(key);
      }
    }
    assert.equal(seen.size, (size * (size - 1)) / 2, `${size}: every pair meets exactly once`);
    const topology = draftLeagueTopology(size);
    assert.equal(topology.weekCount, weeks.length);
    assert.equal(topology.roundRobinSeries, seen.size);
    assert.equal(topology.playoffSeries, size >= 5 ? 3 : 1);
    assert.equal(topology.totalSeries, seen.size + topology.playoffSeries);
  }
});

test("trade-window swaps are atomic and may upgrade a base entry to its Mega", () => {
  const tyranitar = mon("tyranitar");
  const megaTyranitar = mon("tyranitar-mega");
  const mrRime = mon("mr-rime");
  const absol = mon("absol");
  const excluded = new Set([tyranitar.base, mrRime.base, absol.base]);
  const support: DraftBoardMon[] = [];
  for (const candidate of [...BOARD.mons].sort((a, b) => a.cost - b.cost)) {
    if (excluded.has(candidate.base)) continue;
    excluded.add(candidate.base);
    support.push(candidate);
    if (support.length === 8) break;
  }
  const roster = [tyranitar, mrRime, ...support];
  const spent = roster.reduce((sum, entry) => sum + entry.cost, 0);
  const state: TradeWindowState = {
    board: { ...BOARD, budget: spent },
    models: ["openrouter:opus", "random"],
    teamNames: ["Opus", "Rival"],
    rosters: [roster, []],
    budgets: [0, spent],
    memories: [emptyMemory("Tyranitar is the endgame."), emptyMemory()],
    standings: [
      { entrant: 1, w: 2, l: 0, gw: 4, gl: 1 },
      { entrant: 0, w: 0, l: 2, gw: 1, gl: 4 },
    ],
    results: [[], []],
    reflections: [[], []],
    history: [],
    swapsAllowed: 6,
    swapsUsed: [0, 0],
  };

  const overBudget = parseTradeDecision(
    JSON.stringify({
      swaps: [{ drop: tyranitar.id, add: megaTyranitar.id }],
      reasoning: "Upgrade Tyranitar.",
    }),
    state,
    0,
  );
  assert.match(rejection(overBudget), /above the .* budget/);
  const beforeRejected = structuredClone(state);
  assert.throws(
    () => applyFreeAgency(state, 0, [{ drop: tyranitar.id, add: megaTyranitar.id }]),
    /above the .* budget/,
  );
  assert.deepEqual(state, beforeRejected, "a rejected list mutates nothing");

  const parsed = accepted(
    parseTradeDecision(
      JSON.stringify({
        swaps: [
          { drop: tyranitar.id, add: megaTyranitar.id },
          { drop: mrRime.id, add: absol.id },
        ],
        reasoning: "Trade depth for the Mega upgrade.",
      }),
      state,
      0,
    ),
  );
  const applied = applyFreeAgency(state, 0, parsed.swaps);
  assert.deepEqual(state, beforeRejected, "an accepted transition does not mutate its prior state");
  assert.equal(applied.rosters[0]!.length, BOARD.picks);
  assert.equal(applied.budgets[0], 0);
  assert.ok(applied.rosters[0]!.some((entry) => entry.id === megaTyranitar.id));
  assert.ok(applied.rosters[0]!.some((entry) => entry.id === absol.id));
  assert.ok(
    !applied.rosters[0]!.some((entry) => entry.id === tyranitar.id || entry.id === mrRime.id),
  );
});

test("coach trades validate both rosters and apply an accepted exchange atomically", () => {
  const state = {
    board: { ...BOARD, picks: 2 },
    models: ["test:a", "test:b"],
    teamNames: ["A", "B"],
    rosters: [
      [mon("charizard-mega-y"), mon("absol")],
      [mon("tyranitar"), mon("mr-rime")],
    ],
    budgets: [79, 83],
    memories: [emptyMemory(), emptyMemory()],
    standings: [],
    results: [[], []],
    reflections: [[], []],
    history: [],
    swapsAllowed: 6,
    swapsUsed: [0, 0],
  } satisfies TradeWindowState;
  const parsed = accepted(
    parseTradeOffer(
      JSON.stringify({
        offer: { to: 1, give: "charizard-mega-y", get: "tyranitar", message: "A direct exchange." },
        reasoning: "Private valuation.",
      }),
      state,
      0,
    ),
  );
  assert.match(
    rejection(
      parseTradeOffer(
        '{"offer":{"to":"1","give":"charizard-mega-y","get":"tyranitar","message":"A direct exchange."},"reasoning":"Private valuation.","notebook":"Plan around Tyranitar."}',
        state,
        0,
      ),
    ),
    /entrant index/,
  );
  assert.deepEqual(
    parseTradeOffer(
      '{"offer":{"to":1,"give":"charizard-mega-y (21)","get":"Tyranitar (17)","message":"As listed."}}',
      state,
      0,
    ),
    {
      offer: { to: 1, give: "charizard-mega-y", get: "tyranitar", message: "As listed." },
      reasoning: "",
    },
  );
  assert.match(
    rejection(
      parseTradeOffer(
        '{"offer":{"to":0,"give":"charizard-mega-y","get":"tyranitar","message":"Self."}}',
        state,
        0,
      ),
    ),
    /you are entrant 0/,
  );
  assert.deepEqual(parseTradeResponse('{"accept":true,"reasoning":"Worth it."}'), {
    accept: true,
    reasoning: "Worth it.",
  });
  assert.deepEqual(parseTradeResponse('{"accept":true}'), { accept: true, reasoning: "" });
  assert.deepEqual(parseTradeResponse('{"accept":false,"notebook":"ignored"}'), {
    accept: false,
    reasoning: "",
  });
  const offered = parsed.offer;
  assert.ok(offered, "a reply naming an offer parses to one");
  const before = structuredClone(state);
  assert.throws(
    () =>
      applyTradeOffer(state, {
        from: 0,
        to: 1,
        give: offered.give,
        get: "garchomp",
        accepted: true,
      }),
    /is not on test:b's current roster/,
  );
  assert.deepEqual(
    state,
    before,
    "a rejected offer leaves rosters, budgets, and notebooks untouched",
  );

  const applied = applyTradeOffer(state, {
    from: 0,
    to: offered.to,
    give: offered.give,
    get: offered.get,
    accepted: true,
  });
  assert.deepEqual(state, before, "an accepted offer does not mutate its prior state");
  assert.deepEqual(
    applied.rosters[0]!.map((entry) => entry.id),
    ["absol", "tyranitar"],
  );
  assert.deepEqual(
    applied.rosters[1]!.map((entry) => entry.id),
    ["mr-rime", "charizard-mega-y"],
  );
  assert.equal(applied.budgets[0], 85);
  assert.equal(applied.budgets[1], 77);
});

test("coach offers resolve before free agency and replay without model calls", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-coach-trades-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cheap: DraftBoardMon[] = [];
  const bases = new Set<string>();
  for (const candidate of BOARD.mons) {
    if (candidate.cost !== 1 || bases.has(candidate.base)) continue;
    bases.add(candidate.base);
    cheap.push(candidate);
    if (cheap.length === 20) break;
  }
  assert.equal(cheap.length, 20);
  const models = ["test:best", "test:worst"];
  const createState = (): TradeWindowState => ({
    board: BOARD,
    models,
    teamNames: ["Best", "Worst"],
    rosters: [cheap.slice(0, 10), cheap.slice(10, 20)],
    budgets: [90, 90],
    memories: [emptyMemory("best"), emptyMemory("worst")],
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    results: [[], []],
    reflections: [[], []],
    history: [],
    swapsAllowed: 6,
    swapsUsed: [0, 0],
  });
  const queues = new Map<string, string[]>([
    [
      models[1]!,
      [
        JSON.stringify({
          offer: { to: 0, give: cheap[10]!.id, get: cheap[0]!.id, message: "Swap role players?" },
          reasoning: "The exchange fits.",
          notebook: "Use the incoming role player.",
        }),
        JSON.stringify({
          offer: {
            to: 0,
            give: cheap[11]!.id,
            get: cheap[1]!.id,
            message: "A separate second offer?",
          },
        }),
        JSON.stringify({
          swaps: [],
          reasoning: "Done.",
          notebook: "Use the incoming role player.",
        }),
      ],
    ],
    [
      models[0]!,
      [
        JSON.stringify({
          accept: true,
          reasoning: "The exchange also fits us.",
          notebook: "Weighed the incoming offer.",
        }),
        JSON.stringify({ accept: false }),
        JSON.stringify({
          offer: null,
          reasoning: "No outbound offer.",
          notebook: "Keep the trade.",
        }),
        JSON.stringify({ swaps: [], reasoning: "Done.", notebook: "Keep the trade." }),
      ],
    ],
  ]);
  const prompts = new Map<string, string[]>();
  const systems: string[] = [];
  const liveState = createState();
  const artifact = await runTradeWindow(liveState, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 2,
    makeTradeProvider: (spec) => ({
      complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
        systems.push(system);
        const response = queues.get(spec)?.shift();
        assert.ok(response, `unexpected call for ${spec}`);
        const asked = prompts.get(spec) ?? [];
        asked.push(messages[messages.length - 1]?.content ?? "");
        prompts.set(spec, asked);
        return Promise.resolve({ text: response, usage: {}, toolCalls: [] });
      },
    }),
  });
  const answering = prompts.get(models[0]!)?.[0] ?? "";
  assert.equal(systems.length, 7);
  for (const system of systems) assertFormatAuthority(system);
  for (const evidence of ["best", models[0]!, models[1]!, cheap[10]!.id]) {
    assert.ok(answering.includes(evidence), `the counterparty answers without ${evidence}`);
  }
  assert.equal(artifact.offers.length, 3, "the proposer may make multiple independent offers");
  assert.equal(artifact.offers[0]!.accepted, true);
  assert.equal(artifact.offers[0]!.proposerFallback, false);
  assert.equal(artifact.offers[0]!.responderFallback, false);
  assert.equal(artifact.offers[1]!.accepted, false);
  assert.equal(artifact.offers[1]!.proposerFallback, false);
  assert.equal(artifact.offers[1]!.responderFallback, false);
  assert.equal(artifact.offers[2]!.to, null);
  assert.equal(artifact.offers[2]!.proposerFallback, false);
  assert.equal(artifact.offers[2]!.responderFallback, null);
  assert.deepEqual(
    artifact.rosters.map((roster) => roster.entrant),
    [0, 1],
  );
  assert.equal(artifact.rosters[0]!.roster.at(-1)?.id, cheap[10]!.id);
  assert.equal(artifact.rosters[1]!.roster.at(-1)?.id, cheap[0]!.id);
  assert.deepEqual(
    readJsonlObjects(path.join(directory, "window.jsonl")).map((row) => row.kind),
    ["offer", "offer", "offer", "free_agency", "free_agency"],
  );

  let replayCalls = 0;
  const replayState = createState();
  const replayed = await runTradeWindow(replayState, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 2,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        replayCalls += 1;
        throw new Error("replay must not call providers");
      },
    }),
  });
  assert.equal(replayCalls, 0);
  assert.deepEqual(replayed, artifact);
  assert.deepEqual(
    replayState,
    liveState,
    "ordered replay and live orchestration apply identical transitions",
  );
});

test("offer artifacts distinguish exhausted parsing from deliberate and random decisions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-trade-fallbacks-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = transactionState();
  state.models = ["test:responder", "test:proposer"];
  const offer = {
    offer: {
      to: 0,
      give: state.rosters[1]![0]!.id,
      get: state.rosters[0]![0]!.id,
      message: "One independent offer.",
    },
  };
  accepted(parseTradeOffer(JSON.stringify(offer), state, 1));
  const calls = new Map<string, number>();
  const artifact = await runTradeWindow(state, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 1,
    makeTradeProvider: (spec) => ({
      complete(): Promise<Completion> {
        const call = (calls.get(spec) ?? 0) + 1;
        calls.set(spec, call);
        if (spec === "test:proposer") {
          return Promise.resolve({
            text: JSON.stringify(call === 1 ? offer : { swaps: [] }),
            usage: {},
            toolCalls: [],
          });
        }
        return Promise.resolve({
          text: call <= 6 ? "not json" : JSON.stringify({ swaps: [] }),
          usage: {},
          toolCalls: [],
        });
      },
    }),
  });

  assert.deepEqual(
    artifact.offers.map(({ from, accepted, proposerFallback, responderFallback }) => ({
      from,
      accepted,
      proposerFallback,
      responderFallback,
    })),
    [
      { from: 1, accepted: false, proposerFallback: false, responderFallback: true },
      { from: 0, accepted: null, proposerFallback: true, responderFallback: null },
    ],
  );
  assert.equal(
    artifact.offers[0]!.responseReasoning,
    "",
    "fallback rejection invents no private rationale",
  );
  assert.equal(
    artifact.offers[1]!.offerReasoning,
    "",
    "fallback no-offer invents no private rationale",
  );
});

test("trade-offer caps are enforced by direct, fresh-league, and stored-resume ingress", async (t) => {
  const directDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-trade-cap-direct-"));
  const leagueDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-trade-cap-league-"));
  t.onTestFinished(() => fs.rmSync(directDir, { recursive: true, force: true }));
  t.onTestFinished(() => fs.rmSync(leagueDir, { recursive: true, force: true }));
  const invalid = MAX_TRADE_OFFERS + 1;
  await assert.rejects(
    runTradeWindow(transactionState(), {
      epochDir: directDir,
      psDir: defaultPsDir(),
      position: { afterWeek: 1, index: 0, count: 1 },
      tradesAllowed: invalid,
    }),
    /between 0 and 3/,
  );
  assert.throws(
    () =>
      readValidatedTradeWindow(directDir, transactionState(), {
        afterWeek: 1,
        tradesAllowed: invalid,
      }),
    /between 0 and 3/,
  );
  await assert.rejects(
    runDraftLeague(["random", "random"], leagueDir, {
      recordsPath: path.join(leagueDir, "results.jsonl"),
      seed: 7,
      transactions: [{ afterWeek: 1, tradesAllowed: invalid }],
    }),
    /between 0 and 3/,
  );

  await runDraftLeague(["random", "random"], leagueDir, {
    recordsPath: path.join(leagueDir, "results.jsonl"),
    seed: 7,
    draftOnly: true,
  });
  const configFile = path.join(leagueDir, "config.json");
  const config: JsonObject = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.draft_only = false;
  config.transactions = [{ after_week: 1, trades_allowed: invalid }];
  fs.writeFileSync(
    configFile,
    `${JSON.stringify(config)}
`,
  );
  await assert.rejects(
    runDraftLeague(["random", "random"], leagueDir, {
      recordsPath: path.join(leagueDir, "results.jsonl"),
      seed: 7,
      resume: true,
    }),
    /invalid transaction window/,
  );
});

test("the trade window runs lowest seed first and replays completed seats", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-trade-window-"));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cheap: DraftBoardMon[] = [];
  const bases = new Set<string>();
  for (const candidate of BOARD.mons) {
    if (candidate.cost !== 1 || bases.has(candidate.base)) continue;
    bases.add(candidate.base);
    cheap.push(candidate);
    if (cheap.length === 31) break;
  }
  assert.equal(cheap.length, 31);
  const initial = [cheap.slice(0, 10), cheap.slice(10, 20), cheap.slice(20, 30)];
  const freeAgent = cheap[30]!;
  const models = ["test:best", "test:middle", "test:worst"];
  const responses = new Map([
    [
      models[2]!,
      {
        swaps: [{ drop: initial[2]![0]!.id, add: freeAgent.id }],
        reasoning: "Use the first claim.",
        notebook: "Updated worst-seed plan.",
      },
    ],
    [
      models[1]!,
      {
        swaps: [{ drop: initial[1]![0]!.id, add: initial[2]![0]!.id }],
        reasoning: "Claim the newly released option.",
        notebook: "Updated middle-seed plan.",
      },
    ],
    [
      models[0]!,
      { swaps: [], reasoning: "The roster is sound.", notebook: "Keep the best-seed plan." },
    ],
  ]);
  const createState = (): TradeWindowState => ({
    board: BOARD,
    models,
    teamNames: ["Best", "Middle", "Worst"],
    rosters: initial.map((roster) => [...roster]),
    budgets: [90, 90, 90],
    memories: [emptyMemory("best plan"), emptyMemory("middle plan"), emptyMemory("worst plan")],
    standings: [
      { entrant: 0, w: 2, l: 0, gw: 4, gl: 0 },
      { entrant: 1, w: 1, l: 1, gw: 2, gl: 2 },
      { entrant: 2, w: 0, l: 2, gw: 0, gl: 4 },
    ],
    results: [[], [], []],
    reflections: [[], [], []],
    history: [],
    swapsAllowed: 6,
    swapsUsed: [0, 0, 0],
  });
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const firstState = createState();
  const artifact = await runTradeWindow(firstState, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 2, index: 0, count: 1 },
    tradesAllowed: 0,
    makeTradeProvider: (spec) => ({
      complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
        calls.push(spec);
        prompts.set(spec, `${system}\n${messages[0]?.content ?? ""}`);
        return Promise.resolve({
          text: JSON.stringify(responses.get(spec)),
          usage: {},
          toolCalls: [],
        });
      },
    }),
  });
  assert.deepEqual(artifact.order, [2, 1, 0]);
  assert.match(prompts.get(models[2]!) ?? "", /You are test:worst, manager of a franchise/);
  assertFormatAuthority(prompts.get(models[2]!) ?? "");
  assert.doesNotMatch(prompts.get(models[2]!) ?? "", /Best|Middle|Worst/);
  assert.deepEqual(calls, [models[2], models[1], models[0]]);
  assert.equal(
    firstState.rosters[1]![9]?.id,
    initial[2]![0]!.id,
    "an earlier drop becomes available immediately",
  );
  assert.ok(fs.existsSync(path.join(directory, "window.json")));
  assert.equal(readJsonlObjects(path.join(directory, "window.jsonl")).length, 3);

  let replayCalls = 0;
  const replayed = await runTradeWindow(createState(), {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 2, index: 0, count: 1 },
    tradesAllowed: 0,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        replayCalls += 1;
        throw new Error("replayed decisions must not call a provider");
      },
    }),
  });
  assert.equal(replayCalls, 0);
  assert.deepEqual(replayed.decisions, artifact.decisions);
});

test("legal picks enforce exclusivity and one entry per base species", () => {
  const state = freshState();
  const zardY = mon("charizard-mega-y");
  state.taken.set(zardY.id, 0);
  state.rosters[0] = [zardY];
  state.budgets[0] = BOARD.budget - zardY.cost;

  const legalIds = new Set(legalPicks(state, 0).map((entry) => entry.id));
  assert.ok(!legalIds.has("charizard-mega-y"), "a taken entry is gone");
  assert.ok(!legalIds.has("charizard"), "the base forme shares a species with the drafted mega");
  assert.ok(!legalIds.has("charizard-mega-x"), "the other mega shares that species too");
  assert.ok(legalIds.has("garchomp"));

  const rival = legalPicks(state, 1).map((entry) => entry.id);
  assert.ok(!rival.includes("charizard-mega-y"), "exclusivity applies across rosters");
  assert.ok(rival.includes("charizard"), "but a rival may still take the base forme");
});

test("a pick must leave enough budget to finish the roster", () => {
  const state = freshState();
  state.budgets[0] = 25;
  const legal = legalPicks(state, 0);
  const cheapestNine = [...new Set(BOARD.mons.map((entry) => entry.base))]
    .map((base) =>
      Math.min(...BOARD.mons.filter((entry) => entry.base === base).map((entry) => entry.cost)),
    )
    .sort((a, b) => a - b)
    .slice(0, BOARD.picks - 1)
    .reduce((sum, cost) => sum + cost, 0);
  assert.ok(legal.length > 0);
  for (const entry of legal)
    assert.ok(entry.cost <= 25 - cheapestNine, `${entry.id} leaves the roster unfinishable`);
  assert.equal(maxAffordable(legal), Math.max(...legal.map((entry) => entry.cost)));
});

test("the last pick may spend everything that is left", () => {
  const state = freshState();
  const roster = BOARD.mons.filter((entry) => entry.cost === 1).slice(0, BOARD.picks - 1);
  state.rosters[0] = roster;
  for (const entry of roster) state.taken.set(entry.id, 0);
  state.budgets[0] = 20;
  const legal = legalPicks(state, 0);
  assert.ok(
    legal.some((entry) => entry.cost === 20),
    "with one slot left the whole remaining budget is spendable",
  );
  assert.ok(legal.every((entry) => entry.cost <= 20));
});
