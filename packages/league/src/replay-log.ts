import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { REPLAYS_DIR } from "./paths.js";
import { stateKey } from "./state-model.js";
import type { Pid } from "./types.js";

const REPLAY_HOST = "https://replay.pokemonshowdown.com";
const REPLAY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const SERIES_GAME = /<strong>Game (\d+)<\/strong> of .*?best-of-(\d+)/;

/** Chat and room lines are written by the players and by the server, never by the battle. */
const ROOM_LINES = new Set([
  "j",
  "J",
  "l",
  "L",
  "n",
  "N",
  "c",
  "c:",
  "chat",
  "t:",
  "raw",
  "html",
  "uhtml",
  "uhtmlchange",
  "inactive",
  "inactiveoff",
  "debug",
]);

const replaySchema = z.object({ id: z.string(), formatid: z.string(), log: z.string() });

export interface ReplayTurn {
  turn: number;
  lines: string[];
}

export interface ReplayGame {
  id: string;
  formatId: string;
  tier: string;
  players: Record<Pid, string>;
  ratings: Record<Pid, number | null>;
  sheets: Partial<Record<Pid, string>>;
  teamSize: Partial<Record<Pid, number>>;
  series: { game: number; bestOf: number } | null;
  preview: string[];
  leads: string[];
  turns: ReplayTurn[];
  winner: Pid | null;
  viewpoint: Pid | null;
}

function lineKind(line: string): string {
  return line.startsWith("|") ? (line.split("|", 2)[1] ?? "") : "";
}

export function isBattleLine(line: string): boolean {
  const kind = lineKind(line);
  return kind !== "" && !ROOM_LINES.has(kind);
}

function side(value: string | undefined): Pid | undefined {
  return value === "p1" || value === "p2" ? value : undefined;
}

export function parseReplay(
  id: string,
  formatId: string,
  log: string,
  viewpoint: Pid | null = null,
): ReplayGame {
  const game: ReplayGame = {
    id,
    formatId,
    tier: formatId,
    players: { p1: "", p2: "" },
    ratings: { p1: null, p2: null },
    sheets: {},
    teamSize: {},
    series: null,
    preview: [],
    leads: [],
    turns: [],
    winner: null,
    viewpoint,
  };
  let section = game.preview;
  for (const line of log.split("\n")) {
    const kind = lineKind(line);
    const args = line.split("|").slice(2);
    if (kind === "uhtml" && args[0] === "bestof") {
      const match = SERIES_GAME.exec(line);
      if (match) game.series = { game: Number(match[1]), bestOf: Number(match[2]) };
    }
    if (!isBattleLine(line)) continue;
    const pid = side(args[0]);
    if (kind === "player") {
      if (pid && args[1] && !game.players[pid]) {
        game.players[pid] = args[1];
        game.ratings[pid] = args[3] ? Number(args[3]) : null;
      }
      continue;
    }
    if (kind === "tier" && args[0]) game.tier = args[0];
    else if (kind === "showteam" && pid) game.sheets[pid] = args.slice(1).join("|");
    else if (kind === "teamsize" && pid) game.teamSize[pid] = Number(args[1]);
    else if (kind === "win")
      game.winner =
        (["p1", "p2"] as const).find((candidate) => game.players[candidate] === args[0]) ?? null;
    if (kind === "start") section = game.leads;
    if (kind === "turn") {
      const turn: ReplayTurn = { turn: Number(args[0]), lines: [] };
      game.turns.push(turn);
      section = turn.lines;
      continue;
    }
    section.push(line);
  }
  if (!game.players.p1 || !game.players.p2) throw new Error(`replay ${id} names no players`);
  if (!game.leads.length) throw new Error(`replay ${id} never started`);
  return game;
}

function parseStored(body: string, viewpoint: Pid | null): ReplayGame {
  const replay = replaySchema.parse(JSON.parse(body));
  return parseReplay(replay.id, replay.formatid, replay.log, viewpoint);
}

/** A replay URL, a bare replay id, or a saved replay JSON file. Fetched replays are kept in
 * `replays/`, so later calls against the same game need no network. */
export async function loadReplay(ref: string): Promise<ReplayGame> {
  if (fs.existsSync(ref)) return parseStored(fs.readFileSync(ref, "utf8"), null);
  const url = /^https?:\/\//.test(ref) ? new URL(ref) : undefined;
  const id = (url ? url.pathname : ref).replace(/\.(json|log)$/, "").replace(/^.*\//, "");
  if (!REPLAY_ID.test(id)) throw new Error(`not a replay URL, replay id, or replay file: ${ref}`);
  const viewpoint = url?.search === "?p2" ? "p2" : url?.search === "?p1" ? "p1" : null;
  const cached = path.join(REPLAYS_DIR, `${id}.json`);
  if (!fs.existsSync(cached)) {
    const response = await fetch(`${REPLAY_HOST}/${id}.json`);
    if (!response.ok) throw new Error(`replay ${id} is not available (HTTP ${response.status})`);
    const body = await response.text();
    parseStored(body, viewpoint);
    fs.mkdirSync(REPLAYS_DIR, { recursive: true });
    fs.writeFileSync(cached, body);
  }
  return parseStored(fs.readFileSync(cached, "utf8"), viewpoint);
}

export function playerSide(game: ReplayGame, name: string): Pid | undefined {
  const pid = side(name);
  if (pid) return pid;
  return (["p1", "p2"] as const).find(
    (candidate) => stateKey(game.players[candidate]) === stateKey(name),
  );
}
