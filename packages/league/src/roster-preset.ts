import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { DraftBoard, DraftBoardMon } from "./draft.js";

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
  const parsed = z
    .record(z.string(), z.json())
    .safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`${file} must hold one roster preset object`);
  }
  const record = parsed.data;
  const parsedId = z.string().min(1).safeParse(record.id);
  const id = parsedId.success ? parsedId.data : path.basename(file, ".json");
  const board = z.string().min(1).safeParse(record.board);
  if (!board.success) throw new Error(`${file} must name its board`);
  const teamList = z.array(z.json()).min(2).safeParse(record.teams);
  if (!teamList.success) throw new Error(`${file} must list at least two teams`);
  const teams = teamList.data.map((value, index): RosterPresetTeam => {
    const parsedTeam = z.record(z.string(), z.json()).safeParse(value);
    if (!parsedTeam.success) {
      throw new Error(`${file} team ${index + 1} must be an object`);
    }
    const team = parsedTeam.data;
    const name = z.string().safeParse(team.name);
    if (!name.success || !name.data.trim())
      throw new Error(`${file} team ${index + 1} needs a name`);
    const roster = z.array(z.string().min(1)).safeParse(team.roster);
    if (!roster.success) {
      throw new Error(`${file} team ${JSON.stringify(name.data)} must list roster ids`);
    }
    const note = z.string().optional().safeParse(team.note);
    if (!note.success) {
      throw new Error(`${file} team ${JSON.stringify(name.data)} note must be a string`);
    }
    return { name: name.data.trim(), roster: roster.data, note: note.data ?? "" };
  });
  return { id, board: board.data, teams };
}

export function presetRosters(
  preset: RosterPreset,
  board: DraftBoard,
  entrants: number,
): DraftBoardMon[][] {
  if (preset.board !== board.id) {
    throw new Error(`preset ${preset.id} is drawn from board ${preset.board}, not ${board.id}`);
  }
  if (preset.teams.length !== entrants) {
    throw new Error(
      `preset ${preset.id} holds ${preset.teams.length} teams for ${entrants} entrants`,
    );
  }
  const byId = new Map(board.mons.map((mon) => [mon.id, mon] as const));
  const taken = new Map<string, string>();
  return preset.teams.map((team) => {
    const label = `preset ${preset.id} team ${JSON.stringify(team.name)}`;
    if (team.roster.length !== board.picks) {
      throw new Error(
        `${label} lists ${team.roster.length} entries; the board drafts ${board.picks}`,
      );
    }
    const bases = new Set<string>();
    let spent = 0;
    const roster = team.roster.map((id) => {
      const mon = byId.get(id);
      if (!mon)
        throw new Error(
          `${label} names ${JSON.stringify(id)}, which board ${board.id} does not hold`,
        );
      const owner = taken.get(id);
      if (owner)
        throw new Error(`${label} repeats ${id}, already held by ${JSON.stringify(owner)}`);
      taken.set(id, team.name);
      if (bases.has(mon.base))
        throw new Error(`${label} holds two entries from base species ${mon.base}`);
      bases.add(mon.base);
      spent += mon.cost;
      return mon;
    });
    if (spent > board.budget)
      throw new Error(`${label} costs ${spent} points, above the ${board.budget}-point budget`);
    return roster;
  });
}
