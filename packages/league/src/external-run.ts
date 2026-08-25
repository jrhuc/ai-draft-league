import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadBoard } from "./draft.js";
import type { DraftView, RunSnapshot } from "./views.js";
import { loadStoredPicks, loadStoredTeambuilds } from "./league-store.js";
import { readRunJson } from "./run-artifacts.js";
import { readCurrentRosterArtifact } from "./trade-window.js";

const stringListSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = z.string().safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);
const teamNamesSchema = z.array(z.unknown()).transform((items) =>
  items.map((item) => {
    const parsed = z.string().safeParse(item);
    return parsed.success ? parsed.data : "";
  }),
);
const draftConfigSchema = z.object({
  mode: z.literal("draft"),
  entrants: stringListSchema,
  board: z.string(),
  weeks: z.number().optional().catch(undefined),
  team_names: teamNamesSchema.optional().catch(undefined),
  seed: z.number().optional().catch(undefined),
});
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

export interface ExternalRunSummary {
  runId: string;
  mode: string;
  state: "running" | "done" | "unknown";
  error: string | null;
  startTime: string | null;
}

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

export function externalDraftSnapshot(runsDir: string, runId: string): RunSnapshot | null {
  const runDir = path.join(runsDir, runId);
  const parsedConfig = draftConfigSchema.safeParse(readRunJson(runsDir, runId, "config.json"));
  if (!parsedConfig.success) return null;
  const config = parsedConfig.data;
  const status = runStatusSchema.parse(readRunJson(runsDir, runId, "status.json"));
  const entrants = config.entrants;
  const board = loadBoard(config.board);
  const picks = loadStoredPicks(runDir, entrants.length, board);
  const rosters = Array.from({ length: entrants.length }, (): string[] => []);
  const budgets = entrants.map(() => board.budget);
  const costs = new Map(board.mons.map((mon) => [mon.id, mon.cost] as const));
  for (const pick of picks) {
    rosters[pick.entrant]!.push(pick.mon);
    budgets[pick.entrant]! -= costs.get(pick.mon) ?? 0;
  }
  const drafted = picks.length >= entrants.length * board.picks;
  const stored = readCurrentRosterArtifact(runDir);
  if (drafted && stored) {
    for (const [entrant, record] of stored.entries()) {
      rosters[entrant] = record.roster.map((mon) => mon.id);
    }
  }
  let teambuilds: DraftView["teambuilds"] = [];
  try {
    teambuilds = [...loadStoredTeambuilds(path.join(runDir, "teambuild")).values()].map(
      (entries) => entries.at(-1)!.view,
    );
  } catch {}
  let week = 0;
  try {
    week = fs
      .readdirSync(path.join(runDir, "reviews"))
      .filter((name) => /^week-\d+\.jsonl$/.test(name)).length;
  } catch {}
  const weeks = config.weeks ?? 0;
  const state =
    status?.state === "running" ? "running" : status?.state === "done" ? "done" : "failed";
  const phase: DraftView["phase"] = !drafted
    ? "draft"
    : state === "done"
      ? "done"
      : week >= weeks
        ? "playoffs"
        : "roundrobin";
  const teamNames = Array.from(
    { length: entrants.length },
    (_, index) => config.team_names?.[index] ?? "",
  );
  return {
    runId,
    mode: "draft",
    state,
    error: status?.error ?? "",
    notices: [],
    seed: config.seed ?? null,
    pool: board.id,
    models: entrants,
    startTime: Date.parse(String(status?.start_time ?? "")) || 0,
    endTime: null,
    canControl: false,
    rows: [],
    bracket: null,
    board: board.id,
    draft: {
      boardId: board.id,
      budget: board.budget,
      picksPerEntrant: board.picks,
      entrants,
      teamNames,
      picks,
      rosters,
      budgets,
      table: null,
      teambuilds,
      week: drafted ? week + 1 : 0,
      weeks,
      phase,
    },
  };
}
