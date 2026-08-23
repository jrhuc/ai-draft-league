import type { Battle } from 'pokemon-showdown';
import { requestActionCandidateEntries } from '../../src/fork.js';
import { routeUpdateLines } from '../../src/sim.js';
import type { BattleRequest, Pid } from '../../src/types.js';

export type RouteState = Parameters<typeof routeUpdateLines>[1];

export function routeState(): RouteState {
  return { pov: { p1: [], p2: [] }, log: [], publicLog: [], pendingSplit: [], winner: null, turns: 0 };
}

export function omniscientLog(lines: string[]): string[] {
  const state = routeState();
  routeUpdateLines(
    lines.filter((line) => line),
    state,
  );
  return state.log;
}

interface ShowdownRequest {
  side: { pokemon: readonly { ident: string }[] };
}

export function activeRequest(battle: Battle, pid: Pid): BattleRequest {
  const request: ShowdownRequest | null = battle.getSide(pid).activeRequest;
  if (!request) throw new Error(`${pid} has no active request`);
  // SAFETY: BattleRequest mirrors the fields consumed from the pinned Showdown ChoiceRequest.
  return request as BattleRequest;
}

export interface SideLists {
  p1: string[];
  p2: string[];
}

export function sideLists(): SideLists {
  return { p1: [], p2: [] };
}

export function requestActionCandidates(request: BattleRequest): string[] {
  return requestActionCandidateEntries(request).map((entry) => entry.command);
}
