import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { appendJsonlObject, readJsonlObjects } from "./jsonl.js";
import { acquireLease, LeaseBusyError } from "./run-status.js";
import type { ExperimentMode, JsonObject, JsonValue, Pid, TimerScale } from "./types.js";

export interface SeriesRecord extends JsonObject {
  mode?: ExperimentMode | undefined;
  run_id?: string | undefined;
  series_index?: number | undefined;
  entrants?: [number, number] | undefined;
  pool?: string | undefined;
  timer_scale?: TimerScale | undefined;
  trade_window?: { after_week: number; trades_allowed?: number | undefined } | null | undefined;
  transactions?: Array<{ after_week: number; trades_allowed: number }> | undefined;
  roster_version?: number | undefined;
  contributor?: { provider: "github"; subject: string; login: string } | undefined;
  players: Record<Pid, string>;
  winner?: string | null | undefined;
  score?: Record<Pid, number> | undefined;
  turns?: number | undefined;
}

export const SERIES_RECORD_SCHEMA_VERSION = 1 as const;

const pidTextSchema = z.strictObject({ p1: z.string().min(1), p2: z.string().min(1) });
const pidCountSchema = z.strictObject({
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
});
const gameSchema = z
  .object({
    number: z.number().int().positive(),
    winner: z.string().min(1).nullable(),
    winner_side: z.enum(["p1", "p2"]).nullable(),
    turns: z.number().int().nonnegative(),
    seed: z.tuple([
      z.number().int().nonnegative().max(0xffff),
      z.number().int().nonnegative().max(0xffff),
      z.number().int().nonnegative().max(0xffff),
      z.number().int().nonnegative().max(0xffff),
    ]),
  })
  .catchall(z.json());
const decisionStatSchema = z
  .object({
    decisions: z.number().finite().optional(),
    fallbacks: z.number().finite().optional(),
    parse_failures: z.number().finite().optional(),
    tool_lookups: z.number().finite().optional(),
    move_selections: z.number().finite().optional(),
    switch_selections: z.number().finite().optional(),
    protect_selections: z.number().finite().optional(),
    consecutive_protect_selections: z.number().finite().optional(),
    spread_move_selections: z.number().finite().optional(),
    mega_selections: z.number().finite().optional(),
    lead_changes: z.number().finite().optional(),
    bring_changes: z.number().finite().optional(),
    cost: z.number().finite().optional(),
    reasoning_tokens: z.number().finite().optional(),
  })
  .catchall(z.json());
const decisionStatsSchema = z.strictObject({ p1: decisionStatSchema, p2: decisionStatSchema });
const seriesRecordSchema = z.object({
  schema_version: z.literal(SERIES_RECORD_SCHEMA_VERSION),
  mode: z.enum(["rotation", "exhibition", "tournament", "draft"]),
  timestamp: z.string().min(1),
  run_id: z.string().min(1),
  series_id: z.string().min(1),
  attempt_id: z.string().min(1).optional(),
  series_index: z.number().int().nonnegative(),
  format: z.string().min(1),
  pool: z.string().min(1).optional(),
  entrants: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  players: pidTextSchema,
  teams: pidTextSchema,
  winner: z.string().min(1).nullable(),
  winner_side: z.enum(["p1", "p2"]).nullable(),
  score: pidCountSchema,
  turns: z.number().int().nonnegative(),
  games: z.array(gameSchema),
  engine_seeds: z.partialRecord(z.enum(["p1", "p2"]), z.number().int()),
  timer_scale: z.union([z.literal("off"), z.number().positive()]).optional(),
  closed_sheets: z.literal(true).optional(),
  reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable(),
  sampling: z.literal("provider-default").optional(),
  reasoning_by_player: z
    .strictObject({
      p1: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable(),
      p2: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable(),
    })
    .optional(),
  decision_stats: decisionStatsSchema,
  contributor: z
    .strictObject({
      provider: z.literal("github"),
      subject: z.string().min(1),
      login: z.string().min(1),
    })
    .optional(),
  trade_window: z
    .strictObject({
      after_week: z.number().int().nonnegative(),
      trades_allowed: z.number().int().nonnegative().optional(),
    })
    .nullable()
    .optional(),
  transactions: z
    .array(
      z.strictObject({
        after_week: z.number().int().positive(),
        trades_allowed: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  roster_version: z.number().int().nonnegative().optional(),
  run_seed: z.number().int(),
  ps_commit: z.union([z.string().regex(/^[0-9a-f]{40}$/u), z.literal("unknown")]),
  seat: z.enum(["p1", "p2"]).optional(),
  dual_seat: z.boolean().optional(),
  execution_harnesses: z.json().optional(),
  round: z.number().int().positive().optional(),
  entrant_count: z.number().int().positive().optional(),
  seeds: z.json().optional(),
  provenance: z.json().optional(),
  advanced: z.string().min(1).optional(),
  stage: z.enum(["roundrobin", "playoff"]).optional(),
  board: z.string().min(1).optional(),
  origin: z.strictObject({ source: z.literal("import"), at: z.string().min(1) }).optional(),
});

export type ParsedSeriesRecord = z.infer<typeof seriesRecordSchema>;

export function parseSeriesRecord(value: JsonValue, label: string): ParsedSeriesRecord {
  const parsed = seriesRecordSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${label} is not a current series record: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Normalizes provider-qualified specs when joining one model across archived evidence. */
export function modelKey(spec: string): string {
  const model = spec.slice(spec.indexOf(":") + 1);
  return model
    .slice(model.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/:(?:nitro|floor|free)$/, "");
}

export const TEST_POOL = "test";

export function scopeRows<Row extends SeriesRecord>(rows: Row[], pool?: string): Row[] {
  return pool === undefined
    ? rows.filter((row) => row.pool !== TEST_POOL)
    : rows.filter((row) => row.pool === pool);
}

const rowCache = new Map<string, { mtimeMs: number; size: number; rows: ParsedSeriesRecord[] }>();

export class RecordsBusyError extends Error {}

interface RecordsMutation {
  load: () => ParsedSeriesRecord[];
  append: (row: JsonObject) => void;
  replace: (rows: readonly ParsedSeriesRecord[]) => void;
}

/** Holds the one records journal lease across a complete append, import, or removal transaction. */
export function mutateRecords<T>(file: string, task: (mutation: RecordsMutation) => T): T {
  let release: () => void;
  try {
    release = acquireLease(`${file}.lease`);
  } catch (error) {
    if (error instanceof LeaseBusyError) throw new RecordsBusyError(error.message);
    throw error;
  }
  const mutation: RecordsMutation = {
    load: () => loadSeriesRecords(file),
    append: (row) => {
      appendJsonlObject(file, parseSeriesRecord(row, `record appended to ${file}`));
      rowCache.delete(file);
    },
    replace: (rows) => {
      const staged = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(
          staged,
          rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
          {
            encoding: "utf8",
            flag: "wx",
          },
        );
        fs.renameSync(staged, file);
        rowCache.delete(file);
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
  try {
    return task(mutation);
  } finally {
    release();
  }
}

export function appendRow(file: string, row: JsonObject): void {
  mutateRecords(file, ({ append }) => append(row));
}

/** Cached by mtime and size; callers must treat the returned rows as immutable. */
export function loadSeriesRecords(file: string): ParsedSeriesRecord[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    rowCache.delete(file);
    return [];
  }
  const cached = rowCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rows;
  const rows = readJsonlObjects(file).map((row, index) =>
    parseSeriesRecord(row, `${file} row ${index + 1}`),
  );
  rowCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}
