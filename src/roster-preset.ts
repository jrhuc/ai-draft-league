import fs from 'node:fs';
import path from 'node:path';

import type { DraftBoard, DraftBoardMon } from './draft.js';

export interface RosterPresetTeam {
  name: string;
  roster: string[];
  note: string;
}

export interface RosterPreset {
  id: string;
  board: string;
  teams: RosterPresetTeam[];
}

/** A packaged roster set that seeds a league in place of a live draft. */
export function loadRosterPreset(file: string): RosterPreset {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must hold one roster preset object`);
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id ? record.id : path.basename(file, '.json');
  if (typeof record.board !== 'string' || !record.board) throw new Error(`${file} must name its board`);
  if (!Array.isArray(record.teams) || record.teams.length < 2) throw new Error(`${file} must list at least two teams`);
  const teams = record.teams.map((value, index): RosterPresetTeam => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${file} team ${index + 1} must be an object`);
    }
    const team = value as Record<string, unknown>;
    if (typeof team.name !== 'string' || !team.name.trim()) throw new Error(`${file} team ${index + 1} needs a name`);
    if (!Array.isArray(team.roster) || team.roster.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new Error(`${file} team ${JSON.stringify(team.name)} must list roster ids`);
    }
    if (team.note !== undefined && typeof team.note !== 'string') {
      throw new Error(`${file} team ${JSON.stringify(team.name)} note must be a string`);
    }
    return { name: team.name.trim(), roster: team.roster as string[], note: team.note ?? '' };
  });
  return { id, board: record.board, teams };
}

export function presetRosters(preset: RosterPreset, board: DraftBoard, entrants: number): DraftBoardMon[][] {
  if (preset.board !== board.id) {
    throw new Error(`preset ${preset.id} is drawn from board ${preset.board}, not ${board.id}`);
  }
  if (preset.teams.length !== entrants) {
    throw new Error(`preset ${preset.id} holds ${preset.teams.length} teams for ${entrants} entrants`);
  }
  const byId = new Map(board.mons.map((mon) => [mon.id, mon] as const));
  const taken = new Map<string, string>();
  return preset.teams.map((team) => {
    const label = `preset ${preset.id} team ${JSON.stringify(team.name)}`;
    if (team.roster.length !== board.picks) {
      throw new Error(`${label} lists ${team.roster.length} entries; the board drafts ${board.picks}`);
    }
    const bases = new Set<string>();
    let spent = 0;
    const roster = team.roster.map((id) => {
      const mon = byId.get(id);
      if (!mon) throw new Error(`${label} names ${JSON.stringify(id)}, which board ${board.id} does not hold`);
      const owner = taken.get(id);
      if (owner) throw new Error(`${label} repeats ${id}, already held by ${JSON.stringify(owner)}`);
      taken.set(id, team.name);
      if (bases.has(mon.base)) throw new Error(`${label} holds two entries from base species ${mon.base}`);
      bases.add(mon.base);
      spent += mon.cost;
      return mon;
    });
    if (spent > board.budget) throw new Error(`${label} costs ${spent} points, above the ${board.budget}-point budget`);
    return roster;
  });
}
