import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildLeague, buildLeagueGame } from './archive.js';
import { describeBoardMon, loadBoard } from './draft.js';
import { buildDraftLeagueSchedule } from './draftleague.js';
import { SAFE_SEGMENT } from './path-safety.js';
import { buildPublicSeasonBundle, type PublicSeasonGameInput } from './public/season-bundle.js';
import type { PublicSeasonBundle } from './public/season-protocol.js';
import { loadSeriesRecords } from './records.js';
import { showdownCommit as currentShowdownCommit } from './showdown.js';

export interface ExportSeasonOptions {
  out: string;
  recordsPath: string;
  runsDir: string;
  runId: string;
  title: string;
  releasedThroughWeek: number;
  generatedAt?: string;
}

interface StoredLeagueConfig {
  seed: number;
  closedSheets: boolean;
  showdownCommit: string | null;
}

function storedLeagueConfig(runsDir: string, runId: string): StoredLeagueConfig {
  const file = path.join(runsDir, runId, 'config.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (typeof value.seed !== 'number' || !Number.isSafeInteger(value.seed)) {
    throw new Error(`league ${runId} has no valid schedule seed`);
  }
  if (typeof value.closed_sheets !== 'boolean') throw new Error(`league ${runId} has no team-sheet policy`);
  let showdownCommit: string | null;
  if (Object.hasOwn(value, 'showdown_commit')) {
    const stored = value.showdown_commit;
    if (typeof stored !== 'string' && stored !== null) {
      throw new Error(`league ${runId} has an invalid frozen Showdown commit`);
    }
    showdownCommit = stored;
  } else {
    try {
      showdownCommit = currentShowdownCommit();
    } catch {
      showdownCommit = null;
    }
  }
  return { seed: value.seed, closedSheets: value.closed_sheets, showdownCommit };
}

export function exportSeasonBundle(options: ExportSeasonOptions): PublicSeasonBundle {
  if (!SAFE_SEGMENT.test(options.runId)) throw new Error(`invalid run id ${JSON.stringify(options.runId)}`);
  const rows = loadSeriesRecords(options.recordsPath);
  const league = buildLeague(rows, options.runsDir, options.runId);
  if (!league) throw new Error(`no draft league archive found for ${options.runId}`);
  if (!league.board) throw new Error(`league ${options.runId} has no draft board`);
  const config = storedLeagueConfig(options.runsDir, options.runId);
  const schedule = buildDraftLeagueSchedule(league.franchises.length, config.seed);
  const board = loadBoard(league.board);
  const boardView = board.mons.map((mon) => describeBoardMon(mon, undefined, board.format));
  const totalWeeks = league.weeks ?? 0;
  const games = new Map<string, PublicSeasonGameInput[]>();
  for (const series of league.series) {
    const releasedRound = series.stage === 'roundrobin' ? series.round : totalWeeks + series.round;
    if (releasedRound > options.releasedThroughWeek || series.winner === null) continue;
    games.set(
      series.seriesId,
      series.games.map((_, gameIndex) => {
        const game = buildLeagueGame(rows, options.runsDir, options.runId, series.seriesIndex, gameIndex + 1);
        if (!game) throw new Error(`released series ${series.seriesId} game ${gameIndex + 1} has no verified replay`);
        return game;
      }),
    );
  }
  const bundle = buildPublicSeasonBundle({
    league,
    plans: schedule.plans,
    board: boardView,
    games,
    title: options.title,
    releasedThroughWeek: options.releasedThroughWeek,
    closedSheets: config.closedSheets,
    showdownCommit: config.showdownCommit,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  const directory = path.dirname(options.out);
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const bundleStaged = `${options.out}.${suffix}`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(bundleStaged, `${JSON.stringify(bundle)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(bundleStaged, options.out);
  } finally {
    fs.rmSync(bundleStaged, { force: true });
  }
  return bundle;
}
