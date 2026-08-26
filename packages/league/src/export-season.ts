import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { buildLeague, buildLeagueGame } from "./archive.js";
import { writeAtomicJson } from "./atomic-json.js";
import { describeBoardMon, loadBoard } from "./draft.js";
import { buildDraftLeagueSchedule, type DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import {
  type BuildPublicSeasonBundleOptions,
  buildPublicSeasonBundle,
  type PublicSeasonGameInput,
} from "./public/season-bundle.js";
import type { PublicSeasonBundle } from "./public/season-protocol.js";
import { loadSeriesRecords } from "./records.js";
import { showdownCommit as currentShowdownCommit } from "./showdown.js";

export interface ExportSeasonOptions {
  out: string;
  recordsPath: string;
  runsDir: string;
  runId: string;
  title: string;
  /** "all" releases every played series — live watching only, never publication. */
  releasedThroughWeek: number | "all";
  generatedAt?: string;
}

interface StoredLeagueConfig {
  seed: number;
  closedSheets: boolean;
  showdownCommit: string | null;
}

function storedLeagueConfig(runsDir: string, runId: string): StoredLeagueConfig {
  const file = path.join(runsDir, runId, "config.json");
  const parsed = z
    .record(z.string(), z.json())
    .safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`league ${runId} has no valid schedule seed`);
  const seed = z.number().safeParse(parsed.data.seed);
  if (!seed.success || !Number.isSafeInteger(seed.data)) {
    throw new Error(`league ${runId} has no valid schedule seed`);
  }
  const closedSheets = z.boolean().safeParse(parsed.data.closed_sheets);
  if (!closedSheets.success) throw new Error(`league ${runId} has no team-sheet policy`);
  let showdownCommit: string | null;
  if (Object.hasOwn(parsed.data, "showdown_commit")) {
    const stored = z.union([z.string(), z.null()]).safeParse(parsed.data.showdown_commit);
    if (!stored.success) {
      throw new Error(`league ${runId} has an invalid frozen Showdown commit`);
    }
    showdownCommit = stored.data;
  } else {
    try {
      showdownCommit = currentShowdownCommit();
    } catch {
      showdownCommit = null;
    }
  }
  return { seed: seed.data, closedSheets: closedSheets.data, showdownCommit };
}

function lastCompleteRound(
  series: { seriesIndex: number }[],
  plans: DraftLeagueSeriesPlan[],
  totalWeeks: number,
  playoffRounds: number,
): number {
  const finished = new Set(series.map((row) => row.seriesIndex));
  const planRound = (plan: DraftLeagueSeriesPlan): number =>
    plan.stage === "roundrobin" ? plan.round : totalWeeks + plan.round;
  let released = 0;
  for (let round = 1; round <= totalWeeks + playoffRounds; round += 1) {
    const complete = plans
      .filter((plan) => planRound(plan) === round)
      .every((plan) => finished.has(plan.index));
    if (!complete) break;
    released = round;
  }
  return released;
}

export function buildSeasonExport(options: Omit<ExportSeasonOptions, "out">): PublicSeasonBundle {
  if (!SAFE_SEGMENT.test(options.runId))
    throw new Error(`invalid run id ${JSON.stringify(options.runId)}`);
  const rows = loadSeriesRecords(options.recordsPath);
  const league = buildLeague(rows, options.runsDir, options.runId);
  if (!league) throw new Error(`no draft league archive found for ${options.runId}`);
  if (!league.board) throw new Error(`league ${options.runId} has no draft board`);
  const config = storedLeagueConfig(options.runsDir, options.runId);
  const schedule = buildDraftLeagueSchedule(league.franchises.length, config.seed);
  const board = loadBoard(league.board);
  const boardView = board.mons.map((mon) => describeBoardMon(mon, undefined, board.format));
  const totalWeeks = league.weeks ?? 0;
  const releasedThroughWeek =
    options.releasedThroughWeek === "all"
      ? lastCompleteRound(league.series, schedule.plans, totalWeeks, schedule.playoffRounds)
      : options.releasedThroughWeek;
  const games = new Map<string, PublicSeasonGameInput[]>();
  for (const series of league.series) {
    const releasedRound = series.stage === "roundrobin" ? series.round : totalWeeks + series.round;
    if (releasedRound > releasedThroughWeek) continue;
    games.set(
      series.seriesId,
      series.games.map((_, gameIndex) => {
        const game = buildLeagueGame(
          rows,
          options.runsDir,
          options.runId,
          series.seriesIndex,
          gameIndex + 1,
        );
        if (!game)
          throw new Error(
            `released series ${series.seriesId} game ${gameIndex + 1} has no verified replay`,
          );
        return game;
      }),
    );
  }
  const bundleOptions: BuildPublicSeasonBundleOptions = {
    league,
    plans: schedule.plans,
    board: boardView,
    games,
    title: options.title,
    releasedThroughWeek,
    closedSheets: config.closedSheets,
    showdownCommit: config.showdownCommit,
    generatedAt: options.generatedAt,
  };
  return buildPublicSeasonBundle(bundleOptions);
}

export function exportSeasonBundle(options: ExportSeasonOptions): PublicSeasonBundle {
  const bundle = buildSeasonExport(options);
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  writeAtomicJson(options.out, bundle);
  return bundle;
}
