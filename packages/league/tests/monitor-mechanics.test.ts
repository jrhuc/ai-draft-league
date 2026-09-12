import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { readSubmissionTraces } from "../src/decision-traces.js";
import { readCompletedSeriesDecisionRows } from "../src/recorded-series.js";
import { auditGame, observeGame, readPredictions } from "../src/monitor-mechanics.js";
import type { JsonObject } from "../src/types.js";
import { text } from "../src/value.js";
import { storeCompletedSeriesFixture } from "./series-store-fixture.js";

const LOG = [
  "|switch|p1a: Garchomp|Garchomp, L50, M|185/185",
  "|switch|p1b: Whimsicott|Whimsicott, L50, F|137/137",
  "|switch|p2a: Pikachu|Pikachu, L50, M|100/100",
  "|switch|p2b: Mimikyu|Mimikyu, L50, F|100/100",
  "|turn|1",
  "|move|p2a: Pikachu|Fake Out|p1b: Whimsicott",
  "|-damage|p1b: Whimsicott|110/137",
  "|move|p1a: Garchomp|Earthquake|p2a: Pikachu|[spread] p1b,p2a,p2b",
  "|-supereffective|p2a: Pikachu",
  "|-damage|p2a: Pikachu|1/100",
  "|-enditem|p2a: Pikachu|Focus Sash",
  "|-activate|p2b: Mimikyu|ability: Disguise",
  "|detailschange|p2b: Mimikyu|Mimikyu-Busted, L50, F",
  "|-damage|p2b: Mimikyu|88/100|[from] ability: Disguise",
  "|-damage|p1b: Whimsicott|60/137",
  "|move|p1b: Whimsicott|Moonblast|p2a: Pikachu",
  "|-damage|p2a: Pikachu|0 fnt",
  "|faint|p2a: Pikachu",
  "|turn|2",
  "|-mega|p1a: Garchomp|Garchomp|Garchompite",
  "|detailschange|p1a: Garchomp|Garchomp-Mega, L50, M",
  "|move|p1a: Garchomp|Dragon Claw|p2b: Mimikyu",
  "|-crit|p2b: Mimikyu",
  "|-damage|p2b: Mimikyu|30/100",
  "|move|p2b: Mimikyu|Shadow Sneak|p1a: Garchomp|[still]",
  "|-fail|p2b: Mimikyu",
  "|turn|3",
];

interface Call extends JsonObject {
  name: string;
  arguments: JsonObject;
  result: string;
}

function trace(pid: "p1" | "p2", turn: number, calls: Call[], phase = "turn"): JsonObject {
  return { kind: "decision_trace", pid, turn, phase, game_number: 1, tool_calls: calls };
}

function damage(
  attacker: string,
  defender: string,
  move: string,
  range: string,
  verdict: string,
  applied = "",
  extra: JsonObject = {},
): Call {
  return {
    name: "estimate_damage",
    arguments: { attacker, defender, move, ...extra },
    result: `${attacker} ${move} into ${defender}: ${range} of maximum HP before survival effects. Target HP shown: 100%. ${verdict} applied ${applied}; legal attack range.`,
  };
}

function order(first: string, second: string, moves?: [string, string]): Call {
  return {
    name: "compare_action_order",
    arguments: moves
      ? { first, second, first_move: moves[0], second_move: moves[1] }
      : { first, second },
    result: `${first} is guaranteed to act first\n${first}: raw Speed 169`,
  };
}

test("observeGame attributes direct hits, markers, and forme changes", () => {
  const { hits, orders } = observeGame(LOG);
  const sash = hits.find((hit) => hit.target === "Pikachu" && hit.move === "Earthquake");
  assert.deepEqual(
    {
      before: sash?.hpBefore,
      after: sash?.hpAfter,
      spread: sash?.spreadTargets,
      markers: sash?.markers,
    },
    { before: 100, after: 1, spread: 3, markers: ["Focus Sash"] },
  );
  const disguise = hits.find((hit) => hit.target === "Mimikyu" && hit.move === "Earthquake");
  assert.deepEqual(disguise?.markers, ["Disguise"]);
  assert.equal(disguise?.hpBefore, disguise?.hpAfter, "the Disguise chip is indirect damage");
  const claw = hits.find((hit) => hit.move === "Dragon Claw");
  assert.deepEqual(
    { attacker: claw?.attacker, crit: claw?.crit, markers: claw?.markers },
    { attacker: "Garchomp-Mega", crit: true, markers: ["attacker changed forme this turn"] },
  );
  assert.deepEqual(
    orders.map((turn) => turn.moves.map((move) => `${move.species} ${move.move}`)),
    [
      ["Pikachu Fake Out", "Garchomp Earthquake", "Whimsicott Moonblast"],
      ["Garchomp-Mega Dragon Claw"],
      [],
    ],
    "a move that never executed is not part of the turn order",
  );
});

test("readPredictions understands both result vocabularies and forced-switch turns", () => {
  const rows = [
    trace("p1", 3, [
      damage("Garchomp", "Pikachu", "Earthquake", "120-180%", "OHKO at both evaluated endpoints."),
      damage("Garchomp", "Pikachu", "Earthquake", "120-180%", "Guaranteed OHKO across the range."),
      damage("Garchomp", "Pikachu", "Earthquake", "80-120%", "Possible OHKO, not guaranteed."),
      damage("Garchomp", "Pikachu", "Earthquake", "10-20%", "No KO from the shown 45% at either."),
    ]),
    trace(
      "p1",
      3,
      [damage("Garchomp", "Pikachu", "Earthquake", "1-2%", "Cannot OHKO in this estimate.")],
      "forced_switch",
    ),
  ];
  assert.deepEqual(
    readPredictions(rows).damage.map((prediction) => [prediction.turn, prediction.ko]),
    [
      [3, "both"],
      [3, "both"],
      [3, "one"],
      [3, "none"],
      [4, "none"],
    ],
  );
});

