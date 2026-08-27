import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { readJsonlObjects } from "../src/jsonl.js";
import { seededRng } from "../src/random.js";
import { loadShowdown } from "../src/showdown.js";
import { runTeambuild } from "../src/teambuild.js";
import type { Completion, JsonObject } from "../src/types.js";
import { asRecord, text } from "../src/value.js";
import {
  assertFormatAuthority,
  GOOD_TEAM,
  mon,
  scriptedProvider,
  TEAMBUILD_ROSTER,
  teambuildRequest,
} from "./draft-test-helpers.js";

test("malformed set shapes and EV values are compliance rejections before a canonical noted team", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-compliance-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const malformed: { sets: unknown[] } = JSON.parse(GOOD_TEAM);
  malformed.sets[0] = null;
  const stringEv: { sets: Array<{ evs: JsonObject }> } = JSON.parse(GOOD_TEAM);
  stringEv.sets[0]!.evs.hp = "2";
  const floatEv: { sets: Array<{ evs: JsonObject }> } = JSON.parse(GOOD_TEAM);
  floatEv.sets[0]!.evs.atk = 1.5;
  const negativeEv: { sets: Array<{ evs: JsonObject }> } = JSON.parse(GOOD_TEAM);
  negativeEv.sets[0]!.evs.def = -1;
  const noted: { sets: Array<JsonObject> } = JSON.parse(GOOD_TEAM);
  noted.sets[0]!.note = "Fast Ground pressure and spread damage.";

  const result = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(19),
    makeTeambuildProvider: () =>
      scriptedProvider([
        JSON.stringify(malformed),
        JSON.stringify(stringEv),
        JSON.stringify(floatEv),
        JSON.stringify(negativeEv),
        JSON.stringify(noted),
      ]),
  });

  assert.equal(result.view.attempts, 5);
  assert.equal(result.view.sets[0]!.note, "Fast Ground pressure and spread damage.");
  assert.ok(result.view.sets.every((set) => !set.repaired));
  assert.equal(result.artifact.validation.repaired, false);
  assert.equal(result.artifact.action?.sets[0]?.note, "Fast Ground pressure and spread damage.");
  const attempts = readJsonlObjects(path.join(logDir, "series-1-e0-fake-model.jsonl"));
  assert.equal(attempts.length, 5);
  assert.match(text(attempts[0]!.error), /set 1 must be an object/);
  for (const attempt of attempts.slice(1, 4)) {
    assert.match(text(attempt.error), /finite, safe, non-negative integer/);
  }
  const stored = readJsonlObjects(path.join(logDir, "teambuild.jsonl"))[0]!;
  const artifact = asRecord(stored.artifact);
  const action = asRecord(artifact.action);
  assert.equal(action.packed, result.packed);
  assert.deepEqual(Object.keys(stored), ["artifact"]);
});

test("a legal teambuild is accepted as written and packs the base forme", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const { view, packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => scriptedProvider([GOOD_TEAM]),
  });

  assert.equal(view.attempts, 1);
  assert.equal(view.brought.length, 6);
  assert.ok(
    view.sets.every((set) => !set.repaired),
    `no set should need repair: ${JSON.stringify(view.sets)}`,
  );
  assert.match(view.rationale, /Rain beats their sun core/);
  assert.ok(packed.includes("Charizard|"), "the mega registers as its base forme");
  assert.ok(packed.includes("CharizarditeY"), "holding its stone");

  const { Teams } = loadShowdown();
  assert.equal((Teams.unpack(packed) ?? []).length, 6);
});

test("canonical packing delegates punctuation handling to Showdown Teams.pack", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-showdown-pack-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const team: { sets: Array<{ moves: string[] }> } = JSON.parse(GOOD_TEAM);
  const { packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(21),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(team)]),
  });

  assert.match(packed, /LifeOrb/);
  assert.doesNotMatch(packed, /Life Orb/);
});

test("an accepted teambuild preserves fewer than four legal moves", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-three-moves-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const team: { sets: Array<{ moves: string[] }> } = JSON.parse(GOOD_TEAM);
  team.sets[0]!.moves = team.sets[0]!.moves.slice(0, 3);
  const { view } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(team)]),
  });
  assert.deepEqual(view.sets[0]!.moves, team.sets[0]!.moves);
  assert.equal(view.sets[0]!.repaired, false);
});

test("the teambuild prompt uses coach identities and never franchise names", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-prompt-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let prompt = "";
  await runTeambuild(
    teambuildRequest({ stage: "playoff", playoffContext: ["Week 1: beat fake:rival 2-0"] }),
    {
      logDir,
      rng: seededRng(1),
      makeTeambuildProvider: () => ({
        complete(system, messages): Promise<Completion> {
          prompt = `${system}\n${messages[0]!.content ?? ""}`;
          return Promise.resolve({ text: GOOD_TEAM, usage: {}, toolCalls: [] });
        },
      }),
    },
  );
  assert.match(
    prompt,
    /team sheets are open/,
    "the prompt states the configured open-sheet policy",
  );
  assertFormatAuthority(prompt);
  assert.ok(prompt.includes("YOUR ROSTER"), "the model sees its roster");
  assert.ok(prompt.includes("fake:rival"), "and which coach it is playing");
  assert.doesNotMatch(prompt, /Test Tauros|Rival Rotoms/);
  assert.ok(prompt.includes("Flexible Ground offense"), "and its final private draft note");
  assert.ok(
    prompt.includes("Week 1: beat fake:rival 2-0"),
    "playoff builders receive earlier match context",
  );
  assert.ok(prompt.includes("MUST hold Charizardite Y"), "the mega lock is stated");
  assert.match(
    prompt,
    /set "ability" to one of Blaze or Solar Power, NOT its Mega ability/,
    "a Mega entry registers its pre-Mega ability, which models otherwise get wrong",
  );
  assert.ok(prompt.includes("cannot hold a Mega Stone"), "and so is its inverse");
  assert.ok(
    !/moves:.*\bBounce\b/.test(prompt),
    "the movepool must not offer moves the validator rejects",
  );
});

