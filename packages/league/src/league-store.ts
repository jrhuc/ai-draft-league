import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { writeAtomicJson } from "./atomic-json.js";
import type { DraftBoard } from "./draft.js";
import { draftTranscriptRowSchema, snakeOrder } from "./draft.js";
import type { DraftPickView, TeamBuildView } from "./views.js";
import { readFranchiseCheckpoints, readFranchiseRosterVersion } from "./league-journal.js";
import type { ReasoningLevel } from "./providers.js";
import { seededRng, shuffle } from "./random.js";
import { readRunArtifacts } from "./run-artifact-store.js";
import { harnessCommit } from "./showdown.js";
import {
  decodeTeamBuildJournalRow,
  replayTeamBuildArtifact,
  type TeamBuildArtifact,
  type TeamBuildJournalEntry,
  type TeamBuildSheetPolicy,
} from "./teambuild.js";
import { MAX_TRADE_OFFERS, type TransactionSchedule } from "./trade-window.js";
import type { ContributorAttribution, JsonValue, TimerScale } from "./types.js";
import { isErrnoCode, isRecord } from "./value.js";

export interface StoredLeague {
  config: StoredDraftLeagueConfig;
  draftComplete: boolean;
  entrants: string[];
  teamNames: string[];
  rosterIds: string[][];
  draftNotes: string[];
  transactions: TransactionSchedule | undefined;
  swapsAllowed: number;
}

const transactionWindowSchema = z.strictObject({
  after_week: z.number().int().safe().min(1),
  trades_allowed: z.number().int().safe().min(0).max(MAX_TRADE_OFFERS),
});
export const draftLeagueConfigSchema = z.looseObject({
  mode: z.literal("draft"),
  models: z.array(z.string()),
  entrants: z.array(z.string()).min(2),
  seed: z.number(),
  board: z.string(),
  format: z.string().optional(),
  concurrency: z.number().optional(),
  reasoning: z.string().nullable().optional(),
  reasoning_by_model: z.record(z.string(), z.string()).nullable().optional(),
  timer_scale: z.union([z.number(), z.literal("off")]).optional(),
  closed_sheets: z.boolean().optional(),
  draft_only: z.boolean(),
  preset: z.string().nullable().optional(),
  transactions: z.array(transactionWindowSchema).nullable(),
  swaps_allowed: z.number().int().safe(),
  weeks: z.number().optional(),
});
export type StoredDraftLeagueConfig = z.infer<typeof draftLeagueConfigSchema>;

interface DraftLeagueConfig {
  runDir: string;
  showdownCommit: string;
  models: readonly string[];
  entrants: readonly string[];
  seed: number;
  concurrency: number;
  reasoning: ReasoningLevel | null;
  reasoningByModel: Readonly<Record<string, ReasoningLevel>> | null;
  timerScale: TimerScale;
  board: Pick<DraftBoard, "id" | "format">;
  closedSheets: boolean;
  draftOnly: boolean;
  preset: string | null;
  transactions: Array<{ after_week: number; trades_allowed: number }> | null;
  swapsAllowed: number;
  weeks: number;
  contributor: ContributorAttribution | null;
}

export function writeDraftLeagueConfig(config: DraftLeagueConfig): void {
  writeAtomicJson(
    path.join(config.runDir, "config.json"),
    {
      mode: "draft",
      harness_commit: harnessCommit(),
      showdown_commit: config.showdownCommit,
      models: config.models,
      entrants: config.entrants,
      seed: config.seed,
      board: config.board.id,
      format: config.board.format,
      concurrency: config.concurrency,
      reasoning: config.reasoning,
      reasoning_by_model: config.reasoningByModel,
      timer_scale: config.timerScale,
      closed_sheets: config.closedSheets,
      draft_only: config.draftOnly,
      preset: config.preset,
      transactions: config.transactions,
      swaps_allowed: config.swapsAllowed,
      weeks: config.weeks,
      contributor: config.contributor,
    },
    2,
  );
}

export function loadStoredPicks(
  runDir: string,
  entrants: number,
  board: DraftBoard,
): DraftPickView[] {
  const rows = readRunArtifacts(runDir, "draft-pick")
    .map((row) => draftTranscriptRowSchema.parse(row.value))
    .sort((a, b) => a.pick - b.pick);
  const order = snakeOrder(entrants, board.picks);
  return rows.flatMap((row, index) => {
    const entrant = order[index];
    if (entrant === undefined) return [];
    return [
      { pick: row.pick, entrant, mon: row.mon, rationale: row.rationale, fallback: row.fallback },
    ];
  });
}

export function validateStoredLeagueConfig(
  runDir: string,
  stored: StoredLeague,
  request: {
    models: readonly string[];
    seed: number;
    board: DraftBoard;
    closedSheets: boolean;
    timerScale: TimerScale;
    showdownCommit: string;
  },
): void {
  const config = stored.config;
  if (
    config.seed !== request.seed ||
    config.board !== request.board.id ||
    config.format !== request.board.format ||
    config.showdown_commit !== request.showdownCommit ||
    !isDeepStrictEqual(config.models, request.models) ||
    config.closed_sheets !== request.closedSheets ||
    config.timer_scale !== request.timerScale
  ) {
    throw new Error(
      `${runDir} stored config does not match the resumed league invocation, board, and Showdown checkout`,
    );
  }
  const expectedEntrants = shuffle(request.models, seededRng(request.seed));
  if (!isDeepStrictEqual(stored.entrants, expectedEntrants)) {
    throw new Error(`${runDir} stored entrants do not match the seeded draft seating`);
  }
}

