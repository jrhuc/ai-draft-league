import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Battle, BattleStream, Dex, Teams, TeamValidator } from 'pokemon-showdown';
import { z } from 'zod';

import { defaultPsDir, PINNED_PS_DIR, REPO_ROOT } from './paths.js';

export interface ShowdownApi {
  Battle: typeof Battle;
  BattleStream: typeof BattleStream;
  Dex: typeof Dex;
  Teams: typeof Teams;
  TeamValidator: typeof TeamValidator;
}
interface ShowdownLock {
  repository: string;
  commit: string;
}
const showdownLockSchema = z.looseObject({
  repository: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});

const requireFromHere = createRequire(import.meta.url);
const cache = new Map<string, ShowdownApi>();
const revisionCache = new Map<string, string>();
const requiredBuildFiles = ['dist/sim/index.js', 'dist/sim/index.d.ts', 'dist/server/room-battle.js'];
const lockResult = showdownLockSchema.safeParse(
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'showdown.lock.json'), 'utf8')),
);
if (!lockResult.success) {
  throw new Error('showdown.lock.json must contain a repository URL and full commit SHA');
}
const lock: ShowdownLock = lockResult.data;
export const SHOWDOWN_LOCK: Readonly<ShowdownLock> = lock;

function physicalPath(directory: string): string | undefined {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return undefined;
  }
}

function physicalPinnedRuntime(resolved: string): boolean {
  const actual = physicalPath(resolved);
  const pinned = physicalPath(PINNED_PS_DIR);
  return actual !== undefined && pinned !== undefined && actual === pinned;
}

/** The harness revision a run was produced from; null outside a git checkout. */
export function harnessCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function showdownCommit(psDir = defaultPsDir()): string {
  const resolved = path.resolve(psDir);
  const physical = physicalPath(resolved);
  const cacheKey = physical ?? resolved;
  const existing = revisionCache.get(cacheKey);
  if (existing) return existing;
  if (physicalPinnedRuntime(resolved)) {
    revisionCache.set(cacheKey, SHOWDOWN_LOCK.commit);
    return SHOWDOWN_LOCK.commit;
  }
  let revision = '';
  try {
    revision = execFileSync('git', ['-C', resolved, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch {}
  if (!revision) {
    try {
      revision = fs.readFileSync(path.join(resolved, 'dist', '.vgc-model-league-revision'), 'utf8').trim();
    } catch {}
  }
  const result = revision || 'unknown';
  revisionCache.set(cacheKey, result);
  return result;
}

function assertShowdownInstallation(resolved: string): void {
  const missing = requiredBuildFiles.filter((file) => !fs.existsSync(path.join(resolved, file)));
  if (missing.length) {
    throw new Error(`Pokémon Showdown is not built at ${resolved}; run pnpm run setup:showdown`);
  }
  if (physicalPinnedRuntime(resolved)) {
    let builtRevision = '';
    try {
      builtRevision = fs.readFileSync(path.join(resolved, 'dist', '.vgc-model-league-revision'), 'utf8').trim();
    } catch {}
    if (builtRevision !== SHOWDOWN_LOCK.commit) {
      throw new Error(
        `Pokémon Showdown build is at ${builtRevision || 'unknown'}; expected ${SHOWDOWN_LOCK.commit}. Run pnpm run setup:showdown`,
      );
    }
    if (showdownCommit(resolved) !== SHOWDOWN_LOCK.commit) {
      throw new Error(`Pokémon Showdown must use pinned revision ${SHOWDOWN_LOCK.commit}`);
    }
  } else {
    showdownCommit(resolved);
  }
}

export function loadShowdown(psDir = defaultPsDir()): ShowdownApi {
  const resolved = path.resolve(psDir);
  const existing = cache.get(resolved);
  if (existing) return existing;
  assertShowdownInstallation(resolved);
  const api: ShowdownApi = requireFromHere(path.join(resolved, 'dist', 'sim'));
  api.Dex.includeModData();
  cache.set(resolved, api);
  return api;
}

export interface TimerPlayer {
  slot: 'p1' | 'p2';
  name: string;
  active: boolean;
  knownActive: boolean;
  eliminated: boolean;
  request: { isWait: boolean | 'cantUndo' };
  secondsLeft?: number;
  turnSecondsLeft?: number;
  dcSecondsLeft?: number;
  sendRoom(message: string): void;
}
export interface TimerRoom {
  add(): TimerRoom;
  update(): TimerRoom;
}

export interface RoomBattleBridge {
  format: string;
  challengeType: string;
  ended: boolean;
  players: TimerPlayer[];
  playerTable: { [name: string]: never };
  room: TimerRoom;
  turn: number;
  requestCount: number;
  stream: { write(command: string): void | Promise<void> };
  tie(): void | Promise<void>;
  forfeitPlayer(player: TimerPlayer): void | Promise<void>;
}

export interface RoomBattleTimerSettings {
  starting: number;
  grace: number;
  addPerTurn: number;
  maxPerTurn: number;
  maxFirstTurn: number;
}

export interface RoomBattleTimer {
  settings: RoomBattleTimerSettings;
  start(): boolean;
  stop(): boolean;
  nextRequest(player: TimerPlayer): void;
  end(): boolean;
}

interface RoomBattleTimerConstructor {
  new (battle: RoomBattleBridge): RoomBattleTimer;
}

export function loadRoomBattleTimer(psDir = defaultPsDir()): RoomBattleTimerConstructor {
  const resolved = path.resolve(psDir);
  const config = Object.getOwnPropertyDescriptor(globalThis, 'Config')?.value;
  const monitor = Object.getOwnPropertyDescriptor(globalThis, 'Monitor')?.value;
  Object.assign(globalThis, {
    Config: config ?? {},
    Monitor: monitor ?? { crashlog() {}, slow() {} },
    Dex: loadShowdown(resolved).Dex,
  });
  const module: { RoomBattleTimer: RoomBattleTimerConstructor } = requireFromHere(
    path.join(resolved, 'dist', 'server', 'room-battle.js'),
  );
  return module.RoomBattleTimer;
}
