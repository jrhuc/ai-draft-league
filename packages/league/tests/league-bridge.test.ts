import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { botTeamSets } from "../src/bot.js";
import { type DraftBoardMon, draftTranscriptRowSchema } from "../src/draft.js";
import { defaultPsDir } from "../src/paths.js";
import { finalPlacement, LeagueBridge, type LeagueEvent } from "../src/league-bridge.js";
import { readRunArtifacts } from "../src/run-artifact-store.js";
import type { JsonObject } from "../src/types.js";
import { BOARD } from "./draft-test-helpers.js";

function roster(runDir: string, entrant: number): DraftBoardMon[] {
  return readRunArtifacts(runDir, "draft-pick")
    .map(({ value }) => draftTranscriptRowSchema.parse(value))
    .filter((row) => row.entrant === entrant)
    .map((row) => BOARD.mons.find((mon) => mon.id === row.mon)!);
}

test("an outside seat plays a whole league over the bridge", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-league-bridge-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const tasks = new Map<string, number>();
  const { promise: ended, resolve } = Promise.withResolvers<void>();
  const bridge: LeagueBridge = new LeagueBridge((event: LeagueEvent) => {
    if (event.kind === "end") resolve();
    if (event.kind === "exchange") setImmediate(() => answer(event));
  });
  const answer = ({ exchange, entrant }: Extract<LeagueEvent, { kind: "exchange" }>) => {
    const tool = exchange.submission.name;
    tasks.set(tool, (tasks.get(tool) ?? 0) + 1);
    if (tool === "submit_action") {
      bridge.runner.abandon(exchange.id, "the probe plays the default");
      return;
    }
    const answers: JsonObject[] = [];
    if (tool === "submit_pick") {
      const listed = bridge.runner.tool(exchange.id, "search_board", {});
      answers.push({ pick: /^- ([a-z0-9-]+) \|/m.exec(listed)![1]! });
    }
    if (tool === "submit_team")
      answers.push({
        sets: botTeamSets(roster(runDir, entrant), 6, BOARD.format, defaultPsDir()),
        team_plan: "Probe",
      });
    answers.push(
      { team_name: "Probe Franchise" },
      { summary: "Fine.", did_well: "Fine.", did_poorly: "Fine.", would_change: "Nothing." },
      { summary: "Fine." },
      { offer: null },
      { accept: false },
      { swaps: [] },
      {},
    );
    const accepted = answers.some((input) => {
      try {
        bridge.runner.submit(exchange.id, input, { response: "probe" });
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(accepted, `no probe answer fits ${tool} in ${exchange.task}`);
  };
  assert.throws(
    () => bridge.start({ seats: ["external:a", "external:a"], seed: 1, run_dir: runDir }),
    /distinct/,
  );
  assert.throws(
    () => bridge.start({ seats: ["model", "bot"], seed: 1, run_dir: runDir }),
    /bot, random, or external/,
  );
  bridge.start({ seats: ["external:probe", "random"], seed: 3, run_dir: runDir });
  await ended;
  const outcome = bridge.result();
  assert.equal(outcome.error, null);
  const probe = outcome.entrants.indexOf("external:probe");
  assert.equal(outcome.team_names[probe], "Probe Franchise");
  assert.deepEqual(
    outcome.series.map((series) => series.stage),
    ["roundrobin", "playoff"],
  );
  assert.equal(outcome.placement.length, 2);
  assert.equal(outcome.placement[0], outcome.series[1]!.winner);
  for (const tool of [
    "submit_name",
    "submit_pick",
    "submit_team",
    "submit_action",
    "submit_review",
  ])
    assert.ok(tasks.get(tool), `${tool} never reached the outside seat`);
  assert.equal(tasks.get("submit_pick"), BOARD.picks);
});

test("placement follows the bracket, then the regular season", () => {
  const standings = [3, 1, 0, 2, 4].map((entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 }));
  const series = (round: number, entrants: [number, number], winner: number) => ({
    index: 0,
    stage: "playoff" as const,
    round,
    entrants,
    score: { p1: 0, p2: 0 },
    winner,
  });
  assert.deepEqual(
    finalPlacement(standings, [series(1, [3, 2], 3), series(1, [1, 0], 0), series(2, [3, 0], 0)]),
    [0, 3, 1, 2, 4],
  );
});
