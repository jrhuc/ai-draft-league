import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { seededRng } from "../src/random.js";
import { readRunArtifacts } from "../src/run-artifact-store.js";
import { loadShowdown } from "../src/showdown.js";
import {
  decodeTeamBuildJournalRow,
  replayTeamBuildArtifact,
  runTeambuild,
} from "../src/teambuild.js";
import { buildBriefing } from "../src/build-briefing.js";
import { LLMEngine } from "../src/llm-engine.js";
import { acceptedAct, request } from "./engine-test-helpers.js";
import { agentReply, scriptedAgent } from "./agent-test-helpers.js";
import type { JsonObject } from "../src/types.js";
import {
  assertFormatAuthority,
  mon,
  TEAMBUILD_ROSTER,
  teambuildRequest,
} from "./draft-test-helpers.js";
import { legalTeamReply } from "./fixtures/team-build.js";

type Team = JsonObject & {
  team_plan: string;
  sets: Array<JsonObject & { note?: string; moves: string[] }>;
};

const goodTeam = (): Team =>
  legalTeamReply("Rain beats their sun core, so Pelipper leads with Charizard held back.");

test("Showdown rejects illegal sets and the model resubmits before a team is stored", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-teambuild-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const good = goodTeam();
  good.sets[0]!.note = "Fast Ground pressure";
  const illegal = structuredClone(good);
  illegal.sets[0]!.moves = ["Bounce"];
  const script = scriptedAgent([illegal, good]);
  const result = await runTeambuild(teambuildRequest(), {
    runDir: logDir,
    logDir,
    rng: seededRng(1),
    runAgent: script.run,
  });
  assert.equal(script.rejections.length, 1);
  assert.match(script.rejections[0]!, /Bounce/);
  assert.equal(result.artifact.attempts, 2);
  assert.equal(result.view.attempts, 2);
  assert.deepEqual(result.view.sets[0]!.moves, good.sets[0]!.moves);
  assert.equal(result.view.sets[0]!.note, "Fast Ground pressure");
  assert.match(result.packed, /Charizard\|/);
  assert.match(result.packed, /CharizarditeY/);
  assert.match(result.packed, /LifeOrb/);
  const { Teams } = loadShowdown();
  assert.equal(Teams.unpack(result.packed)?.length, 6);
  const stored = readRunArtifacts(logDir, "teambuild");
  assert.equal(stored.length, 1);
  const { artifact } = decodeTeamBuildJournalRow(stored[0]!.value);
  assert.equal(replayTeamBuildArtifact(artifact).packed, result.packed);
});

test("random builds pass the same referee and replay as model builds", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-random-build-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const result = await runTeambuild(teambuildRequest({ model: "random" }), {
    runDir: logDir,
    logDir,
    rng: seededRng(1),
    runAgent: () => {
      throw new Error("random builds do not use a provider");
    },
  });
  assert.equal(result.artifact.attempts, 0);
  assert.equal(replayTeamBuildArtifact(result.artifact).packed, result.packed);
});

test("build plans and set notes reach pilots independently of notebook updates", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-briefing-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const team = goodTeam();
  team.team_plan = "MODEL_TEAM_PLAN";
  team.sets[0]!.note = "SET_NOTE";
  team.sets[0]!.moves = team.sets[0]!.moves.slice(0, 3);
  const memory = {
    notebook: "Franchise notebook",
    scouting: "Full private scouting\nLater details",
  };
  const built = await runTeambuild(teambuildRequest({ memory }), {
    runDir: logDir,
    logDir,
    rng: seededRng(1),
    runAgent: scriptedAgent([team]).run,
  });
  assert.equal(built.view.sets[0]!.moves.length, 3);
  memory.scouting = "Changed after build";
  const briefing = buildBriefing(built.view, built.artifact.task.notebook);
  assert.doesNotMatch(briefing, /"evs"|"moves"|"item"|"ability"/);
  const script = scriptedAgent([
    { choices: [0], notebook: { team_playbook: "Pilot revision" } },
    { choices: [0] },
  ]);
  const engine = new LLMEngine("p1", "scripted", { runAgent: script.run, briefing });
  assert.equal(engine.coachingNote(), "");
  await acceptedAct(engine, request(), { povLines: [] });
  await acceptedAct(engine, request(), { povLines: [] });
  for (const task of script.calls) {
    assert.match(task.system, /MODEL_TEAM_PLAN/);
    assert.match(task.system, /SET_NOTE/);
    assert.match(task.system, /Full private scouting\nLater details/);
    assert.doesNotMatch(task.system, /Changed after build/);
  }
  assert.equal(engine.coachingNote(), "Pilot revision");
});

test("builders receive private franchise memory, matchup history, and authoritative Champions data", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-build-context-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  for (const sheetPolicy of ["open", "closed"] as const) {
    await runTeambuild(
      teambuildRequest({
        roster: [...TEAMBUILD_ROSTER, mon("annihilape")],
        sheetPolicy,
        playoffContext: ["Week 1: beat fake:rival 2-0"],
      }),
      {
        logDir,
        runDir: path.join(logDir, sheetPolicy),
        rng: seededRng(1),
        runAgent: async (task) => {
          const prompt = `${task.system}\n${task.prompt}`;
          assertFormatAuthority(prompt);
          assert.match(prompt, new RegExp(`team sheets are ${sheetPolicy}`));
          assert.match(prompt, /Flexible Ground offense/);
          assert.match(prompt, /Week 1: beat fake:rival 2-0/);
          assert.match(prompt, /MUST hold Charizardite Y/);
          assert.match(prompt, /Blaze or Solar Power, NOT its Mega ability/);
          assert.match(prompt, /cannot hold a Mega Stone/);
          assert.doesNotMatch(
            prompt,
            /Test Tauros|Rival Rotoms|Final Gambit|Assault Vest|Safety Goggles|Booster Energy|Eviolite/,
          );
          assert.doesNotMatch(
            prompt.split("- incineroar |")[1]!.split("- sinistcha |")[0]!,
            /Knock Off/,
          );
          for (const item of [
            "Leftovers",
            "Life Orb",
            "Focus Sash",
            "Light Clay",
            "Rocky Helmet",
            "Air Balloon",
            "Eject Button",
            "Grassy Seed",
            "Psychic Seed",
            "Terrain Extender",
            "Leek",
          ])
            assert.ok(task.system.includes(item));
          assert.ok(task.tools?.some((tool) => tool.definition.name === "read_memory_page"));
          return agentReply(task, goodTeam());
        },
      },
    );
  }
});

test("failed model builds propagate without substituting a random team", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-build-failure-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  await assert.rejects(
    runTeambuild(teambuildRequest(), {
      runDir: logDir,
      logDir,
      rng: seededRng(1),
      runAgent: scriptedAgent([new Error("no submission")]).run,
    }),
    /no submission/,
  );
  assert.equal(readRunArtifacts(logDir, "teambuild").length, 0);
});
