import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { botTeamSets } from "../src/bot.js";
import { runDraft } from "../src/draft.js";
import { defaultPsDir } from "../src/paths.js";
import { seededRng } from "../src/random.js";
import { runTeambuild } from "../src/teambuild.js";
import { BOARD as board, teambuildRequest } from "./draft-test-helpers.js";

test("the bot holds a legal set for every board entry", () => {
  for (const mon of board.mons) {
    const [set] = botTeamSets([mon], 1, board.format, defaultPsDir());
    assert.ok(set && set.moves.length > 0, mon.id);
  }
});

test("bots draft their budget into six core picks and build legal sixes", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-bot-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const models = ["bot", "bot", "bot", "random"];
  const outcome = await runDraft(models, board, {
    runDir,
    logDir: runDir,
    rng: seededRng(5),
    runAgent: () => {
      throw new Error("fixed policies call no model");
    },
  });
  const core = (index: number) =>
    outcome.rosters[index]!.map((mon) => mon.cost)
      .sort((a, b) => b - a)
      .slice(0, 6)
      .reduce((sum, cost) => sum + cost, 0);
  for (const index of [0, 1, 2]) {
    assert.equal(outcome.rosters[index]!.length, board.picks);
    assert.ok(outcome.budgets[index]! <= 5, `bot ${index} left ${outcome.budgets[index]}`);
    assert.ok(core(index) > core(3), `bot ${index} core ${core(index)} vs random ${core(3)}`);
    assert.match(outcome.teamNames[index]!, /^Bot Coach /);
  }
  for (const index of [0, 1, 2]) {
    const result = await runTeambuild(
      {
        ...teambuildRequest({ model: "bot", seriesIndex: index }),
        roster: outcome.rosters[index]!,
      },
      {
        runDir,
        logDir: runDir,
        rng: seededRng(index),
        runAgent: () => Promise.reject(new Error("fixed policies call no model")),
      },
    );
    assert.equal(result.view.brought.length, 6);
    assert.equal(result.artifact.attempts, 0);
  }
});
