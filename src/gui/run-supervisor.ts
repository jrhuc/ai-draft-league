import path from 'node:path';
import type { DraftLeagueEvent } from '../draftleague.js';
import { runDraftLeague } from '../draftleague.js';
import { makeRunDirectory, RESULTS_PATH } from '../paths.js';
import { classifyProviderFailure } from '../providers.js';
import { runRotation } from '../rotation.js';
import { snapshotBattle } from '../run-artifacts.js';
import { writeRunStatus } from '../run-status.js';
import { redactSecrets } from '../sanitize.js';
import { BattleState } from '../state.js';
import { runTournament } from '../tournament.js';
import type { Pid } from '../types.js';
import type { BattleMessage, BracketView, DecisionView, DraftView, RunSnapshot, SeriesRowView } from './api.js';
import { BattleLog } from './battlelog.js';
import type { ParsedRunRequest, RunConfig } from './run-request.js';

type SeriesRow = Omit<SeriesRowView, 'turn'>;

const SHUTDOWN_ERROR = 'run interrupted by server shutdown';

interface GameBattle {
  state: BattleState;
  log: BattleLog;
}

class ActiveRun {
  rows: SeriesRow[] = [];
  bracket: BracketView | undefined;
  draft: DraftView | undefined;
  state: RunSnapshot['state'] = 'running';
  error = '';
  notices: string[] = [];
  seed: number | undefined;
  endTime: number | undefined;
  interrupted = false;
  userStopped = false;
  readonly battles = new Map<number, Map<number, GameBattle>>();
  readonly decisions = new Map<number, DecisionView[]>();
  readonly spend = new Map<number, Record<Pid, { ms: number; tokens: number }>>();
  readonly battleRevisions = new Map<number, number>();
  readonly controller = new AbortController();
  readonly runDir: string;
  readonly runId: string;
  readonly startTime = Date.now();

  constructor(
    readonly config: RunConfig,
    readonly apiKeys: Record<string, string>,
    runsDir?: string,
  ) {
    this.runDir = makeRunDirectory(runsDir);
    this.runId = path.basename(this.runDir);
  }

  clearApiKeys(): void {
    for (const model of Object.keys(this.apiKeys)) delete this.apiKeys[model];
  }
}

export interface RunSupervisorOptions {
  recordsPath?: string;
  runsDir?: string;
  runner?: typeof runRotation;
  tournamentRunner?: typeof runTournament;
  draftRunner?: typeof runDraftLeague;
  logger?: (entry: Record<string, unknown>) => void;
  onRunChange: () => void;
  onBattleChange: (index: number) => void;
}

function isRunning(run: ActiveRun | undefined): run is ActiveRun {
  return run !== undefined && run.state === 'running';
}

function latestBattle(games: Map<number, GameBattle> | undefined): { game: number; entry: GameBattle } | null {
  if (!games?.size) return null;
  const game = Math.max(...games.keys());
  return { game, entry: games.get(game) as GameBattle };
}

/** Runs one league at a time and forwards user or shutdown cancellation through its AbortSignal. */
export class RunSupervisor {
  private run: ActiveRun | undefined;
  private runTask: Promise<void> | undefined;

  constructor(private readonly options: RunSupervisorOptions) {}

  canStart(): boolean {
    return !isRunning(this.run);
  }

  hasActiveRun(): boolean {
    return isRunning(this.run);
  }

  apiKeySecrets(): string[] {
    return Object.values(this.run?.apiKeys ?? {});
  }

  start(request: ParsedRunRequest): { ok: true; runId: string } {
    if (!this.canStart()) throw new Error('a run is already in progress');
    const run = new ActiveRun(request.config, request.apiKeys, this.options.runsDir);
    this.run = run;
    writeRunStatus(run.runDir, {
      state: 'running',
      error: null,
      notices: [],
      start_time: new Date(run.startTime).toISOString(),
      end_time: null,
      pid: process.pid,
    });
    this.runTask = this.launch(run);
    this.options.onRunChange();
    return { ok: true, runId: run.runId };
  }

  stop(): void {
    const run = this.run;
    if (!isRunning(run)) return;
    run.userStopped = true;
    run.controller.abort();
  }

  beginShutdown(): Promise<void> | undefined {
    const run = this.run;
    if (isRunning(run)) {
      run.interrupted = true;
      run.controller.abort();
    }
    return this.runTask;
  }

