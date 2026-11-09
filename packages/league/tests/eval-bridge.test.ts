import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { z } from "zod";
import { RandomEngine } from "../src/battle-agent.js";
import { EvalBridge, GreedySeat, handleBridgeRequest } from "../src/eval-bridge.js";
import { ShowdownReference } from "../src/reference.js";
import { SimBattle } from "../src/sim.js";
import { loadPool } from "../src/teams.js";

test("an external seat plays a whole game through the bridge and its calls are audited", async () => {
  const pool = loadPool();
  const bridge = new EvalBridge(pool.format);
  const tools = bridge.tools();
  assert.ok(tools.some((tool) => tool.name === "estimate_damage"));
  assert.ok(tools.some((tool) => tool.name === "compare_action_order"));
  assert.ok(!tools.some((tool) => tool.name === "read_battle_history"));
  assert.match(bridge.system(), /expert VGC player/);

  let event = await bridge.start({
    format: pool.format,
    seed: [1, 2, 3, 4],
    p1: { name: "A-external", team: pool.teams[0]!.packed },
    p2: { name: "B-random", team: pool.teams[1]!.packed },
    external: ["p1"],
    opponent: "greedy",
    opponent_seed: 20,
  });
  let decisions = 0;
  let calls = 0;
  while (event.kind === "decision") {
    decisions += 1;
    assert.equal(event.pid, "p1");
    assert.equal(event.decision, decisions);
    assert.match(event.prompt, /Authoritative battle state/);
    assert.equal(event.menus.length, event.slot_names.length);
    if (decisions === 1) {
      assert.equal(event.phase, "team_preview");
      await assert.rejects(bridge.submit("p1", []), /exactly 4 entries/);
      await assert.rejects(bridge.submit("p1", [0, 0, 1, 2]), /conflicts|already/);
      assert.match(bridge.call("p1", "lookup_species", { name: "Incineroar" }), /Incineroar/);
      ({ next: event } = await bridge.submit("p1", [0, 1, 2, 3]));
      continue;
    }
    if (event.phase === "turn" && calls === 0) {
      const order = bridge.call("p1", "compare_action_order", { first: "ally 1", second: "foe 1" });
      assert.ok(order.length > 0);
      calls += 1;
    }
    ({ next: event } = await bridge.submit("p1", "default"));
  }
  assert.ok(decisions > 1);
  const outcome = bridge.result();
  assert.equal(event.outcome.log_sha256, outcome.log_sha256);
  assert.equal(outcome.log_sha256.length, 64);
  assert.ok(outcome.winner);
  assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
  const sources = new Set(outcome.submissions.p1.map((row) => row.source));
  assert.ok(sources.has("model"), "the team preview pick was a model submission");
  assert.ok(sources.has("model-default"), "later turns were defaulted");
  assert.ok(outcome.submissions.p1.every((row) => row.outcome === "accepted"));
  assert.ok(outcome.submissions.p1.some((row) => row.tool_calls === 1));
  const audit = bridge.audit();
  assert.ok(Array.isArray(audit.findings));
  await assert.rejects(bridge.submit("p1", "default"), /no pending decision/);
});

test("the stdio protocol opens a bridge before any other method", async () => {
  const pool = loadPool();
  await assert.rejects(
    handleBridgeRequest(undefined, "tools", {}, () => new EvalBridge(pool.format)),
    /open first/,
  );
  const opened = await handleBridgeRequest(
    undefined,
    "open",
    { format: pool.format },
    (format) => new EvalBridge(format),
  );
  assert.ok(opened.bridge);
  const hello = z.object({ format: z.string(), showdown_commit: z.string() }).parse(opened.result);
  assert.equal(hello.format, pool.format);
  assert.equal(hello.showdown_commit.length, 40);
  const tools = await handleBridgeRequest(
    opened.bridge,
    "tools",
    {},
    () => new EvalBridge(pool.format),
  );
  assert.ok(Array.isArray(tools.result));
  const listed = await handleBridgeRequest(
    opened.bridge,
    "pool",
    { name: "test" },
    () => new EvalBridge(pool.format),
  );
  const { teams } = z
    .object({ teams: z.array(z.object({ id: z.string(), packed: z.string() })) })
    .parse(listed.result);
  assert.equal(teams.length, pool.teams.length);
  assert.equal(teams[0]?.packed, pool.teams[0]?.packed);
  await assert.rejects(
    handleBridgeRequest(opened.bridge, "nope", {}, () => new EvalBridge(pool.format)),
    /unknown method/,
  );
});

test("the greedy opponent beats the random policy on most seeds", async () => {
  const pool = loadPool();
  const reference = new ShowdownReference(pool.format);
  let wins = 0;
  for (const seed of [1, 2, 3, 4]) {
    const battle = new SimBattle(
      pool.format,
      {
        p1: { name: "greedy", team: pool.teams[2]!.packed },
        p2: { name: "random", team: pool.teams[3]!.packed },
      },
      seed,
    );
    const outcome = await battle.run({
      p1: new GreedySeat("p1", reference, seed),
      p2: new RandomEngine("p2", seed),
    });
    assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
    if (outcome.winner === "greedy") wins += 1;
  }
  assert.ok(wins >= 3, `greedy won ${wins} of 4`);
});
