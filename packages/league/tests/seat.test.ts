import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { runExhibition } from "../src/exhibition.js";
import type { SeriesRecord } from "../src/records.js";
import { loadSeriesRecords, scopeRows } from "../src/records.js";
import { SeatBridge } from "../src/seat.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { asRecord, text } from "../src/value.js";

test("unscoped play data includes exhibitions without turning them into a ranking", () => {
  const rows: SeriesRecord[] = [
    { mode: "rotation", pool: "regmb", players: { p1: "a", p2: "b" }, winner: "a" },
    { mode: "exhibition", pool: "regmb", players: { p1: "cli-agent", p2: "b" }, winner: "b" },
  ];
  assert.equal(scopeRows(rows).length, 2);
  assert.equal(scopeRows(rows, "regmb").length, 2);
});

test("seat bridge keeps a pending exchange, tools, and private context behind one token", async () => {
  const lookups: string[] = [];
  const bridge = new SeatBridge({
    context: (query) => ({ query: { ...query } }),
  });
  const url = await bridge.listen(0);
  const headers = { "content-type": "application/json", authorization: `Bearer ${bridge.token}` };
  const post = (route: string, body: JsonValue) =>
    fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal(
      (
        await fetch(`${url}/context`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );

    const completion = bridge.runAgent({
      session: "seat",
      task: "decision-1",
      model: "external",
      system: "SYSTEM TEXT",
      prompt: "prompt text",
      submission: {
        name: "submit_action",
        description: "Submit",
        parameters: { type: "object", required: ["choices"] },
      },
      validate: (input) => {
        assert.deepEqual(input, { choices: [0] });
        return input;
      },
      tools: [
        {
          definition: { name: "lookup_move", description: "Look up move", parameters: {} },
          run: (input) => {
            lookups.push("lookup_move");
            return `result for ${text(input.name)}`;
          },
        },
      ],
    });
    const poll: { exchange: JsonObject } = await (await post("/poll", { waitMs: 2000 })).json();
    const { id: _id, ...view } = poll.exchange;
    assert.deepEqual(view, {
      task: "decision-1",
      system: "SYSTEM TEXT",
      prompt: "prompt text",
      submission: {
        name: "submit_action",
        parameters: { type: "object", required: ["choices"] },
      },
    });

    const tool: { result: string } = await (
      await post("/tool", { name: "lookup_move", arguments: { name: "Protect" } })
    ).json();
    assert.equal(tool.result, "result for Protect");
    assert.deepEqual(lookups, ["lookup_move"]);
    const context: { query: { after: string } } = await (
      await post("/context", { after: "ctx-00000001" })
    ).json();
    assert.equal(context.query.after, "ctx-00000001");

    assert.equal(
      (await post("/submit", { id: poll.exchange.id, text: '{"choices":[0]}' })).status,
      200,
    );
    assert.equal((await completion).response, '{"choices":[0]}');
  } finally {
    bridge.close();
  }
});

function decide(prompt: string): number[] {
  if (prompt.includes("Ordered team menu")) return [0, 1, 2, 3];
  const menus: string[][] = [];
  for (const line of prompt.split("\n")) {
    if (/^Slot \d+: /.test(line)) menus.push([]);
    else if (menus.length && /^ {2}\d+\. /.test(line))
      menus.at(-1)!.push(line.replace(/^ {2}\d+\. /, ""));
    else if (menus.length && line === "") break;
  }
  const chosen: string[] = [];
  return menus.map((labels) => {
    let index = labels.findIndex(
      (label) => !(/^(Pick|Switch to) /.test(label) && chosen.includes(label)),
    );
    if (index < 0) index = 0;
    chosen.push(labels[index]!);
    return index;
  });
}

test("exhibition refuses every reused or symlinked agent workspace", async () => {
  const layouts: Array<{ name: string; prepare: (agentDir: string) => void }> = [
    { name: "empty-directory", prepare: (agentDir) => fs.mkdirSync(agentDir) },
    {
      name: "occupied-directory",
      prepare: (agentDir) => {
        fs.mkdirSync(agentDir);
        fs.writeFileSync(path.join(agentDir, "untrusted"), "occupied");
      },
    },
    { name: "file", prepare: (agentDir) => fs.writeFileSync(agentDir, "occupied") },
  ];
  if (process.platform !== "win32") {
    layouts.push({
      name: "symlink",
      prepare: (agentDir) => {
        const target = `${agentDir}-target`;
        fs.mkdirSync(target);
        fs.symlinkSync(target, agentDir, "dir");
      },
    });
  }

  for (const layout of layouts) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `vgc-seat-workspace-${layout.name}-`));
    const agentDir = path.join(scratch, "agent");
    layout.prepare(agentDir);
    await assert.rejects(
      runExhibition(path.join(scratch, "run"), {
        opponent: "random",
        seed: 12,
        agentDir,
        recordsPath: path.join(scratch, "results.jsonl"),
      }),
      /agent workspace must be freshly created/,
    );
  }
});

