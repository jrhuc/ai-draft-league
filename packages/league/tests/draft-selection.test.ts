import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { createBoardSearch } from "../src/board-search.js";
import type { AgentRunner } from "../src/agent-runtime.js";
import { legalPicks, parseFranchiseName, parsePick, runDraft } from "../src/draft.js";
import { defaultPsDir } from "../src/paths.js";
import { seededRng } from "../src/random.js";
import { readRunArtifacts } from "../src/run-artifact-store.js";
import { agentReply } from "./agent-test-helpers.js";
import { assertFormatAuthority, BOARD, freshState, mon } from "./draft-test-helpers.js";

test("drafts resume from committed picks, keep notebooks, and name franchises after drafting", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-draft-"));
  t.onTestFinished(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const models = ["test:one", "test:two"];
  const board = { ...BOARD, picks: 2 };
  const queues = new Map([
    [models[0]!, ["garchomp", "incineroar"]],
    [models[1]!, ["sinistcha", "farigiraf"]],
  ]);
  let calls = 0;
  const runAgent: AgentRunner = async (task) => {
    calls += 1;
    assertFormatAuthority(task.system);
    assert.equal(task.reasoning, "high");
    if (task.submission.name === "submit_name") {
      assert.equal(readRunArtifacts(logDir, "draft-pick").length, 4);
      return agentReply(task, { team_name: `Franchise ${task.model}` });
    }
    assert.throws(() => task.validate({ pick: "not-a-mon" }), /board id/);
    const pick = queues.get(task.model)!.shift()!;
    assert.throws(() => task.validate({ pick, plan: "x".repeat(10000) }), /plan/);
    const search = task.tools?.find((tool) => tool.definition.name === "search_board");
    assert.ok(search);
    const dragons = search.run({ types: ["Dragon"] });
    assert.match(dragons, /legal picks/);
    if (pick === "garchomp") assert.match(dragons, /^- garchomp \|/m);
    else assert.doesNotMatch(dragons, /^- garchomp \|/m);
    if (pick === "incineroar") assert.doesNotMatch(dragons, /^- garchomp-mega \|/m);
    if (["incineroar", "farigiraf"].includes(pick)) assert.match(task.prompt, /Private plan/);
    return agentReply(task, { pick, plan: pick === "incineroar" ? "" : "Private plan" });
  };
  const options = { runDir: logDir, logDir, rng: seededRng(1), runAgent, reasoning: "high" };
  await assert.rejects(
    runDraft(models, board, {
      ...options,
      onPick: (pick) => {
        if (pick.pick === 1) throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );
  assert.equal(calls, 1);
  const outcome = await runDraft(models, board, options);
  assert.equal(calls, 6);
  assert.equal(outcome.notebooks[0], "");
  assert.deepEqual(
    outcome.rosters.map((roster) => roster.map((entry) => entry.id)),
    [
      ["garchomp", "incineroar"],
      ["sinistcha", "farigiraf"],
    ],
  );
  assert.deepEqual(
    await runDraft(models, board, {
      ...options,
      runAgent: async () => {
        throw new Error("already completed");
      },
    }),
    outcome,
  );
});

test("draft search reserves completion budget and keeps an opponent's base and Mega entries independent", () => {
  const state = freshState({
    taken: new Map([
      ["garchomp", 0],
      ["sableye", 1],
    ]),
    rosters: [[mon("garchomp")], [mon("sableye")]],
    budgets: [18, 89],
  });
  const search = createBoardSearch(BOARD, defaultPsDir(), legalPicks(state, 0));
  const result = search.run({ types: ["Dark", "Ghost"] });
  assert.doesNotMatch(result, /^- sableye \|/m);
  assert.match(result, /^- sableye-mega .*Prankster.*Magic Bounce/m);
  assert.doesNotMatch(search.run({ types: ["Dragon"] }), /^- garchomp-mega \|/m);
  assert.doesNotMatch(search.run({ types: ["Fire"] }), /^- charizard-mega-x \|/m);
  assert.match(
    search.run({ types: ["Fire"], include_unavailable: true }),
    /^- charizard-mega-x \|/m,
  );
  assert.match(
    search.run({ types: ["Dark", "Ghost"], include_unavailable: true }),
    /^- sableye \|/m,
  );
  assert.match(createBoardSearch(BOARD, defaultPsDir(), []).run({}), /No board entries match/);
});

test("a rejected pick identifies price, ownership, and species conflicts", () => {
  const state = freshState();
  const zard = mon("charizard-mega-y");
  state.taken.set(zard.id, 1);
  state.rosters[1] = [zard];
  state.taken.set("garchomp", 0);
  state.rosters[0] = [mon("garchomp")];
  const pick = (id: string) => () =>
    parsePick({ pick: id }, legalPicks(state, 0), state, 0, ["fake:model", "fake:rival"]);
  assert.throws(pick("nonsense"), /not a board id/);
  assert.throws(pick(zard.id), /already drafted by fake:rival/);
  assert.throws(pick("garchomp-mega"), /shares the species Garchomp/);
  state.budgets[0] = 12;
  assert.throws(pick("basculegion"), /costs 19, but you can spend at most/);
});

test("optional evidence and displayed names are accepted while names normalize separately", () => {
  const state = freshState();
  for (const spelling of ["lucario-mega", "Mega Lucario", "mega-lucario", "MEGA LUCARIO"]) {
    const parsed = parsePick({ pick: spelling }, legalPicks(state, 0), state, 0);
    assert.equal(parsed.mon.id, "lucario-mega");
    assert.deepEqual(parsed.evidence.supplied, { rationale: false, notebookUpdate: false });
  }
  assert.deepEqual(parseFranchiseName({ team_name: "  Prankster  Paradise  " }), {
    teamName: "Prankster Paradise",
  });
  assert.throws(() => parseFranchiseName({ team_name: "" }), /non-empty/);
  assert.throws(() => parseFranchiseName({ team_name: "x".repeat(61) }), /at most 60/);
});
