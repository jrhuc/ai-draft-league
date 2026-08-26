import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type {
  BattleLogEntryView,
  BattleSnapshot,
  DecisionView,
  LeagueGameDecisionView,
  LeagueGameReflectionView,
  LeagueGameResponse,
  MonView,
  TeamBuildSetView,
} from "./views.js";
import { BattleLog } from "./battlelog.js";
import { readJsonlObjects } from "./jsonl.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import type { SeriesRecord } from "./records.js";
import { runStatusSchema } from "./run-status.js";
import { storedSeriesMetadataSchema } from "./series.js";
import { loadShowdown } from "./showdown.js";
import { BattleState, type MonState } from "./state.js";
import type { JsonValue, Pid } from "./types.js";
import { afterColon, isErrnoCode } from "./value.js";

const pidSchema = z.enum(["p1", "p2"]);
const runLeaseArtifactSchema = z.looseObject({ pid: z.number().optional().catch(undefined) });
const decisionLogArtifactSchema = z.looseObject({
  kind: z.string(),
  automatic: z.boolean(),
  latency_ms: z.number().finite(),
  total_tokens: z.number().finite(),
  reasoning_tokens: z.number().finite().optional(),
});
const decisionArtifactSchema = z.looseObject({
  kind: z.literal("decision"),
  action: z.string(),
  automatic: z.boolean(),
  fallback: z.boolean(),
  game_number: z.number().finite(),
  turn: z.number().finite(),
  phase: z.string(),
  selection: z.array(z.json()),
  rationale: z.string(),
  notebook: z.string().optional(),
  latency_ms: z.number().finite(),
  total_tokens: z.number().finite(),
  reasoning_tokens: z.number().finite().optional(),
});
const reflectionArtifactSchema = z.looseObject({
  kind: z.literal("game_reflection"),
  fallback: z.boolean(),
  game_number: z.number().finite(),
  result: z.enum(["won", "lost"]),
  series_over: z.boolean(),
  summary: z.string(),
  adjustment: z.string(),
  notebook: z.string().optional(),
  total_tokens: z.number().finite(),
  reasoning_tokens: z.number().finite().optional(),
});
const decisionArtifactUnion = z.discriminatedUnion("kind", [
  decisionArtifactSchema,
  reflectionArtifactSchema,
]);
const gameArtifactSchema = z.looseObject({
  winner_side: z.enum(["p1", "p2"]).nullable().catch(null),
});

export function count(value: JsonValue | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function decisionLogPath(
  runsDir: string,
  runId: string,
  seriesId: string,
  pid: Pid,
): string | null {
  if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(seriesId)) return null;
  return path.join(runsDir, runId, "series", seriesId, `${pid}-decisions.jsonl`);
}

export interface DecisionLogRow {
  kind: string;
  automatic: boolean;
  latencyMs: number;
  totalTokens: number;
  reasoningTokens?: number | undefined;
}

const logCache = new Map<string, { mtimeMs: number; size: number; rows: DecisionLogRow[] }>();

/** Cached by mtime and size; decision logs of finished runs never change. */
export function readDecisionLog(file: string): DecisionLogRow[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    logCache.delete(file);
    return [];
  }
  const cached = logCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rows;
  const rows: DecisionLogRow[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = decisionLogArtifactSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const entry = parsed.data;
      rows.push({
        kind: entry.kind,
        automatic: entry.automatic,
        latencyMs: entry.latency_ms,
        totalTokens: entry.total_tokens,
        reasoningTokens: entry.reasoning_tokens,
      });
    } catch {}
  }
  logCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export const PIDS: Pid[] = ["p1", "p2"];

const spriteIds = new Map<string, string>();

export function spriteIdFor(species: string): string {
  const cached = spriteIds.get(species);
  if (cached !== undefined) return cached;
  const { Dex } = loadShowdown();
  const resolved = Dex.mod("champions").species.get(species);
  const id = resolved.exists ? resolved.spriteid : "";
  spriteIds.set(species, id);
  return id;
}

export function viewTeamSheet(packed: string): TeamBuildSetView[] {
  const { Teams } = loadShowdown();
  return (Teams.unpack(packed) ?? []).map((set) => {
    const species = set.species || set.name || "Pokémon";
    return {
      species,
      spriteId: spriteIdFor(species),
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: set.moves,
      evs: { ...set.evs },
      repaired: false,
      repairs: [],
    };
  });
}

function snapshotMon(battle: BattleState, pid: Pid, mon: MonState): MonView {
  const boosts = Object.entries(mon.boosts)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stat, value]) => `${stat} ${value > 0 ? "+" : ""}${value}`)
    .join(", ");
  const target = mon.lastMove?.target ? ` → ${afterColon(mon.lastMove.target)}` : "";
  const volatiles = [...mon.volatiles]
    .map((volatile) => (/^perish(\d)$/i.test(volatile) ? `Perish ${volatile.slice(-1)}` : volatile))
    .sort()
    .join(", ");
  return {
    species: mon.species,
    spriteId: spriteIdFor(mon.species),
    slot: battle.activeSlot(pid, mon)?.toUpperCase() ?? "",
    hp: mon.fainted ? "fainted" : (mon.hp ?? ""),
    status: mon.fainted ? "" : (mon.status ?? ""),
    fainted: mon.fainted,
    boosts,
    volatiles,
    lastMove: mon.lastMove ? `${mon.lastMove.name}${target} · T${mon.lastMove.turn}` : "",
  };
}

