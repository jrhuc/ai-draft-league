import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { DraftBoard, DraftBoardMon } from './draft.js';
import { snakeOrder } from './draft.js';
import type { DraftPickView, TeambuildView } from './gui/api.js';
import { appendJsonlObject, readJsonlObjects } from './jsonl.js';
import { seededRng, shuffle } from './random.js';
import type { SeriesRecord } from './records.js';
import { loadSeriesRecords } from './records.js';
import { harnessCommit } from './showdown.js';
import {
  decodeTeamBuildJournalRow,
  replayTeamBuildArtifact,
  type TeamBuildArtifact,
  type TeamBuildJournalEntry,
  type TeamBuildSheetPolicy,
} from './teambuild.js';
import { MAX_TRADE_OFFERS, type TransactionSchedule } from './trade-window.js';
import type { ContributorAttribution, Pid, TimerScale } from './types.js';

export interface StoredLeague {
  config: Record<string, unknown>;
  configBytes: string;
  entrants: string[];
  teamNames: string[];
  rosterIds: string[][];
  draftNotes: string[];
  sequentialWeeks: boolean;
  transactions: TransactionSchedule | undefined;
  swapsAllowed: number;
  preset: string | null;
}
const DRAFT_CONFIG_FIELDS = [
  'mode',
  'harness_commit',
  'showdown_commit',
  'models',
  'entrants',
  'seed',
  'board',
  'format',
  'concurrency',
  'reasoning',
  'reasoning_by_model',
  'timer_scale',
  'closed_sheets',
  'sequential_weeks',
  'draft_only',
  'preset',
  'transactions',
  'swaps_allowed',
  'team_names',
  'weeks',
  'rosters',
  'draft_notes',
  'contributor',
] as const;

export interface StoredLeaguePlan {
  index: number;
  stage: 'roundrobin' | 'playoff';
  round: number;
  engineSeeds: Record<Pid, number>;
}

export interface StoredLeagueRows {
  all: SeriesRecord[];
  roundRobin: Map<number, SeriesRecord>;
  playoffs: Map<number, SeriesRecord>;
}

export interface DraftLeagueConfig {
  runDir: string;
  showdownCommit: string;
  models: readonly string[];
  entrants: readonly string[];
  seed: number;
  concurrency: number;
  reasoning: unknown;
  reasoningByModel: unknown;
  timerScale: TimerScale;
  board: Pick<DraftBoard, 'id' | 'format'>;
  sequentialWeeks: boolean;
  closedSheets: boolean;
  draftOnly: boolean;
  preset: string | null;
  transactions: Array<{ after_week: number; trades_allowed: number }> | null;
  swapsAllowed: number;
  teamNames: readonly string[];
  weeks: number;
}
export interface DraftLeagueCompletion {
  rosters: string[][];
  draft_notes: string[];
  contributor: ContributorAttribution | null;
}

