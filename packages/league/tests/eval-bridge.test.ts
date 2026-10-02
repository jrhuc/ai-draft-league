import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vite-plus/test";
import { z } from "zod";
import {
  type BridgeEvent,
  EvalBridge,
  handleBridgeRequest,
  serveBridge,
} from "../src/eval-bridge.js";
import { loadPool } from "../src/teams.js";
import type { Pid } from "../src/types.js";
import { text } from "../src/value.js";

const SEED: [number, number, number, number] = [1, 2, 3, 4];

function open() {
  const pool = loadPool();
  const queue: BridgeEvent[] = [];
  let wake: (() => void) | undefined;
  const bridge = new EvalBridge(pool.format, (event) => {
    queue.push(event);
    wake?.();
  });
  const next = async (): Promise<BridgeEvent> => {
    while (!queue.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    return queue.shift()!;
  };
  const players = (p1: string, p2: string) => ({
    p1: { name: "A", team: pool.teams[0]!.packed, seat: p1 },
    p2: { name: "B", team: pool.teams[1]!.packed, seat: p2 },
  });
  return { pool, bridge, next, players };
}

test("an outside seat plays a whole game as the league's coach and its calls are audited", async () => {
  const { bridge, next, players } = open();
  bridge.start({ seed: SEED, ...players("external", "greedy"), policy_seed: 20 });
  const runner = bridge.runner("p1");
  let exchanges = 0;
  let event = await next();
  while (event.kind !== "end") {
    if (event.kind === "decision") {
      event = await next();
      continue;
    }
    exchanges += 1;
    const { exchange } = event;
    assert.equal(event.pid, "p1");
    assert.equal(exchange.submission.name, "submit_action");
    assert.match(exchange.system, /expert VGC player/);
    assert.match(exchange.prompt, /Authoritative battle state/);
    const tools = exchange.tools.map((tool) => tool.name);
    assert.ok(tools.includes("estimate_damage") && tools.includes("compare_action_order"));
    if (exchanges === 1) {
      assert.throws(() => runner.submit(exchange.id, { choices: [0] }), /exactly 4 entries/);
      assert.throws(
        () => runner.submit(exchange.id, { choices: [0, 1, 2, 3], reason: "x" }),
        /no field "reason"/,
      );
      assert.throws(() => runner.tool(exchange.id, "nope", {}), /unknown tool/);
      assert.match(
        runner.tool(exchange.id, "lookup_species", { name: "Incineroar" }),
        /Incineroar/,
      );
      runner.submit(exchange.id, { choices: [0, 1, 2, 3], rationale: "leads first" });
    } else if (exchanges === 2) {
      const order = runner.tool(exchange.id, "compare_action_order", {
        first: "ally 1",
        second: "foe 1",
      });
      assert.match(order, /raw Speed/);
      runner.abandon(exchange.id, "out of replies");
    } else runner.abandon(exchange.id, "out of replies");
    event = await next();
  }
  assert.ok(exchanges > 2);
  const outcome = bridge.result();
  assert.equal(event.outcome, outcome);
  assert.equal(outcome.error, null);
  assert.equal(outcome.log_sha256.length, 64);
  assert.ok(outcome.winner);
  assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
  const decisions = outcome.decisions.p1.filter((row) => row.kind === "decision");
  assert.equal(decisions[0]?.action, "team 1234");
  assert.equal(decisions[0]?.rationale, "leads first");
  assert.equal(decisions[0]?.submission_source, "model");
  assert.equal(decisions[0]?.parse_failures, 2);
  assert.deepEqual(decisions[0]?.tool_lookups, ["lookup_species"]);
  assert.ok(decisions.some((row) => row.submission_source === "model-default"));
  assert.ok(decisions.every((row) => row.outcome === "accepted"));
  assert.deepEqual(outcome.decisions.p2, []);
  assert.ok(Array.isArray(bridge.audit().findings));
  assert.throws(() => runner.abandon(1, "late"), /no pending exchange/);
  assert.throws(() => bridge.start({ seed: 1, ...players("external", "random") }), /already/);
});

test("a recorded game resumes at a chosen decision with its history", async () => {
  const recorded = open();
  recorded.bridge.start({ seed: SEED, ...recorded.players("external", "external") });
  const turns = { p1: new Array<number>(), p2: new Array<number>() };
  let event = await recorded.next();
  while (event.kind !== "end") {
    if (event.kind === "exchange") {
      const turn = /^Turn: (\d+)/m.exec(event.exchange.prompt);
      turns[event.pid].push(turn ? Number(turn[1]) : 0);
      recorded.bridge.runner(event.pid).abandon(event.exchange.id, "default");
    }
    event = await recorded.next();
  }
  const choices = (pid: Pid) =>
    event.kind === "end" ? event.outcome.decisions[pid].map((row) => text(row.action)) : [];
  const before = (pid: Pid) => turns[pid].filter((turn) => turn < 2).length;
  assert.ok(choices("p1").length > before("p1"));

  const resumed = open();
  resumed.bridge.start({
    seed: SEED,
    ...resumed.players("external", "greedy"),
    script: {
      p1: choices("p1").slice(0, before("p1")),
      p2: choices("p2").slice(0, before("p2")),
    },
  });
  const first = await resumed.next();
  assert.ok(first.kind === "exchange" && first.pid === "p1");
  assert.match(first.exchange.prompt, /^Turn: 2$/m);
  assert.equal(first.exchange.task, "decision-1");
  resumed.bridge.runner("p1").abandon(first.exchange.id, "default");
  let row = await resumed.next();
  while (row.kind !== "decision") row = await resumed.next();
  assert.equal(row.row.action, choices("p1")[before("p1")]);
});

test("a game needs an outside seat and known policies", () => {
  const { bridge, players } = open();
  assert.throws(() => bridge.start({ seed: 1, ...players("greedy", "random") }), /external/);
  assert.throws(
    () => handleBridgeRequest(bridge, "start", { seed: 1, ...players("external", "minimax") }),
    /p2 seat must be one of external, random, greedy, search/,
  );
  assert.throws(() => handleBridgeRequest(bridge, "nope", {}), /Invalid discriminator/);
  assert.throws(() => bridge.result(), /has not ended/);
});

test("the stdio protocol answers requests by id and opens first", async () => {
  const pool = loadPool();
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveBridge(input, output);
  input.write(`${JSON.stringify({ id: 1, method: "pool", params: {} })}\n`);
  input.write(`${JSON.stringify({ id: 2, method: "open", params: { format: pool.format } })}\n`);
  input.write(`${JSON.stringify({ id: 3, method: "pool", params: { name: "test" } })}\n`);
  input.write("not json\n");
  input.end();
  await served;
  const lines = String(output.read())
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)));
  assert.deepEqual(lines[0], { id: 1, error: "call open first" });
  const hello = z
    .object({ format: z.string(), showdown_commit: z.string(), seats: z.array(z.string()) })
    .parse(lines[1]?.result);
  assert.equal(hello.format, pool.format);
  assert.equal(hello.showdown_commit.length, 40);
  assert.ok(hello.seats.includes("search"));
  const listed = z
    .object({ teams: z.array(z.object({ id: z.string(), packed: z.string() })) })
    .parse(lines[2]?.result);
  assert.equal(listed.teams[0]?.packed, pool.teams[0]?.packed);
  assert.equal(lines[3]?.id, null);
  assert.match(text(lines[3]?.error), /JSON/);
});
