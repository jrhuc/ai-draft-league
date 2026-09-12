import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { LIVE_RUN_FILE } from "./live-run.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import { liveRunSchema, type LiveRunSnapshot } from "./public/live-protocol.js";
import { isProcessAlive, runStatusSchema } from "./run-status.js";
import { isErrnoCode } from "./value.js";
import type { JsonValue } from "./types.js";

/** Run state belongs to `status.json`; the live file only projects agents and games. */
export function readLiveRun(runDir: string): LiveRunSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(runDir, LIVE_RUN_FILE), "utf8"));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
  const live = liveRunSchema.omit({ state: true }).parse(value);
  if (live.runId !== path.basename(runDir)) throw new Error("Live snapshot belongs to another run");
  let state: LiveRunSnapshot["state"] = "stopped";
  try {
    const status = runStatusSchema.parse(
      JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8")),
    );
    state =
      status.state === "running" && !(status.pid !== undefined && isProcessAlive(status.pid))
        ? "stopped"
        : status.state;
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
  return { ...live, state, agents: state === "running" ? live.agents : [] };
}

export function streamLiveRun(runsDir: string, runId: string, response: ServerResponse): void {
  if (!SAFE_SEGMENT.test(runId)) throw new Error("Invalid run id");
  const runDir = path.join(runsDir, runId);
  const send = (event: string, value: JsonValue): void => {
    if (response.destroyed) return;
    if (response.writableLength > 1_048_576) {
      response.destroy();
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  let last: string | undefined;
  let revision: string | undefined;
  const snapshot = (): void => {
    try {
      const live = readLiveRun(runDir);
      const serialized = JSON.stringify(live);
      if (serialized !== last) {
        last = serialized;
        send("snapshot", live);
        const nextRevision = live ? `${live.generation}:${live.revision}:${live.state}` : undefined;
        if (revision !== nextRevision) {
          revision = nextRevision;
          send("refresh", null);
        }
      }
    } catch (error) {
      send("watch-error", error instanceof Error ? error.message : String(error));
    }
  };
  const watcher = fs.watch(runDir, (_event, file) => {
    if (file === LIVE_RUN_FILE || file === "status.json") snapshot();
  });
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  snapshot();
  const heartbeat = setInterval(() => {
    snapshot();
    response.write(": keepalive\n\n");
  }, 10_000);
  watcher.on("error", (error) => {
    send("watch-error", error.message);
    response.end();
  });
  response.on("close", () => {
    watcher.close();
    clearInterval(heartbeat);
  });
}