export function writeDraftLeagueConfig(config: DraftLeagueConfig, outcome: Partial<DraftLeagueCompletion> = {}): void {
  fs.writeFileSync(
    path.join(config.runDir, 'config.json'),
    `${JSON.stringify(
      {
        mode: 'draft',
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
        sequential_weeks: config.sequentialWeeks,
        draft_only: config.draftOnly,
        preset: config.preset,
        transactions: config.transactions,
        swaps_allowed: config.swapsAllowed,
        team_names: config.teamNames,
        weeks: config.weeks,
        ...outcome,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export function writeDraftLeagueRosters(
  runDir: string,
  boardBudget: number,
  entrants: readonly string[],
  teamNames: readonly string[],
  budgets: readonly number[],
  rosters: readonly (readonly DraftBoardMon[])[],
): void {
  fs.writeFileSync(
    path.join(runDir, 'rosters.json'),
    `${JSON.stringify(
      entrants.map((model, entrant) => ({
        entrant,
        model,
        team_name: teamNames[entrant],
        budget_left: budgets[entrant],
        spent: boardBudget - budgets[entrant]!,
        roster: rosters[entrant]!.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
      })),
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export function loadStoredCoaching(
  runDir: string,
  entrants: number,
): {
  playoffContext: Array<Map<number, string>>;
  reflectionNotes: Array<Map<number, string>>;
} {
  const playoffContext = Array.from({ length: entrants }, () => new Map<number, string>());
  const reflectionNotes = Array.from({ length: entrants }, () => new Map<number, string>());
  for (const row of readJsonlObjects(path.join(runDir, 'coaching.jsonl'))) {
    const entrant = Number(row.entrant);
    const seriesIndex = Number(row.series_index);
    if (
      Number.isInteger(entrant) &&
      playoffContext[entrant] &&
      Number.isInteger(seriesIndex) &&
      typeof row.context === 'string'
    ) {
      playoffContext[entrant].set(seriesIndex, row.context);
      if (typeof row.notebook === 'string') reflectionNotes[entrant]!.set(seriesIndex, row.notebook);
    }
  }
  return { playoffContext, reflectionNotes };
}

export function appendStoredCoaching(
  runDir: string,
  row: { series_index: number; entrant: number; context: string; notebook: string },
): void {
  appendJsonlObject(path.join(runDir, 'coaching.jsonl'), row);
}

export function loadStoredPicks(runDir: string, entrants: number, board: DraftBoard): DraftPickView[] {
  const rows = [...readJsonlObjects(path.join(runDir, 'draft', 'draft.jsonl'))].sort(
    (a, b) => Number(a.pick) - Number(b.pick),
  );
  const order = snakeOrder(entrants, board.picks);
  return rows.flatMap((row, index) => {
    const entrant = order[index];
    if (entrant === undefined || typeof row.mon !== 'string') return [];
    return [
      {
        pick: Number(row.pick),
        entrant,
        mon: row.mon,
        rationale: typeof row.rationale === 'string' ? row.rationale : '',
        fallback: row.fallback === true,
      },
    ];
  });
}

export function loadStoredLeagueRows(
  recordsPath: string,
  runId: string,
  plans: readonly StoredLeaguePlan[],
  boardId: string,
  seed: number,
): StoredLeagueRows {
  const all: SeriesRecord[] = [];
  const roundRobin = new Map<number, SeriesRecord>();
  const playoffs = new Map<number, SeriesRecord>();
  const seen = new Set<number>();
  for (const row of loadSeriesRecords(recordsPath)) {
    if (row.run_id !== runId || row.mode !== 'draft') continue;
    const seriesIndex = row.series_index;
    const plan = Number.isSafeInteger(seriesIndex) ? plans[seriesIndex as number] : undefined;
    if (!plan || plan.stage !== row.stage || plan.round !== row.round) {
      throw new Error(
        `run ${runId} series ${String(seriesIndex)} does not match the rebuilt schedule; it cannot resume`,
      );
    }
    if (seen.has(plan.index)) throw new Error(`run ${runId} repeats scheduled series ${plan.index}; it cannot resume`);
    seen.add(plan.index);
    if (row.board !== boardId || row.run_seed !== seed || !isDeepStrictEqual(row.engine_seeds, plan.engineSeeds)) {
      throw new Error(`run ${runId} series ${plan.index} is not bound to its scheduled entropy and board`);
    }
    if (plan.stage === 'roundrobin') roundRobin.set(plan.index, row);
    else playoffs.set(plan.index, row);
    all.push(row);
  }
  return { all, roundRobin, playoffs };
}

export function draftOnlyPromotionEvidence(runDir: string, rows: readonly SeriesRecord[]): string[] {
  const evidence = rows.length ? ['stored results'] : [];
  for (const relative of ['teambuild/teambuild.jsonl', 'coaching.jsonl', 'season.jsonl']) {
    try {
      if (fs.statSync(path.join(runDir, relative)).size > 0) evidence.push(relative);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  for (const directory of ['series', 'reviews']) {
    try {
      if (fs.readdirSync(path.join(runDir, directory)).length) evidence.push(`${directory}/`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  return evidence;
}

export function postWindowEvidence(
  runDir: string,
  rows: readonly SeriesRecord[],
  plans: readonly Pick<StoredLeaguePlan, 'index' | 'stage' | 'round'>[],
  afterWeek: number,
): string[] {
  const pastBarrier = new Set(
    plans.filter((plan) => plan.stage === 'playoff' || plan.round > afterWeek).map((plan) => plan.index),
  );
  const evidence = rows
    .filter((row) => pastBarrier.has(row.series_index as number))
    .map((row) => `result series ${String(row.series_index)}`);
  const teambuildFile = path.join(runDir, 'teambuild', 'teambuild.jsonl');
  for (const [index, row] of readJsonlObjects(teambuildFile).entries()) {
    const { seriesIndex } = decodeTeamBuildJournalRow(row, `${teambuildFile} line ${index + 1}`).view;
    if (pastBarrier.has(seriesIndex)) evidence.push(`teambuild/teambuild.jsonl series ${seriesIndex}`);
  }
  for (const row of readJsonlObjects(path.join(runDir, 'coaching.jsonl'))) {
    if (pastBarrier.has(row.series_index as number)) evidence.push(`coaching.jsonl series ${String(row.series_index)}`);
  }
  const seriesRoot = path.join(runDir, 'series');
  let seriesDirectories: string[] = [];
  try {
    seriesDirectories = fs.readdirSync(seriesRoot);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  for (const directory of seriesDirectories) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(seriesRoot, directory, 'series.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const identity =
      meta.schema_version === 3 &&
      typeof meta.identity === 'object' &&
      meta.identity !== null &&
      !Array.isArray(meta.identity)
        ? (meta.identity as Record<string, unknown>)
        : undefined;
    const seriesIndex = identity?.series_index;
    if (typeof seriesIndex === 'number' && pastBarrier.has(seriesIndex)) evidence.push(`series/${directory}`);
  }
  if (readJsonlObjects(path.join(runDir, 'season.jsonl')).length) evidence.push('season.jsonl');
  let reviewFiles: string[] = [];
  try {
    reviewFiles = fs.readdirSync(path.join(runDir, 'reviews'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  for (const file of reviewFiles) {
    const match = /^week-(\d+)\.jsonl$/u.exec(file);
    if (match && Number(match[1]) > afterWeek && readJsonlObjects(path.join(runDir, 'reviews', file)).length) {
      evidence.push(`reviews/${file}`);
    }
  }
  return [...new Set(evidence)];
}

export function requireTransactionResultPrefix(
  runId: string,
  rows: readonly SeriesRecord[],
  plans: readonly Pick<StoredLeaguePlan, 'index' | 'stage' | 'round'>[],
  afterWeek: number,
): void {
  const expected = plans.filter((plan) => plan.stage === 'roundrobin' && plan.round <= afterWeek);
  if (rows.length < expected.length) {
    throw new Error(
      `run ${runId} transaction artifacts have only ${rows.length} results before a ${expected.length}-series pre-window barrier`,
    );
  }
  const expectedIndexes = new Set(expected.map((plan) => plan.index));
  const prefix = rows.slice(0, expected.length);
  const crossed = prefix.find((row) => !expectedIndexes.has(row.series_index as number));
  if (crossed) {
    throw new Error(
      `run ${runId} later-round series ${String(crossed.series_index)} crosses the transaction barrier before the exact pre-window result prefix`,
    );
  }
  const prefixIndexes = new Set(prefix.map((row) => row.series_index as number));
  const missing = expected.filter((plan) => !prefixIndexes.has(plan.index));
  if (missing.length || prefixIndexes.size !== expected.length) {
    throw new Error(
      `run ${runId} transaction artifacts lack the exact pre-window result prefix; missing scheduled series ${missing.map((plan) => plan.index).join(', ') || 'none'}`,
    );
  }
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

export function promoteDraftOnlyConfig(
  runDir: string,
  stored: StoredLeague,
  transactions: Array<{ after_week: number; trades_allowed: number }>,
): void {
  const configPath = path.join(runDir, 'config.json');
  if (fs.readFileSync(configPath, 'utf8') !== stored.configBytes) {
    throw new Error(`${configPath} changed while its draft-only promotion was being validated`);
  }
  const activeConfig = Object.fromEntries(
    DRAFT_CONFIG_FIELDS.flatMap((field) =>
      Object.hasOwn(stored.config, field) ? [[field, stored.config[field]]] : [],
    ),
  );
  const nextConfig = { ...activeConfig, draft_only: false, transactions };
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function linkedStoredArtifact(
  entry: TeamBuildJournalEntry,
  context: {
    model: string;
    opponentModel: string;
    format: string;
    psDir: string;
    sheetPolicy: TeamBuildSheetPolicy;
    stage: 'roundrobin' | 'playoff';
    seriesIndex: number;
    entrant: number;
    opponent: number;
    rosterIds: string[];
    opponentRosterIds: string[];
  },
): { packed: string; view: TeambuildView } | undefined {
  let replayed: { artifact: TeamBuildArtifact; packed: string };
  try {
    replayed = replayTeamBuildArtifact(entry.artifact, { psDir: context.psDir });
  } catch {
    return undefined;
  }
  const artifact = replayed.artifact;
  const task = artifact.task;
  if (
    artifact.executionPolicy !== 'league-resilient' ||
    task.executionPolicy !== 'league-resilient' ||
    task.model !== context.model ||
    task.format !== context.format ||
    task.sheetPolicy !== context.sheetPolicy ||
    task.constraint.kind !== 'draft-picks' ||
    task.objective.kind !== 'matchup' ||
    task.objective.stage !== context.stage ||
    task.objective.opponent.model !== context.opponentModel ||
    task.provenance.source !== 'draft-league' ||
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

export function loadStoredTeambuilds(teambuildDir: string): Map<string, TeamBuildJournalEntry[]> {
  const rowsBySeries = new Map<string, TeamBuildJournalEntry[]>();
  const file = path.join(teambuildDir, 'teambuild.jsonl');
  for (const [index, row] of readJsonlObjects(file).entries()) {
    const entry = decodeTeamBuildJournalRow(row, `${file} line ${index + 1}`);
    const { seriesIndex, entrant } = entry.view;
    const key = `${seriesIndex}:${entrant}`;
    const stored = rowsBySeries.get(key) ?? [];
    stored.push(entry);
    rowsBySeries.set(key, stored);
  }
  return rowsBySeries;
}

export function loadStoredLeague(runDir: string): StoredLeague | undefined {
  const configPath = path.join(runDir, 'config.json');
  let configBytes: string;
  try {
    configBytes = fs.readFileSync(configPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${runDir} holds no draft league config to resume`);
    throw cause;
  }
  const parsed = JSON.parse(configBytes) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${runDir} draft league config must be one object`);
  }
  const config = parsed as Record<string, unknown>;
  if (config.mode !== 'draft') throw new Error(`${runDir} is not a draft league run`);
  if (!Object.hasOwn(config, 'rosters')) return undefined;
  if (
    !Array.isArray(config.entrants) ||
    config.entrants.length < 2 ||
    config.entrants.some((model) => typeof model !== 'string') ||
    !Array.isArray(config.team_names) ||
    config.team_names.length !== config.entrants.length ||
    config.team_names.some((name) => typeof name !== 'string') ||
    !Array.isArray(config.rosters) ||
    config.rosters.length !== config.entrants.length ||
    config.rosters.some(
      (roster) => !Array.isArray(roster) || roster.some((id) => typeof id !== 'string' || id.length === 0),
    ) ||
    !Array.isArray(config.draft_notes) ||
    config.draft_notes.length !== config.entrants.length ||
    config.draft_notes.some((note) => typeof note !== 'string') ||
    typeof config.sequential_weeks !== 'boolean' ||
    typeof config.draft_only !== 'boolean' ||
    !Number.isSafeInteger(config.swaps_allowed)
  ) {
    throw new Error(`${runDir} is not a structurally complete drafted-league config`);
  }
  let transactions: TransactionSchedule | undefined;
  if (config.draft_only) {
    if (config.transactions !== null) throw new Error(`${runDir} draft-only config must record null transactions`);
    transactions = undefined;
  } else {
    if (!Array.isArray(config.transactions))
      throw new Error(`${runDir} season config has an invalid transaction schedule`);
    transactions = config.transactions.map((window) => {
      if (typeof window !== 'object' || window === null || Array.isArray(window)) {
        throw new Error(`${runDir} season config has an invalid transaction window`);
      }
      const record = window as Record<string, unknown>;
      if (
        !Number.isSafeInteger(record.after_week) ||
        Number(record.after_week) < 1 ||
        !Number.isSafeInteger(record.trades_allowed) ||
        Number(record.trades_allowed) < 0 ||
        Number(record.trades_allowed) > MAX_TRADE_OFFERS
      ) {
        throw new Error(`${runDir} season config has an invalid transaction window`);
      }
      return { afterWeek: Number(record.after_week), tradesAllowed: Number(record.trades_allowed) };
    });
  }
  return {
    config,
    configBytes,
    entrants: config.entrants as string[],
    teamNames: config.team_names as string[],
    rosterIds: config.rosters as string[][],
    draftNotes: config.draft_notes as string[],
    sequentialWeeks: config.sequential_weeks,
    transactions,
    swapsAllowed: config.swaps_allowed as number,
    preset: typeof config.preset === 'string' ? config.preset : null,
  };
}
