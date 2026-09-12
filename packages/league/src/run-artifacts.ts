import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type {
  LeagueGameDecisionView,
  LeagueGameReflectionView,
  LeagueGameResponse,
  TeamBuildSetView,
} from "./views.js";
import { BattleLog } from "./battlelog.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import { readCompletedSeriesDecisionRows } from "./recorded-series.js";
import type { SeriesRecord } from "./records.js";
import { isProcessAlive, runStatusSchema } from "./run-status.js";
import { loadShowdown } from "./showdown.js";
import type { JsonValue, Pid } from "./types.js";

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
  submission_id: z.string().optional(),
  action: z.string(),
  automatic: z.boolean(),
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
  game_number: z.number().finite(),
  result: z.enum(["won", "lost", "tied"]),
  series_over: z.boolean(),
  summary: z.string(),
  adjustment: z.string(),
  notebook: z.string(),
  did_well: z.string().optional(),
  did_poorly: z.string().optional(),
  would_change: z.string().optional(),
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
    };
  });
}

export function isRunLive(runsDir: string, runId: string): boolean {
  const status = runStatusSchema.safeParse(readRunJson(runsDir, runId, "status.json"));
  if (!status.success || status.data.state !== "running") return false;
  const lease = runLeaseArtifactSchema.safeParse(readRunJson(runsDir, runId, ".run.lease"));
  const pid = status.data.pid ?? (lease.success ? lease.data.pid : undefined);
  if (pid === undefined) return false;
  return isProcessAlive(pid);
}

export function readRunJson(runsDir: string, runId: string, ...segments: string[]): JsonValue {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, ...segments), "utf8"));
  } catch {
    return null;
  }
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
  row: SeriesRecord,
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
    const artifacts = readCompletedSeriesDecisionRows(path.join(runsDir, runId), seriesId, pid);
    for (const artifact of artifacts) {
      const parsed = decisionArtifactUnion.safeParse(artifact);
      if (!parsed.success) {
        if (artifact.kind === "game_reflection") {
          throw new Error(
            `invalid reflection artifact for ${seriesId} ${pid} game ${JSON.stringify(artifact.game_number)}`,
          );
        }
        continue;
      }
      const entry = parsed.data;
      const entryGame = entry.game_number;
      if (entryGame > 0) gameNumbers.add(entryGame);
      if (entryGame !== game) continue;
      if (entry.kind === "game_reflection") {
        const retrospectiveCount = [entry.did_well, entry.did_poorly, entry.would_change].filter(
          (field) => field !== undefined,
        ).length;
        if (retrospectiveCount !== 0 && retrospectiveCount !== 3) {
          throw new Error(
            `incomplete retrospective artifact for ${seriesId} ${pid} game ${entryGame}`,
          );
        }
        reflections.push({
          side,
          result: entry.result,
          summary: entry.summary,
          adjustment: entry.adjustment,
          notebook: entry.notebook,
          retrospective:
            entry.did_well !== undefined &&
            entry.did_poorly !== undefined &&
            entry.would_change !== undefined
              ? {
                  didWell: entry.did_well,
                  didPoorly: entry.did_poorly,
                  wouldChange: entry.would_change,
                }
              : undefined,
          seriesOver: entry.series_over,
        });
        continue;
      }
      decisions.push({
        side,
        submissionId: entry.submission_id ?? null,
        turn: entry.turn,
        phase: entry.phase,
        selection: entry.selection.map(String),
        action: entry.action,
        rationale: entry.rationale,
        notebook: entry.notebook ?? "",
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
    return null;
  }
  const battleLog = new BattleLog(10_000);
  battleLog.feed(raw.split("\n"));
  const parsedGameRows = z.array(gameArtifactSchema).safeParse(row.games);
  const gameRows = parsedGameRows.success ? parsedGameRows.data : [];
  const winnerOf = (number: number): number | null => {
    const gameRow = gameRows[number - 1];
    if (gameRow?.winner_side === "p1") return sides[0];
    if (gameRow?.winner_side === "p2") return sides[1];
    return null;
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
    raw,
    log: battleLog.entries,
    decisions,
    reflections,
  };
}
