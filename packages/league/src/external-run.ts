import fs from "node:fs";
import { z } from "zod";
import { readRunJson } from "./run-artifacts.js";
import { isProcessAlive, runStatusSchema } from "./run-status.js";

const summaryConfigSchema = z
  .object({ mode: z.string().optional().catch(undefined) })
  .nullable()
  .catch(null);

export type ExternalRunSummary = {
  runId: string;
  mode: string;
  state: "running" | "done" | "failed" | "stopped" | "unknown";
  error: string | null;
  startTime: string | null;
};

export function listExternalRuns(runsDir: string): ExternalRunSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const status = runStatusSchema.safeParse(
        readRunJson(runsDir, entry.name, "status.json"),
      ).data;
      const config = summaryConfigSchema.parse(readRunJson(runsDir, entry.name, "config.json"));
      const state: ExternalRunSummary["state"] =
        status?.state === "running" && status.pid !== undefined && !isProcessAlive(status.pid)
          ? "stopped"
          : (status?.state ?? "unknown");
      return {
        runId: entry.name,
        mode: config?.mode ?? "unknown",
        state,
        error: status?.error ?? null,
        startTime: status?.start_time ?? null,
      };
    })
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}
