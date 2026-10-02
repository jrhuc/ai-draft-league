import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import type { GameSummary } from "../src/game-usage.js";
import { defaultPsDir } from "../src/paths.js";
import { renderRosterUsage, ROSTER_USAGE_HEADING, rosterUsage } from "../src/roster-usage.js";
import { runTradeWindow } from "../src/trade-window.js";
import type { TeamBuildView } from "../src/views.js";
import { scriptedAgent } from "./agent-test-helpers.js";
import { transactionState } from "./draft-test-helpers.js";

const game = (brought: [string[], string[]]): GameSummary => ({
  brought,
  fielded: brought,
  megaEvolved: [null, null],
  faints: [{}, {}],
});

const build = (seriesIndex: number, entrant: number, brought: string[]): TeamBuildView => ({
  seriesIndex,
  entrant,
  opponent: 0,
  brought,
  sets: [],
  rationale: "",
  attempts: 1,
});

test("roster usage records each week as a fact, not a rate", () => {
  const plans = [
    { index: 0, week: 1, entrants: [0, 1] as const },
    { index: 1, week: 2, entrants: [2, 0] as const },
    { index: 2, week: 3, entrants: [0, 3] as const },
  ];
  const entries = rosterUsage({
    rosters: [["scrafty-mega", "garchomp", "signed-late"]],
    plans,
    builds: [
      build(0, 0, ["garchomp"]),
      build(1, 0, ["garchomp", "scrafty-mega"]),
      build(2, 0, ["garchomp"]),
    ],
    games: new Map([
      [0, [game([["garchomp"], []]), game([["garchomp"], []])]],
      [1, [game([[], ["scrafty-mega", "garchomp"]]), game([[], ["garchomp"]])]],
      [2, [game([["garchomp"], []])]],
    ]),
    throughWeek: 3,
    owned: (_entrant, week, monId) => monId !== "signed-late" || week === 3,
  });
  assert.deepEqual(
    renderRosterUsage(entries, (entrant) => `entrant ${entrant}`),
    [
      "- entrant 0 | scrafty-mega: week 1 vs entrant 1: not registered; week 2 vs entrant 2: registered, brought game 1; week 3 vs entrant 3: not registered",
      "- entrant 0 | garchomp: week 1 vs entrant 1: registered, brought games 1,2; week 2 vs entrant 2: registered, brought games 1,2; week 3 vs entrant 3: registered, brought game 1",
      "- entrant 0 | signed-late: week 1 vs entrant 1: not on roster; week 2 vs entrant 2: not on roster; week 3 vs entrant 3: not registered",
    ],
  );
});

test("the free-agency prompt carries past results, roster usage and the remaining schedule", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-free-agency-prompt-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const state = transactionState(2);
  state.models = ["fake:coach", "random"];
  state.afterWeek = 1;
  state.results[0] = [
    {
      entrant: 0,
      opponent: 1,
      week: 1,
      score: [2, 0],
      result: "won",
      opponentRoster: "their-week-one-roster (1)",
    },
  ];
  state.schedule = [
    { index: 0, week: 1, entrants: [0, 1] },
    { index: 1, week: 2, entrants: [1, 0] },
  ];
  state.usage = rosterUsage({
    rosters: state.rosters.map((roster) => roster.map((mon) => mon.id)),
    plans: state.schedule,
    builds: [build(0, 0, [state.rosters[0]![0]!.id]), build(0, 1, [])],
    games: new Map([[0, [game([[state.rosters[0]![0]!.id], []])]]]),
    throughWeek: 1,
  });
  const script = scriptedAgent([{ swaps: [] }]);
  await runTradeWindow(state, {
    runDir,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 0,
    runAgent: script.run,
  });
  assert.equal(script.calls.length, 1);
  const { prompt } = script.calls[0]!;
  assert.ok(
    prompt.includes(
      "- Week 1: won random 2-0; opposing roster that week: their-week-one-roster (1)\n",
    ),
  );
  assert.ok(prompt.includes(ROSTER_USAGE_HEADING));
  assert.match(
    prompt,
    new RegExp(
      `- entrant 0 \\| fake:coach \\| ${state.rosters[0]![0]!.id}: week 1 vs entrant 1: registered, brought game 1`,
    ),
  );
  assert.match(prompt, /YOUR REMAINING SCHEDULE[^\n]*\n- Week 2 \| random \| /);
  assert.doesNotMatch(prompt, /\n- Week 1 \| random/);
});