test("closed-sheet teambuilding states and binds the hidden-information policy", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-closed-sheets-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let system = "";
  const result = await runTeambuild(teambuildRequest({ sheetPolicy: "closed" }), {
    logDir,
    rng: seededRng(20),
    makeTeambuildProvider: () => ({
      complete(prompt): Promise<Completion> {
        system = prompt;
        return Promise.resolve({ text: GOOD_TEAM, usage: {}, toolCalls: [] });
      },
    }),
  });

  assert.match(system, /team sheets are closed/);
  assert.doesNotMatch(system, /team sheets are open/);
  assert.equal(result.artifact.task.sheetPolicy, "closed");
});

test("round-robin teambuilds receive the coach’s season so far and the rebuild notice", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-season-context-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let prompt = "";
  await runTeambuild(
    teambuildRequest({
      playoffContext: ["Round-robin week 1: beat fake:other 2-1; registered Garchomp"],
    }),
    {
      logDir,
      rng: seededRng(1),
      makeTeambuildProvider: () =>
        scriptedProvider([GOOD_TEAM], (messages) => {
          prompt = messages[0]!.content ?? "";
        }),
    },
  );
  assert.match(
    prompt,
    /YOUR SEASON SO FAR[^\n]*\n- Round-robin week 1: beat fake:other 2-1; registered Garchomp/,
  );
  assert.match(prompt, /Every coach builds a new six for every matchup/);
  let blank = "";
  await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(2),
    makeTeambuildProvider: () =>
      scriptedProvider([GOOD_TEAM], (messages) => {
        blank = messages[0]!.content ?? "";
      }),
  });
  assert.doesNotMatch(blank, /YOUR SEASON SO FAR/, "a first build has no season to show");
});

test("the system prompt lists the Champions item list, which Gen 9 knowledge gets wrong", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-items-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let system = "";
  await runTeambuild(teambuildRequest({ roster: [...TEAMBUILD_ROSTER, mon("annihilape")] }), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => ({
      complete(prompt): Promise<Completion> {
        system = prompt;
        return Promise.resolve({ text: GOOD_TEAM, usage: { total_tokens: 10 }, toolCalls: [] });
      },
    }),
  });

  for (const item of ["Leftovers", "Life Orb", "Focus Sash", "Light Clay"]) {
    assert.ok(system.includes(item), `${item} is legal here and must be offered`);
  }
  for (const absent of [
    "Assault Vest",
    "Rocky Helmet",
    "Safety Goggles",
    "Booster Energy",
    "Eviolite",
  ]) {
    assert.ok(
      !system.includes(absent),
      `${absent} does not exist in Champions and must not be offered`,
    );
  }
  assert.ok(
    !system.includes("Charizardite"),
    "Mega Stones are locked or banned per entry, never a free choice",
  );
  assert.ok(
    !system.includes("Final Gambit"),
    "Annihilape does not learn Final Gambit in Champions",
  );
  assert.ok(!system.includes("Knock Off"), "Incineroar does not learn Knock Off in Champions");
});

test("an illegal team is rejected with Showdown’s own errors, then repaired", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-repair-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const broken: { sets: Array<JsonObject> } = JSON.parse(GOOD_TEAM);
  broken.sets[0]!.moves = ["Earthquake", "Bounce", "Rock Slide", "Protect"];
  broken.sets[0]!.evs = { hp: 60, atk: 60, def: 60, spa: 60, spd: 60, spe: 60 };
  broken.sets[5]!.item = "Leftovers";

  const { view, packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(9),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(broken)]),
  });

  assert.equal(view.attempts, 5, "the model gets its retries before anything is repaired");
  const zard = view.sets.find((set) => set.species.includes("Charizard"))!;
  assert.equal(zard.item, "Charizardite Y", "the mega lock is restored");
  assert.ok(zard.repairs.some((repair) => repair.includes("locked to")));
  const chomp = view.sets.find((set) => set.species === "Garchomp")!;
  assert.ok(!chomp.moves.includes("Bounce"), "the illegal move is dropped");
  assert.ok(chomp.repairs.some((repair) => repair.includes("Bounce")));
  assert.ok(
    Object.values(chomp.evs).reduce((sum, value) => sum + value, 0) <= 66,
    "EVs are brought inside the Champions budget",
  );

  const errors = fs
    .readFileSync(path.join(logDir, "series-1-e0-fake-model.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): JsonObject => JSON.parse(line));
  assert.match(text(errors[0]!.error), /Bounce|Stat Points|Charizardite/);

  const { Teams } = loadShowdown();
  assert.equal((Teams.unpack(packed) ?? []).length, 6, "the repaired team still packs");
});

test("a team that survives repair still illegal is rebuilt rather than aborting the league", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-rebuild-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const broken: { sets: Array<JsonObject> } = JSON.parse(GOOD_TEAM);
  for (const set of broken.sets) {
    set.moves = [];
    set.evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    set.nature = "Serious";
  }

  const { view, packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(4),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(broken)]),
  });

  const { Teams } = loadShowdown();
  const unpacked = Teams.unpack(packed) ?? [];
  assert.equal(unpacked.length, 6);
  for (const set of unpacked)
    assert.ok((set.moves ?? []).length > 0, `${set.species} must end with moves`);
  assert.ok(
    view.sets.every((set) => set.repaired),
    "every set needed repair here",
  );
});
