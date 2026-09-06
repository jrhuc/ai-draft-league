import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";

import { buildLeague, buildLeagueGame } from "./archive.js";
import { writeAtomicBytes, writeAtomicJson } from "./atomic-json.js";
import { readGameDecisionTraces } from "./decision-traces.js";
import { describeBoardMon, loadBoard } from "./draft.js";
import { buildDraftLeagueSchedule, type DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import {
  type BuildPublicSeasonBundleOptions,
  buildPublicSeasonBundle,
  type PublicSeasonGameInput,
} from "./public/season-bundle.js";
import {
  type PublicGameTraces,
  publicGameTracesSchema,
  type PublicSeasonBundle,
  type PublicTracesManifest,
  publicTracesManifestSchema,
} from "./public/season-protocol.js";
import { loadSeriesRecords } from "./records.js";
import { showdownCommit as currentShowdownCommit } from "./showdown.js";

export interface ExportSeasonOptions {
  out: string;
  tracesDir: string;
  recordsPath: string;
  runsDir: string;
  runId: string;
  title: string;
  /** "all" releases every played series — live watching only, never publication. */
  releasedThroughWeek: number | "all";
  generatedAt?: string;
}

export interface SeasonExport {
  bundle: PublicSeasonBundle;
  traces: ReadonlyMap<string, readonly PublicGameTraces[]>;
  manifest: PublicTracesManifest;
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

export function buildSeasonExport(
  options: Omit<ExportSeasonOptions, "out" | "tracesDir">,
): SeasonExport {
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
  const traces = new Map<string, PublicGameTraces[]>();
  for (const series of league.series) {
    const releasedRound = series.stage === "roundrobin" ? series.round : totalWeeks + series.round;
    if (releasedRound > releasedThroughWeek) continue;
    const seriesDir = path.join(options.runsDir, options.runId, "series", series.seriesId);
    const franchises: [string, string] = [
      `franchise-${series.sides[0]}`,
      `franchise-${series.sides[1]}`,
    ];
    const seriesTraces: PublicGameTraces[] = [];
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
        const gameTraces = publicGameTracesSchema.parse({
          runId: options.runId,
          seriesId: series.seriesId,
          game: gameIndex + 1,
          franchises,
          decisions: readGameDecisionTraces(seriesDir, gameIndex + 1, franchises, game.decisions),
        });
        seriesTraces.push(gameTraces);
        return { ...game, traces: gameTraces.decisions };
      }),
    );
    traces.set(series.seriesId, seriesTraces);
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
  const bundle = buildPublicSeasonBundle(bundleOptions);
  const manifest = publicTracesManifestSchema.parse({
    runId: options.runId,
    generatedAt: bundle.generatedAt,
    archive: `${options.runId}.jsonl.gz`,
    digests: Object.fromEntries(
      [...traces].map(([seriesId, games]) => [
        seriesId,
        Object.fromEntries(
          games.map((game) => [
            game.game,
            createHash("sha256").update(JSON.stringify(game)).digest("hex"),
          ]),
        ),
      ]),
    ),
  });
  return { bundle, traces, manifest };
}

export function exportSeasonBundle(options: ExportSeasonOptions): SeasonExport {
  const exported = buildSeasonExport(options);
  const tracesDir = options.tracesDir;
  const archiveLines: string[] = [];
  for (const [seriesId, games] of exported.traces) {
    fs.mkdirSync(path.join(tracesDir, seriesId), { recursive: true });
    for (const game of games) {
      writeAtomicJson(path.join(tracesDir, seriesId, `game-${game.game}.json`), game);
      for (const [index, decision] of game.decisions.entries()) {
        if (decision)
          archiveLines.push(JSON.stringify({ seriesId, game: game.game, index, ...decision }));
      }
    }
  }
  fs.mkdirSync(tracesDir, { recursive: true });
  writeAtomicBytes(
    path.join(tracesDir, exported.manifest.archive),
    gzipSync(archiveLines.map((line) => `${line}\n`).join(""), { level: 9 }),
  );
  writeAtomicJson(path.join(tracesDir, "manifest.json"), exported.manifest);
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  writeAtomicJson(options.out, exported.bundle);
  return exported;
}