function snapshotBattle(
  battle: BattleState,
  players: Record<Pid, string> | undefined,
  log: BattleLogEntryView[],
  decisions: DecisionView[] = [],
  spend?: Record<Pid, { ms: number; tokens: number }>,
): BattleSnapshot {
  const side = (pid: Pid) => ({
    player: players?.[pid] ?? pid,
    conditions: battle.conditionLabels(pid),
    mons: battle.visibleMons(pid).map((mon) => snapshotMon(battle, pid, mon)),
  });
  const timerView = (pid: Pid) => {
    const timer = battle.timers[pid];
    if (!timer) return null;
    const drained = timer.running ? (Date.now() - timer.at) / 1000 : 0;
    const remaining = (value: number | null) =>
      value === null ? null : Math.max(0, Math.round(value - drained));
    return {
      seconds: remaining(timer.seconds),
      turnSeconds: remaining(timer.turnSeconds),
      elapsedSeconds: timer.running ? Math.max(0, Math.floor(drained)) : null,
      running: timer.running,
    };
  };
  const spendView = (pid: Pid) => ({
    seconds: Math.round((spend?.[pid]?.ms ?? 0) / 1000),
    tokens: spend?.[pid]?.tokens ?? 0,
  });
  return {
    turn: battle.turn,
    weather: battle.weatherLabel(),
    fields: battle.fieldLabels(),
    sides: { p1: side("p1"), p2: side("p2") },
    timers: { p1: timerView("p1"), p2: timerView("p2") },
    spend: { p1: spendView("p1"), p2: spendView("p2") },
    log,
    decisions,
  };
}

export function isRunLive(runsDir: string, runId: string): boolean {
  const status = runStatusSchema.safeParse(readRunJson(runsDir, runId, "status.json"));
  if (!status.success || status.data.state !== "running") return false;
  const lease = runLeaseArtifactSchema.safeParse(readRunJson(runsDir, runId, ".run.lease"));
  const pid = status.data.pid ?? (lease.success ? lease.data.pid : undefined);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, "EPERM");
  }
}

export function readRunJson(runsDir: string, runId: string, ...segments: string[]): JsonValue {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, ...segments), "utf8"));
  } catch {
    return null;
  }
}

export function readRunLines(runsDir: string, runId: string, ...segments: string[]) {
  return readJsonlObjects(path.join(runsDir, runId, ...segments));
}

export interface UnfinishedSeries {
  seriesId: string;
  seriesIndex: number | null;
  game: number;
  turn: number;
  decisions: number;
  players: Record<Pid, string> | null;
}

export function scanUnfinishedSeries(
  runsDir: string,
  runId: string,
  rows: SeriesRecord[],
): UnfinishedSeries[] {
  const seen = new Set(rows.map((row) => row.series_id ?? ""));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(runsDir, runId, "series"));
  } catch {
    return [];
  }
  const found: UnfinishedSeries[] = [];
  for (const seriesId of entries) {
    if (!SAFE_SEGMENT.test(seriesId) || seen.has(seriesId)) continue;
    let decisions = 0;
    let game = 0;
    let turn = 0;
    for (const pid of PIDS) {
      const lines = readRunLines(runsDir, runId, "series", seriesId, `${pid}-decisions.jsonl`);
      decisions += lines.length;
      const last = lines[lines.length - 1];
      if (last) {
        game = Math.max(game, count(last.game_number));
        turn = Math.max(turn, count(last.turn));
      }
    }
    const metadata = storedSeriesMetadataSchema.safeParse(
      readRunJson(runsDir, runId, "series", seriesId, "series.json"),
    );
    const players = metadata.success ? metadata.data.players : null;
    found.push({
      seriesId,
      seriesIndex: metadata.success ? metadata.data.seriesIndex : null,
      game: Math.max(1, game),
      turn,
      decisions,
      players,
    });
  }
  return found.sort((a, b) => a.seriesId.localeCompare(b.seriesId));
}

export interface SeriesSlot {
  seriesId: string;
  sides: [number, number];
  stage: "roundrobin" | "playoff";
  round: number;
  models: string[];
  labels: string[];
}

