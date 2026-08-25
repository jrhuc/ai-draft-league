import { draftLeagueTopology } from '../../../draftleague-topology';
import type { AppState, ProviderInfo, RunView } from '../../api';
import type { TeamAssignment } from '../views/team-editor';

export type RunMode = 'match' | 'tournament' | 'draft' | 'rotation';
export type TeamSource = 'pool' | 'custom';

export interface RunDraft {
  mode: RunMode;
  models: string[];
  apiKeys: Record<string, string>;
  teamBySlot: Array<TeamAssignment | null>;
  teamSource: TeamSource;
  assignFormat: string;
  pool: string;
  series: string;
  concurrency: string;
  closedSheets: boolean;
  sequentialWeeks: boolean;
  draftOnly: boolean;
  transactions: string;
  nitro: boolean;
  sharedReasoning: boolean;
  reasoning: string;
  reasoningByModel: Record<string, string>;
  timerScale: string;
  seed: string;
  board: string;
}

export interface StartRunRequest {
  models: string[];
  apiKeys: Record<string, string>;
  seed: string;
  timerScale: 'off' | number;
  reasoning?: string;
  reasoningByModel?: Record<string, string>;
  nitro?: true;
  mode?: 'tournament' | 'draft';
  teams?: string[];
  format?: string;
  concurrency?: number;
  pool?: string;
  board?: string;
  closedSheets?: true;
  sequentialWeeks?: true;
  draftOnly?: true;
  transactions?: null | number[];
  seriesPerPair?: number;
}

export function buildStartRunRequest(draft: RunDraft): StartRunRequest {
  const selectedReasoning = Object.fromEntries(
    Object.entries(draft.reasoningByModel).filter(([model, level]) => draft.models.includes(model) && level),
  );
  const request: StartRunRequest = {
    models: draft.models,
    apiKeys: draft.apiKeys,
    seed: draft.seed.trim(),
    timerScale: draft.timerScale === 'off' ? 'off' : Number(draft.timerScale),
  };
  if (draft.sharedReasoning) {
    if (draft.reasoning) request.reasoning = draft.reasoning;
  } else if (Object.keys(selectedReasoning).length > 0) {
    request.reasoningByModel = selectedReasoning;
  }
  if (draft.nitro) request.nitro = true;

  if (draft.mode === 'match') {
    request.mode = 'tournament';
    request.teams = draft.models.map((_, index) => draft.teamBySlot[index]?.paste ?? '');
    request.format = draft.assignFormat;
    request.concurrency = 1;
  } else if (draft.mode === 'tournament') {
    request.mode = 'tournament';
    request.concurrency = Number(draft.concurrency);
    if (draft.teamSource === 'custom') {
      request.teams = draft.models.map((_, index) => draft.teamBySlot[index]?.paste ?? '');
      request.format = draft.assignFormat;
    } else {
      request.pool = draft.pool;
    }
  } else if (draft.mode === 'draft') {
    request.mode = 'draft';
    request.board = draft.board;
    request.concurrency = Number(draft.concurrency);
    if (draft.closedSheets) request.closedSheets = true;
    if (draft.sequentialWeeks) request.sequentialWeeks = true;
    if (draft.draftOnly) request.draftOnly = true;
    if (draft.transactions !== 'default') {
      request.transactions =
        draft.transactions === 'off' ? null : draft.transactions.split(',').map((week) => Number(week));
    }
  } else {
    request.pool = draft.pool;
    request.seriesPerPair = Number(draft.series);
    request.concurrency = Number(draft.concurrency);
  }
  return request;
}

export function needsProviderKey(providers: ProviderInfo[], spec: string): boolean {
  if (spec === 'random') return false;
  const providerId = spec.split(':')[0]!;
  return providers.find((item) => item.id === providerId)?.requiresKey ?? true;
}

export interface RunReadiness {
  active: boolean;
  missingKeys: string[];
  missingTeam: boolean;
  poolTooSmall: boolean;
  boardOverflow: boolean;
  disabled: boolean;
  label: string;
}

export function runReadiness(
  draft: Pick<RunDraft, 'mode' | 'models' | 'apiKeys' | 'teamBySlot' | 'teamSource' | 'pool' | 'series'>,
  app: Pick<AppState, 'providers' | 'pools' | 'boards'>,
  run: RunView | null,
  starting: boolean,
): RunReadiness {
  const { mode, models, apiKeys, teamBySlot, teamSource, pool } = draft;
  const teamsMode = mode === 'match' || (mode === 'tournament' && teamSource === 'custom');
  const missingKeys = models.filter((spec) => needsProviderKey(app.providers, spec) && !apiKeys[spec]);
  const missingTeam = teamsMode && models.some((_, index) => !teamBySlot[index]?.paste.trim());
  const poolInfo = app.pools.find((info) => info.name === pool);
  const poolTooSmall =
    mode === 'tournament' && teamSource === 'pool' && poolInfo !== undefined && poolInfo.teamCount < models.length;
  const board = app.boards[0] ?? null;
  const boardOverflow = mode === 'draft' && (!board || models.length > board.maxEntrants);
  const active = run?.state === 'running';
  const disabled =
    models.length < 2 ||
    active ||
    missingKeys.length > 0 ||
    starting ||
    (mode === 'match'
      ? models.length !== 2 || missingTeam
      : mode === 'draft'
        ? boardOverflow
        : mode === 'tournament' && teamSource === 'custom'
          ? missingTeam
          : !pool || poolTooSmall);
  const total =
    mode === 'rotation'
      ? ((models.length * (models.length - 1)) / 2) * Math.max(1, Number(draft.series) || 1)
      : mode === 'draft'
        ? draftLeagueTopology(models.length).totalSeries
        : Math.max(0, models.length - 1);
  const label = active
    ? 'Run already in progress'
    : models.length < 2
      ? 'Add two models'
      : missingKeys.length
        ? 'Add run-only API keys'
        : mode === 'match'
          ? models.length !== 2
            ? 'Exactly two models'
            : missingTeam
              ? 'Assign both teams'
              : 'Start the match'
          : mode === 'tournament'
            ? missingTeam
              ? 'Assign every team'
              : `Start the ${models.length}-model bracket`
            : mode === 'draft'
              ? `Start the ${models.length}-coach draft`
              : `Start ${total} series`;
  return { active, missingKeys, missingTeam, poolTooSmall, boardOverflow, disabled, label };
}
