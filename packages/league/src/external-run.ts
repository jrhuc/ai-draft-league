import fs from "node:fs";
import { z } from "zod";
import { readRunJson } from "./run-artifacts.js";

const runStatusSchema = z
  .object({
    state: z.enum(["running", "done"]).optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    start_time: z.string().optional().catch(undefined),
  })
  .nullable()
  .catch(null);

const summaryConfigSchema = z
  .object({ mode: z.string().optional().catch(undefined) })
  .nullable()
  .catch(null);

export type ExternalRunSummary = {
  runId: string;
  mode: string;
  state: "running" | "done" | "unknown";
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
      const status = runStatusSchema.parse(readRunJson(runsDir, entry.name, "status.json"));
      const config = summaryConfigSchema.parse(readRunJson(runsDir, entry.name, "config.json"));
      const stored = status?.state;
      const state: ExternalRunSummary["state"] =
        stored === "running" ? "running" : stored === "done" ? "done" : "unknown";
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