  snapshot(): RunSnapshot | null {
    const run = this.run;
    if (!run) return null;
    const rows = run.rows.map((row, index) => ({
      ...row,
      players: { ...row.players },
      score: { ...row.score },
      turn: latestBattle(run.battles.get(index))?.entry.state.turn ?? 0,
    }));
    return {
      mode: run.config.mode,
      runId: run.runId,
      state: run.state,
      error: run.error,
      notices: run.notices.slice(-3),
      seed: run.seed ?? null,
      pool: run.config.pool,
      models: run.config.models,
      startTime: run.startTime,
      endTime: run.endTime ?? null,
      canControl: true,
      rows,
      bracket: run.bracket ?? null,
      draft: run.draft ?? null,
      board: run.config.board ?? null,
    };
  }

  battle(index: number, game?: number): BattleMessage {
    const games = this.run?.battles.get(index);
    const latest = latestBattle(games);
    if (!games || !latest) return { index, game: 0, games: [], revision: 0, snapshot: null };
    const shown = game !== undefined && games.has(game) ? game : latest.game;
    const entry = games.get(shown) as GameBattle;
    const decisions = (this.run?.decisions.get(index) ?? []).filter((decision) => decision.game === shown);
    return {
      index,
      game: shown,
      games: [...games.keys()].sort((a, b) => a - b),
      revision: this.run?.battleRevisions.get(index) ?? 0,
      snapshot: snapshotBattle(
        entry.state,
        this.run?.rows[index]?.players,
        entry.log.entries,
        decisions,
        this.run?.spend.get(index),
      ),
    };
  }

  private settleRun(run: ActiveRun, failed: boolean, error?: unknown): void {
    if (run.interrupted) {
      run.state = 'failed';
      run.error = SHUTDOWN_ERROR;
    } else if (run.userStopped) {
      run.state = 'stopped';
    } else if (failed) {
      run.state = 'failed';
      run.error = redactSecrets(error instanceof Error ? error.message : String(error), Object.values(run.apiKeys));
    } else {
      run.state = 'done';
    }
  }

  private async launch(run: ActiveRun): Promise<void> {
    const commonOptions = {
      concurrency: run.config.concurrency,
      recordsPath: this.options.recordsPath ?? RESULTS_PATH,
      apiKeys: run.apiKeys,
      signal: run.controller.signal,
      ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
      ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
      ...(run.config.reasoningByModel === undefined ? {} : { reasoningByModel: run.config.reasoningByModel }),
      ...(run.config.timerScale === undefined ? {} : { timerScale: run.config.timerScale }),
      onEvent: (event: DraftLeagueEvent) => this.onEvent(run, event),
    };
    try {
      if (run.config.mode === 'draft') {
        await (this.options.draftRunner ?? runDraftLeague)(run.config.models, run.runDir, {
          ...commonOptions,
          ...(run.config.board === undefined ? {} : { board: run.config.board }),
          ...(run.config.closedSheets === true ? { closedSheets: true } : {}),
          ...(run.config.sequentialWeeks === true ? { sequentialWeeks: true } : {}),
          ...(run.config.transactions === undefined ? {} : { transactions: run.config.transactions }),
          ...(run.config.draftOnly === true ? { draftOnly: true } : {}),
        });
      } else if (run.config.mode === 'tournament') {
        await (this.options.tournamentRunner ?? runTournament)(run.config.models, run.runDir, {
          ...commonOptions,
          ...(run.config.pool ? { pool: run.config.pool } : {}),
          ...(run.config.teams === undefined ? {} : { teams: run.config.teams }),
          ...(run.config.format === undefined ? {} : { format: run.config.format }),
          ...(run.config.provenance === undefined ? {} : { provenance: run.config.provenance }),
        });
      } else {
        await (this.options.runner ?? runRotation)(run.config.models, run.config.seriesPerPair, run.runDir, {
          ...commonOptions,
          pool: run.config.pool,
          onNotice: (message) => run.notices.push(message),
        });
      }
      this.settleRun(run, false);
    } catch (error) {
      this.settleRun(run, true, error);
    } finally {
      run.clearApiKeys();
      run.endTime = Date.now();
      this.persistStatus(run);
      this.options.logger?.({
        timestamp: new Date().toISOString(),
        level: run.state === 'failed' ? 'error' : 'info',
        event: 'run_finished',
        runId: run.runId,
        state: run.state,
        durationMs: run.endTime - run.startTime,
      });
      this.options.onRunChange();
    }
  }