/** Resuming a draft-only run into a season is the one change the run specification accepts. */
export function promoteDraftOnlyConfig(
  runDir: string,
  transactions: Array<{ after_week: number; trades_allowed: number }>,
): void {
  const configPath = path.join(runDir, "config.json");
  const config: JsonValue = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!isRecord(config)) throw new Error(`${configPath} is not a league config`);
  writeAtomicJson(configPath, { ...config, draft_only: false, transactions }, 2);
}

export interface StoredBuild {
  packed: string;
  view: TeamBuildView;
}

/** A stored build is reused only when it was made for exactly this matchup, rosters, and sheet policy. */
export function linkedStoredArtifact(
  entry: TeamBuildJournalEntry,
  context: {
    model: string;
    opponentModel: string;
    format: string;
    psDir: string;
    sheetPolicy: TeamBuildSheetPolicy;
    stage: "roundrobin" | "playoff";
    seriesIndex: number;
    entrant: number;
    opponent: number;
    rosterIds: string[];
    opponentRosterIds: string[];
  },
): StoredBuild | undefined {
  let replayed: { artifact: TeamBuildArtifact; packed: string };
  try {
    replayed = replayTeamBuildArtifact(entry.artifact, { psDir: context.psDir });
  } catch {
    return undefined;
  }
  const task = replayed.artifact.task;
  if (
    replayed.artifact.executionPolicy !== "league-resilient" ||
    task.executionPolicy !== "league-resilient" ||
    task.model !== context.model ||
    task.format !== context.format ||
    task.sheetPolicy !== context.sheetPolicy ||
    task.constraint.kind !== "draft-picks" ||
    task.objective.kind !== "matchup" ||
    task.objective.stage !== context.stage ||
    task.objective.opponent.model !== context.opponentModel ||
    task.provenance.source !== "draft-league" ||
    task.provenance.seriesIndex !== context.seriesIndex ||
    task.provenance.entrant !== context.entrant ||
    task.provenance.opponent !== context.opponent ||
    !isDeepStrictEqual(
      task.constraint.candidates.map((candidate) => candidate.id),
      context.rosterIds,
    ) ||
    !isDeepStrictEqual(
      task.objective.opponent.candidates.map((candidate) => candidate.id),
      context.opponentRosterIds,
    )
  ) {
    return undefined;
  }
  return { packed: replayed.packed, view: structuredClone(entry.view) };
}

export function loadStoredBuilds(runDir: string): Map<string, TeamBuildJournalEntry> {
  const builds = new Map<string, TeamBuildJournalEntry>();
  for (const row of readRunArtifacts(runDir, "teambuild")) {
    const entry = decodeTeamBuildJournalRow(row.value, `teambuild artifact ${row.key}`);
    builds.set(`${entry.view.seriesIndex}:${entry.view.entrant}`, entry);
  }
  return builds;
}

export function loadStoredLeague(runDir: string): StoredLeague {
  const configPath = path.join(runDir, "config.json");
  let configBytes: string;
  try {
    configBytes = fs.readFileSync(configPath, "utf8");
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT"))
      throw new Error(`${runDir} holds no draft league config to resume`);
    throw cause;
  }
  const parsedConfig: JsonValue = JSON.parse(configBytes);
  if (!isRecord(parsedConfig) || parsedConfig.mode !== "draft")
    throw new Error(`${runDir} is not a draft league run`);
  const parsed = draftLeagueConfigSchema.safeParse(parsedConfig);
  if (!parsed.success) {
    const windowIssue = parsed.error.issues.some((issue) => issue.path[0] === "transactions");
    throw new Error(
      windowIssue
        ? `${runDir} season config has an invalid transaction window`
        : `${runDir} is not a structurally complete drafted-league config`,
    );
  }
  const config = parsed.data;
  const { entrants } = config;
  const initialRosters = readFranchiseRosterVersion(runDir, 0);
  const draftCheckpoints = readFranchiseCheckpoints(runDir, "draft", 0);
  const draftComplete =
    initialRosters.length === entrants.length && draftCheckpoints.length === entrants.length;
  if (config.draft_only && config.transactions !== null) {
    throw new Error(`${runDir} draft-only config must record null transactions`);
  }
  return {
    config,
    draftComplete,
    entrants,
    teamNames: initialRosters.map((roster) => roster.teamName),
    rosterIds: initialRosters.map((roster) => roster.roster.map((mon) => mon.id)),
    draftNotes: draftCheckpoints.map((checkpoint) => checkpoint.memory.notebook ?? ""),
    transactions: config.draft_only
      ? undefined
      : (config.transactions ?? []).map((window) => ({
          afterWeek: window.after_week,
          tradesAllowed: window.trades_allowed,
        })),
    swapsAllowed: config.swaps_allowed,
  };
}
