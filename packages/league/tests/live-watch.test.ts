import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { writeAtomicJson } from "../src/atomic-json.js";
import { readLiveRun, streamLiveRun } from "../src/live-watch.js";
import { withAgentHost } from "../src/agent-runtime.js";
import { LiveRun } from "../src/live-run.js";
import { withRunStatus } from "../src/run-status.js";
import { RandomEngine } from "../src/battle-agent.js";
import { playBo3 } from "../src/series.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-live-"));
  directories.push(result);
  return result;
}

test("streams snapshots across atomic replacement, reconnects at current state, and resets on resume", async () => {
  const runDir = directory();
  const server = createServer((_request, response) =>
    streamLiveRun(path.dirname(runDir), path.basename(runDir), response),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).parse(server.address());
  const controller = new AbortController();
  const events: string[] = [];
  const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const consume = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        events.push(next.value);
      }
    } catch {
      if (!controller.signal.aborted) throw new Error("Live stream failed");
    }
  })();
  try {
    let generation = "";
    await withRunStatus(runDir, async () => {
      const live = new LiveRun(runDir);
      try {
        generation = readLiveRun(runDir)!.generation;
        expect(readLiveRun(runDir)?.state).toBe("running");
        live.agent({
          session: "seat-a",
          model: "fixture:a",
          task: "decision-1",
          activity: "reasoning",
        });
        live.agent({
          session: "seat-b",
          model: "fixture:b",
          task: "decision-2",
          activity: "retry",
        });
        live.invalidate();
        await vi.waitFor(() => expect(events.join("")).toContain('"activity":"retry"'));
        expect(readLiveRun(runDir)?.agents).toHaveLength(2);
        expect(events.join("")).toContain("event: refresh");
        const reconnected = await fetch(`http://127.0.0.1:${address.port}`, {
          signal: controller.signal,
        });
        const stream = reconnected.body!.getReader();
        const first = new TextDecoder().decode((await stream.read()).value);
        expect(first).toContain("seat-a");
        expect(first).toContain("seat-b");
        await stream.cancel();
        live.agent({
          session: "seat-a",
          model: "fixture:a",
          task: "decision-1",
          activity: "ended",
        });
        await vi.waitFor(() =>
          expect(readLiveRun(runDir)?.agents.map((entry) => entry.session)).toEqual(["seat-b"]),
        );
      } finally {
        live.flush();
      }
    });
    await vi.waitFor(() => expect(events.join("")).toContain('"state":"done"'));
    expect(readLiveRun(runDir)?.agents).toEqual([]);
    await withAgentHost(runDir, async () => {
      const resumed = readLiveRun(runDir)!;
      expect(resumed.generation).not.toBe(generation);
      expect(resumed.agents).toEqual([]);
      expect(resumed.games).toEqual([]);
    });
  } finally {
    controller.abort();
    await consume;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("publishes only Showdown's public stream while the private canonical log stays intact", async () => {
  const runDir = directory();
  await withRunStatus(runDir, () =>
    withAgentHost(runDir, (agents) =>
      playBo3({
        engines: { p1: new RandomEngine("p1", 1), p2: new RandomEngine("p2", 2) },
        names: { p1: "Alpha", p2: "Beta" },
        players: { p1: "fixture:a", p2: "fixture:b" },
        teams: { p1: { id: "one", packed: "" }, p2: { id: "two", packed: "" } },
        seriesId: "series",
        seriesDir: runDir,
        runDir,
        format: "test",
        psDir: "",
        gameSeeds: [[1, 2, 3, 4]],
        onLiveGame: agents.live.game,
        runBattle: async (_seed, update) => {
          update(["PRIVATE_EXACT_HP"], ["|turn|1", "|-damage|p1a: Pikachu|50/100"]);
          await vi.waitFor(() => expect(readLiveRun(runDir)?.games[0]?.turn).toBe(1));
          const snapshot = readLiveRun(runDir)!;
          expect(snapshot.state).toBe("running");
          expect(snapshot.games[0]?.state).toBe("playing");
          expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_EXACT_HP");
          return {
            winner: "Alpha",
            turns: 1,
            log: ["PRIVATE_EXACT_HP", "|win|Alpha"],
            pov: { p1: [], p2: [] },
            errors: { p1: 0, p2: 0 },
            simulatorSubstitutions: { p1: 0, p2: 0 },
            timerAutodefaults: { p1: 0, p2: 0 },
          };
        },
      }),
    ),
  );
  const finished = readLiveRun(runDir)!;
  expect(finished.state).toBe("done");
  expect(finished.games[0]).toMatchObject({
    state: "ended",
    winner: "fixture:a",
    score: { p1: 1, p2: 0 },
  });
  expect(fs.readFileSync(path.join(runDir, "game-1.log"), "utf8")).toContain("PRIVATE_EXACT_HP");
  writeAtomicJson(path.join(runDir, "status.json"), { state: "running", pid: 2147483647 });
  expect(readLiveRun(runDir)?.state).toBe("stopped");
  fs.writeFileSync(path.join(runDir, "live.json"), "{}");
  expect(() => readLiveRun(runDir)).toThrow();
});