  private persistStatus(run: ActiveRun): void {
    run.endTime ??= Date.now();
    writeRunStatus(run.runDir, {
      state: run.state,
      error: run.error || null,
      notices: run.notices,
      start_time: new Date(run.startTime).toISOString(),
      end_time: new Date(run.endTime ?? Date.now()).toISOString(),
    });
  }

  private onEvent(run: ActiveRun, event: DraftLeagueEvent): void {
    if (run !== this.run) return;
    if (event.type === 'draft') {
      run.draft = event.draft;
    } else if (event.type === 'bracket') {
      run.bracket = event.bracket;
    } else if (event.type === 'series-players') {
      const row = run.rows[event.index];
      if (row) row.players = event.players;
    } else if (event.type === 'plans') {
      run.seed = event.seed;
      run.rows = event.plans.map((plan) => ({
        players: plan.players,
        status: 'queued' as const,
        score: { p1: 0, p2: 0 } as Record<Pid, number>,
        game: 0,
        turns: 0,
        winner: null,
      }));
    } else if (event.type === 'series-start') {
      const row = run.rows[event.index];
      if (row) {
        row.status = 'running';
        row.game = 1;
      }
    } else if (event.type === 'game-update') {
      if (!run.rows[event.index]) return;
      let games = run.battles.get(event.index);
      if (!games) {
        games = new Map();
        run.battles.set(event.index, games);
      }
      let entry = games.get(event.game);
      if (!entry) {
        entry = { state: new BattleState('p1'), log: new BattleLog() };
        games.set(event.game, entry);
      }
      entry.state.feed(event.lines);
      entry.log.feed(event.lines);
      const row = run.rows[event.index];
      if (row && row.status === 'running') row.game = event.game;
      run.battleRevisions.set(event.index, (run.battleRevisions.get(event.index) ?? 0) + 1);
      this.options.onBattleChange(event.index);
    } else if (event.type === 'decision') {
      if (!run.rows[event.index]) return;
      const row = event.row;
      const rawError = typeof row.error === 'string' ? row.error : '';
      let error = typeof row.error_summary === 'string' ? row.error_summary.slice(0, 500) : '';
      if (!error && rawError) {
        error =
          row.fallback === true && row.action !== 'abandoned'
            ? 'The model returned no usable decision; a legal fallback was selected.'
            : classifyProviderFailure(rawError, run.rows[event.index]!.players[event.pid]).summary;
      }
      if (row.kind === 'decision' || row.kind === 'game_reflection') {
        const totals = run.spend.get(event.index) ?? { p1: { ms: 0, tokens: 0 }, p2: { ms: 0, tokens: 0 } };
        if (row.kind === 'decision') totals[event.pid].ms += Number(row.latency_ms) || 0;
        totals[event.pid].tokens += Number(row.total_tokens) || 0;
        run.spend.set(event.index, totals);
        if (row.kind === 'game_reflection') {
          run.battleRevisions.set(event.index, (run.battleRevisions.get(event.index) ?? 0) + 1);
          this.options.onBattleChange(event.index);
        }
      }
      if (row.kind === 'decision') {
        const list = run.decisions.get(event.index) ?? [];
        list.push({
          game: Number(row.game_number) || 0,
          turn: Number(row.turn) || 0,
          pid: event.pid,
          phase: typeof row.phase === 'string' ? row.phase.slice(0, 100) : '',
          selection: Array.isArray(row.selection)
            ? row.selection.slice(0, 16).map((value) => String(value).slice(0, 500))
            : [],
          rationale: typeof row.rationale === 'string' ? row.rationale.slice(0, 20_000) : '',
          error,
          automatic: row.automatic === true,
          fallback: row.fallback === true,
          substituted: typeof row.substitution_reason === 'string',
        });
        if (list.length > 400) list.splice(0, list.length - 400);
        run.decisions.set(event.index, list);
        run.battleRevisions.set(event.index, (run.battleRevisions.get(event.index) ?? 0) + 1);
        this.options.onBattleChange(event.index);
      }
      return;
    } else if (event.type === 'game-end') {
      const row = run.rows[event.index];
      if (row) {
        row.score = event.score;
        row.game = event.game + 1;
        row.turns += event.turns;
      }
    } else if (event.type === 'series-end') {
      const row = run.rows[event.index];
      if (row) {
        row.status = 'done';
        row.winner = typeof event.record.winner === 'string' ? event.record.winner : null;
        row.score = event.record.score as Record<Pid, number>;
        row.turns = Number(event.record.turns ?? row.turns);
      }
    }
    this.options.onRunChange();
  }
}