export function buildSeriesGame(
  runsDir: string,
  runId: string,
  seriesIndex: number,
  game: number,
  slot: SeriesSlot,
  row: SeriesRecord | undefined,
): LeagueGameResponse | null {
  const { seriesId, sides, stage, round } = slot;
  if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(seriesId)) return null;

  let seriesFiles: string[];
  try {
    seriesFiles = fs.readdirSync(path.join(runsDir, runId, "series", seriesId));
  } catch {
    return null;
  }
  const gameNumbers = new Set<number>();
  for (const name of seriesFiles) {
    const match = /^game-(\d+)\.log$/.exec(name);
    if (match) gameNumbers.add(Number(match[1]));
  }

  const decisions: LeagueGameDecisionView[] = [];
  const reflections: LeagueGameReflectionView[] = [];
  for (const [side, pid] of [
    [0, "p1"],
    [1, "p2"],
  ] as const) {
    for (const artifact of readRunLines(
      runsDir,
      runId,
      "series",
      seriesId,
      `${pid}-decisions.jsonl`,
    )) {
      const parsed = decisionArtifactUnion.safeParse(artifact);
      if (!parsed.success) continue;
      const entry = parsed.data;
      const entryGame = entry.game_number;
      if (entryGame > 0) gameNumbers.add(entryGame);
      if (entryGame !== game) continue;
      if (entry.kind === "game_reflection") {
        reflections.push({
          side,
          result: entry.result,
          summary: entry.summary,
          adjustment: entry.adjustment,
          notebook: entry.notebook ?? "",
          fallback: entry.fallback,
          seriesOver: entry.series_over,
        });
        continue;
      }
      decisions.push({
        side,
        turn: entry.turn,
        phase: entry.phase,
        selection: entry.selection.map(String),
        action: entry.action,
        rationale: entry.rationale,
        notebook: entry.notebook ?? "",
        fallback: entry.fallback,
        automatic: entry.automatic,
        latencyMs: entry.latency_ms,
        totalTokens: entry.total_tokens,
        reasoningTokens: entry.reasoning_tokens ?? null,
      });
    }
  }
  if (!gameNumbers.has(game)) return null;
  decisions.sort((first, second) => first.turn - second.turn || first.side - second.side);

  let raw = "";
  try {
    raw = fs.readFileSync(
      path.join(runsDir, runId, "series", seriesId, `game-${game}.log`),
      "utf8",
    );
  } catch {
    if (row) return null;
  }
  const battleLog = new BattleLog(10_000);
  battleLog.feed(raw.split("\n"));
  const live = !row && isRunLive(runsDir, runId);
  let snapshot: BattleSnapshot | null = null;
  if (live && !/^\|(?:win\||tie\b)/m.test(raw)) {
    const state = new BattleState("p1");
    state.feed(raw.split("\n"));
    const spendFor = (side: 0 | 1) => ({
      ms: decisions.reduce(
        (total, entry) => total + (entry.side === side ? (entry.latencyMs ?? 0) : 0),
        0,
      ),
      tokens: decisions.reduce(
        (total, entry) => total + (entry.side === side ? (entry.totalTokens ?? 0) : 0),
        0,
      ),
    });
    snapshot = snapshotBattle(
      state,
      { p1: slot.models[sides[0]]!, p2: slot.models[sides[1]]! },
      [],
      [],
      {
        p1: spendFor(0),
        p2: spendFor(1),
      },
    );
  }

  const parsedGameRows = z.array(gameArtifactSchema).safeParse(row?.games);
  const gameRows = parsedGameRows.success ? parsedGameRows.data : [];
  const logWinner = (text: string): number | null => {
    const lines = text.split("\n");
    const players = new Map<string, Pid>();
    for (const line of lines) {
      const match = /^\|player\|(p[12])\|([^|]+)\|/.exec(line);
      if (!match) continue;
      const pid = pidSchema.safeParse(match[1]);
      const player = z.string().min(1).safeParse(match[2]);
      if (pid.success && player.success) players.set(player.data, pid.data);
    }
    const winLine = lines.find((line) => line.startsWith("|win|"));
    const pid = winLine === undefined ? undefined : players.get(winLine.slice(5).trim());
    return pid === undefined ? null : pid === "p1" ? sides[0] : sides[1];
  };
  const winnerOf = (number: number): number | null => {
    const gameRow = gameRows[number - 1];
    if (gameRow?.winner_side === "p1") return sides[0];
    if (gameRow?.winner_side === "p2") return sides[1];
    if (row) return null;
    if (number === game) return raw ? logWinner(raw) : null;
    try {
      return logWinner(
        fs.readFileSync(
          path.join(runsDir, runId, "series", seriesId, `game-${number}.log`),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  };
  const games = [...gameNumbers].sort((first, second) => first - second);
  return {
    runId,
    seriesIndex,
    seriesId,
    stage,
    round,
    game,
    games,
    gameWinners: games.map(winnerOf),
    sides,
    teamNames: [
      slot.labels[sides[0]] ?? `Seat ${sides[0] + 1}`,
      slot.labels[sides[1]] ?? `Seat ${sides[1] + 1}`,
    ],
    winner: winnerOf(game),
    live,
    snapshot,
    log: battleLog.entries,
    decisions,
    reflections,
  };
}