test("auditGame reports falsified KO calls, out-of-range hits, and inverted order", () => {
  const p1 = [
    trace("p1", 1, [
      damage(
        "Garchomp",
        "Pikachu",
        "Earthquake",
        "120-180%",
        "OHKO at both evaluated endpoints.",
        "spread (0.75x)",
      ),
      damage(
        "Garchomp",
        "Mimikyu",
        "Earthquake",
        "110-150%",
        "OHKO at both evaluated endpoints.",
        "spread (0.75x)",
      ),
      damage(
        "Whimsicott",
        "Pikachu",
        "Moonblast",
        "40-60%",
        "No OHKO at either evaluated endpoint.",
      ),
      order("Garchomp", "Pikachu", ["Earthquake", "Fake Out"]),
      order("Garchomp", "Pikachu"),
    ]),
    trace("p1", 2, [
      damage(
        "Garchomp",
        "Mimikyu",
        "Dragon Claw",
        "20-30%",
        "No OHKO at either evaluated endpoint.",
      ),
      damage(
        "Garchomp",
        "Mimikyu",
        "Dragon Claw",
        "30-45%",
        "No OHKO at either evaluated endpoint.",
        "critical hit",
        { is_critical_hit: true },
      ),
    ]),
  ];
  const p2 = [
    trace("p2", 1, [
      damage(
        "Pikachu",
        "Whimsicott",
        "Fake Out",
        "10-15%",
        "No OHKO at either evaluated endpoint.",
      ),
    ]),
  ];
  const audit = auditGame(1, LOG, { p1, p2 });
  assert.deepEqual(
    {
      damagePredictions: audit.damagePredictions,
      damageMatched: audit.damageMatched,
      orderPredictions: audit.orderPredictions,
      orderMatched: audit.orderMatched,
    },
    { damagePredictions: 6, damageMatched: 5, orderPredictions: 2, orderMatched: 1 },
    "the non-crit Dragon Claw estimate and the order query without moves are not judged",
  );
  assert.deepEqual(
    audit.findings.map((finding) => [finding.kind, finding.turn, finding.pid]),
    [
      ["ko-missed", 1, "p1"],
      ["ko-missed", 1, "p1"],
      ["damage-range", 2, "p1"],
      ["order", 1, "p1"],
      ["damage-range", 1, "p2"],
    ],
  );
  const details = audit.findings.map((finding) => finding.detail);
  assert.match(details[0]!, /Focus Sash/);
  assert.match(details[1]!, /Disguise/);
  assert.match(details[2]!, /attacker changed forme this turn/);
  assert.match(details[3]!, /Pikachu Fake Out → Garchomp Earthquake/);
  assert.doesNotMatch(
    audit.findings
      .filter((finding) => finding.kind !== "order")
      .map((finding) => finding.detail)
      .join("\n"),
    /Moonblast/,
    "a KO on a target chipped below the range is not a finding",
  );
});

test("mechanics counts only canonical submissions after native decision recovery", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "league-mechanics-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const seriesDir = path.join(runDir, "series", "recovered");
  fs.mkdirSync(seriesDir, { recursive: true });
  const logPath = path.join(seriesDir, "game-1.log");
  fs.writeFileSync(logPath, LOG.join("\n"));
  storeCompletedSeriesFixture(runDir, "recovered", [
    { number: 1, logPath, winner: "fixture:p1", winnerSide: "p1" },
  ]);
  const calls = [
    damage(
      "Garchomp",
      "Pikachu",
      "Earthquake",
      "120-180%",
      "OHKO at both evaluated endpoints.",
      "spread (0.75x)",
    ),
    order("Garchomp", "Pikachu", ["Earthquake", "Fake Out"]),
  ];
  const submissions = ["interrupted", "canonical"].map((attempt) => ({
    ...trace("p1", 1, calls),
    attempt_id: attempt,
    submission_id: `${attempt}:1`,
    session_id: "native-session",
    message_id: "native-message",
    prompt: "Choose",
    raw_response: "{}",
    reasoning: "",
    latency_ms: 104490,
    usage: {},
  }));
  fs.writeFileSync(
    path.join(seriesDir, "p1-trace.jsonl"),
    submissions.map((row) => JSON.stringify(row)).join("\n"),
  );
  fs.writeFileSync(
    path.join(seriesDir, "p1-decisions.jsonl"),
    submissions.map((row) => JSON.stringify({ ...row, kind: "decision" })).join("\n"),
  );
  const rows = readCompletedSeriesDecisionRows(runDir, "recovered", "p1");
  const traces = readSubmissionTraces(
    seriesDir,
    "p1",
    new Set(rows.map((row) => text(row.submission_id))),
  );
  const audit = auditGame(1, LOG, { p1: [...traces.values()], p2: [] });
  assert.equal(audit.damagePredictions, 1);
  assert.equal(audit.orderPredictions, 1);
  assert.equal(traces.get("canonical:1")?.latency_ms, 104490);
});