test("exhibition refuses reused or symlinked workspace artifacts", async () => {
  const layouts: Array<{
    name: string;
    plant: (seatConfig: string, target: string) => void;
    verify: (seatConfig: string, target: string) => void;
  }> = [
    {
      name: "file",
      plant: (seatConfig) => fs.writeFileSync(seatConfig, "occupied"),
      verify: (seatConfig) => assert.equal(fs.readFileSync(seatConfig, "utf8"), "occupied"),
    },
  ];
  if (process.platform !== "win32") {
    layouts.push({
      name: "symlink",
      plant: (seatConfig, target) => fs.symlinkSync(target, seatConfig),
      verify: (seatConfig, target) => {
        assert.equal(fs.lstatSync(seatConfig).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
      },
    });
  }

  for (const layout of layouts) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `vgc-seat-artifact-${layout.name}-`));
    const agentDir = path.join(scratch, "agent");
    const seatConfig = path.join(agentDir, "seat.json");
    const target = path.join(scratch, "outside-token-target");
    fs.writeFileSync(target, "unchanged");

    const originalOpenSync = fs.openSync;
    const originalOpenSyncDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync");
    if (!originalOpenSyncDescriptor)
      throw new Error("fs.openSync property descriptor is unavailable");
    let planted = false;
    // SAFETY: the interceptor forwards every call to the original overloads unchanged.
    const interceptedOpenSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!planted && filePath === seatConfig) {
        layout.plant(seatConfig, target);
        planted = true;
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    Object.defineProperty(fs, "openSync", {
      ...originalOpenSyncDescriptor,
      value: interceptedOpenSync,
    });
    try {
      await assert.rejects(
        runExhibition(path.join(scratch, "run"), {
          opponent: "random",
          seed: 13,
          agentDir,
          recordsPath: path.join(scratch, "results.jsonl"),
        }),
        /agent workspace artifact must be freshly created: seat\.json/,
      );
    } finally {
      Object.defineProperty(fs, "openSync", originalOpenSyncDescriptor);
    }

    assert.equal(planted, true);
    layout.verify(seatConfig, target);
  }
});

test("an exhibition series against random plays to completion through the bridge", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-seat-"));
  const runDir = path.join(scratch, "run");
  const recordsPath = path.join(scratch, "results.jsonl");
  const ready = Promise.withResolvers<{ url: string; agentDir: string }>();
  const rowPromise = runExhibition(runDir, {
    opponent: "random",
    seed: 11,
    recordsPath,
    onReady: ready.resolve,
  });
  const { url, agentDir } = await Promise.race([
    ready.promise,
    rowPromise.then(() => {
      throw new Error("series finished before the bridge was ready");
    }),
  ]);

  const config: { token: string } = JSON.parse(
    fs.readFileSync(path.join(agentDir, "seat.json"), "utf8"),
  );
  assert.ok(fs.existsSync(path.join(agentDir, "seat.mjs")));
  assert.ok(fs.existsSync(path.join(agentDir, "SEAT.md")));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(agentDir).mode & 0o777, 0o700);
    for (const artifact of ["seat.json", "seat.mjs", "SEAT.md"])
      assert.equal(fs.statSync(path.join(agentDir, artifact)).mode & 0o777, 0o600);
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${config.token}` };

  const prompts: string[] = [];
  let battleTools: Array<{ name: string; parameters: JsonObject }> = [];
  let driving = true;
  const driver = (async () => {
    while (driving) {
      let data: {
        exchange: { id: number; prompt: string; submission: { name: string } } | null;
      };
      try {
        const response = await fetch(`${url}/poll`, {
          method: "POST",
          headers,
          body: JSON.stringify({ waitMs: 500 }),
        });
        data = await response.json();
      } catch {
        return;
      }
      if (!data.exchange) continue;
      prompts.push(data.exchange.prompt);
      if (data.exchange.submission.name === "submit_action" && battleTools.length === 0) {
        const response = await fetch(`${url}/tools`, { method: "POST", headers, body: "{}" });
        const listed: { tools: typeof battleTools } = await response.json();
        battleTools = listed.tools;
      }
      const text =
        data.exchange.submission.name === "submit_review"
          ? '{"summary":"s","adjustment":"a"}'
          : JSON.stringify({
              choices: decide(data.exchange.prompt),
              rationale: "r",
            });
      const submitted = await fetch(`${url}/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: data.exchange.id, text }),
      });
      assert.equal(submitted.status, 200, await submitted.text());
    }
  })();

  const row = await Promise.race([
    rowPromise,
    driver.then(() => {
      throw new Error("driver exited before series completed");
    }),
  ]);
  driving = false;
  await driver;

  assert.equal(row.mode, "exhibition");
  assert.equal(row.pool, "test");
  assert.equal(row.seat, "p1");
  assert.deepEqual(row.players, { p1: "cli-agent", p2: "random" });
  assert.deepEqual(row.execution_harnesses, {
    p1: {
      adapter: "trusted-external-bridge",
      isolated: false,
    },
    p2: {
      adapter: "random-engine",
    },
  });
  assert.ok(battleTools.some((tool) => tool.name === "compare_action_order"));
  const damage = battleTools.find((tool) => tool.name === "estimate_damage");
  assert.ok(damage);
  const score = asRecord(row.score);
  assert.equal(Math.max(Number(score.p1), Number(score.p2)), 2);
  assert.ok(prompts.some((prompt) => prompt.includes("Ordered team menu")));
  assert.ok(!prompts.some((prompt) => prompt.includes("Showdown timer:")));

  const recorded = loadSeriesRecords(recordsPath);
  assert.equal(recorded.length, 1);
  assert.equal(scopeRows(recorded).length, 0);
  assert.equal(scopeRows(recorded, "test").length, 1);

  const seriesDir = path.join(runDir, "series", String(row.series_id));
  assert.ok(fs.existsSync(path.join(seriesDir, "p1-decisions.jsonl")));
  assert.ok(fs.existsSync(path.join(seriesDir, "p1-trace.jsonl")));
  const contextRows = fs
    .readFileSync(path.join(seriesDir, "p1-context.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line): { context_id: string; kind: string } => JSON.parse(line));
  assert.equal(contextRows[0]?.context_id, "ctx-00000001");
  assert.ok(contextRows.some((row) => row.kind === "agent_context"));
});
