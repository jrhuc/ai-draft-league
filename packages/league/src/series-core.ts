import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AgentContextEvent } from "./agent-context.js";
import type { DecisionLog } from "./battle-agent.js";
import { RandomEngine } from "./battle-agent.js";
import { LLMEngine } from "./llm-engine.js";
import type { ModelReasoningConfig, ReasoningLevel } from "./providers.js";
import { seededRng } from "./random.js";
import type { ShowdownReference } from "./reference.js";
import { loadShowdown } from "./showdown.js";
import type { ContributorAttribution, JsonObject, Pid, TimerScale } from "./types.js";

export interface ExperimentOptions extends ModelReasoningConfig {
  seed?: number;
  concurrency?: number;
  timerScale?: TimerScale;
  recordsPath?: string;
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  contributor?: ContributorAttribution;
  closedSheets?: boolean;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  task: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results: Array<R | undefined> = [];
  results.length = items.length;
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", forward, { once: true });
  let failure: { error: unknown } | undefined;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !controller.signal.aborted) {
      const index = next++;
      try {
        results[index] = await task(items[index]!, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          failure ??= { error };
          controller.abort();
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  signal?.removeEventListener("abort", forward);
  if (failure && !signal?.aborted) throw failure.error;
  return results.filter((result): result is R => result !== undefined);
}

export interface EngineSetup {
  pid: Pid;
  spec: string;
  seed: number;
  decisionLog: DecisionLog;
  traceLog: DecisionLog;
  contextLog?: DecisionLog;
  initialContext?: readonly AgentContextEvent[];
  format: string;
  psDir: string;
  reasoning?: ReasoningLevel | undefined;
  reference?: ShowdownReference | undefined;
  signal?: AbortSignal | undefined;
  apiKey?: string | undefined;
  initialNotebook?: string | undefined;
  draftRoster?: string | undefined;
  briefing?: string | undefined;
  closedSheets?: boolean | undefined;
}

export function makeEngine(setup: EngineSetup): RandomEngine | LLMEngine {
  const { pid, spec, seed, ...rest } = setup;
  if (spec === "random") return new RandomEngine(pid, seed, setup.decisionLog);
  return new LLMEngine(pid, spec, {
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    decisionLog: setup.decisionLog,
    traceLog: setup.traceLog,
    format: setup.format,
    psDir: setup.psDir,
  });
}

export interface ChanceEventCounts extends JsonObject {
  misses: number;
  crits_taken: number;
  flinched_turns: number;
  full_paralysis: number;
}

export interface ChanceEventCountsBySide {
  p1: ChanceEventCounts;
  p2: ChanceEventCounts;
}

export const gameSeedSchema = z.tuple([
  z.number().int().nonnegative().max(0xffff),
  z.number().int().nonnegative().max(0xffff),
  z.number().int().nonnegative().max(0xffff),
  z.number().int().nonnegative().max(0xffff),
]);
const sideCountSchema = z.strictObject({
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
});
const chanceEventCountsSchema = z.strictObject({
  misses: z.number().int().nonnegative(),
  crits_taken: z.number().int().nonnegative(),
  flinched_turns: z.number().int().nonnegative(),
  full_paralysis: z.number().int().nonnegative(),
});
const seriesGameSummaryFields = {
  winner: z.string().min(1).nullable(),
  winner_side: z.enum(["p1", "p2"]).nullable(),
  turns: z.number().int().nonnegative(),
  errors: sideCountSchema,
  model_choice_fallbacks: sideCountSchema,
  simulator_substitutions: sideCountSchema,
  timer_autodefaults: sideCountSchema,
  chance_events: z.strictObject({ p1: chanceEventCountsSchema, p2: chanceEventCountsSchema }),
  log: z.string().min(1),
};
export const seriesGameSummarySchema = z.strictObject(seriesGameSummaryFields);
export const seriesGameResultSchema = z.strictObject({
  number: z.number().int().positive(),
  seed: gameSeedSchema,
  ...seriesGameSummaryFields,
});

export type SeriesGameResult = z.infer<typeof seriesGameResultSchema>;

export function chanceEventCounts(log: string[]): ChanceEventCountsBySide {
  const counts: ChanceEventCountsBySide = {
    p1: { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
    p2: { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
  };
  for (const line of log) {
    if (!line.startsWith("|")) continue;
    const [, kind = "", ...args] = line.split("|");
    const pid = args[0]?.startsWith("p1") ? "p1" : args[0]?.startsWith("p2") ? "p2" : undefined;
    if (!pid) continue;
    if (kind === "-miss") counts[pid].misses += 1;
    else if (kind === "-crit") counts[pid].crits_taken += 1;
    else if (kind === "cant" && args[1] === "flinch") counts[pid].flinched_turns += 1;
    else if (kind === "cant" && args[1] === "par") counts[pid].full_paralysis += 1;
  }
  return counts;
}

export const SINGLE_ELIMINATION_GAME_LIMIT = 9;

export type GameSeed = [number, number, number, number];
const seriesResultObjectSchema = seriesGameResultSchema
  .pick({ number: true, seed: true, winner_side: true })
  .extend({ winner: seriesGameSummaryFields.winner.optional() })
  .loose();

export function seriesSeedSchedule(
  regulationSeeds: readonly GameSeed[],
  requireWinner = false,
): GameSeed[] {
  if (requireWinner && regulationSeeds.length !== 3) {
    throw new Error("single-elimination series requires exactly three regulation game seeds");
  }
  const seeds = regulationSeeds.map(([first, second, third, fourth]): GameSeed => [
    first,
    second,
    third,
    fourth,
  ]);
  if (!requireWinner) return seeds;
  const random = seededRng(JSON.stringify(regulationSeeds));
  while (seeds.length < SINGLE_ELIMINATION_GAME_LIMIT) {
    const seed: GameSeed = [
      1 + Math.floor(random() * 0xffff),
      1 + Math.floor(random() * 0xffff),
      1 + Math.floor(random() * 0xffff),
      1 + Math.floor(random() * 0xffff),
    ];
    seeds.push(seed);
  }
  return seeds;
}

export interface SeriesFold {
  score: Record<Pid, number>;
  winnerSide: Pid | undefined;
  complete: boolean;
  nextSeed: GameSeed | undefined;
}

export function foldSeriesGames(
  regulationSeeds: readonly GameSeed[],
  games: readonly unknown[],
  options: {
    requireWinner?: boolean | undefined;
    players?: Record<Pid, string> | undefined;
    label?: string | undefined;
  } = {},
): SeriesFold {
  const label = options.label ?? "series";
  const requireWinner = options.requireWinner === true;
  let seeds: GameSeed[];
  try {
    seeds = seriesSeedSchedule(regulationSeeds, requireWinner);
  } catch (cause) {
    throw new Error(`${label} ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const score = { p1: 0, p2: 0 };
  const isComplete = (count: number): boolean => {
    if (Math.max(score.p1, score.p2) >= 2) return true;
    if (count < regulationSeeds.length) return false;
    return !requireWinner || score.p1 !== score.p2;
  };
  for (const [index, value] of games.entries()) {
    if (isComplete(index))
      throw new Error(`${label} records game ${index + 1} after the series was clinched`);
    if (index >= SINGLE_ELIMINATION_GAME_LIMIT || index >= seeds.length) {
      throw new Error(`${label} exceeds the ${SINGLE_ELIMINATION_GAME_LIMIT}-game playoff limit`);
    }
    const parsedGame = seriesResultObjectSchema.safeParse(value);
    if (!parsedGame.success) {
      throw new Error(`${label} game ${index + 1} is not a result object`);
    }
    const game = parsedGame.data;
    if (game.number !== index + 1)
      throw new Error(`${label} game indexes are not consecutive from one`);
    if (!isDeepStrictEqual(game.seed, seeds[index])) {
      throw new Error(`${label} game ${index + 1} is not bound to its exact scheduled seed`);
    }
    const side = game.winner_side;
    if (options.players && game.winner !== (side === null ? null : options.players[side])) {
      throw new Error(`${label} game ${index + 1} winner does not match its scheduled side`);
    }
    if (side !== null) score[side] += 1;
  }
  const complete = games.length > 0 && isComplete(games.length);
  const winnerSide = score.p1 === score.p2 ? undefined : score.p1 > score.p2 ? "p1" : "p2";
  return {
    score,
    winnerSide,
    complete,
    nextSeed:
      complete || games.length >= SINGLE_ELIMINATION_GAME_LIMIT ? undefined : seeds[games.length],
  };
}

export function closedSheetsFormat(format: string, psDir: string): string {
  const { Dex } = loadShowdown(psDir);
  const ruleTable = Dex.formats.getRuleTable(Dex.formats.get(format));
  const repeals = [
    ...(ruleTable.has("forceopenteamsheets") ? ["!Force Open Team Sheets"] : []),
    ...(ruleTable.has("openteamsheets") ? ["!Open Team Sheets"] : []),
  ];
  return repeals.length ? `${format}@@@${repeals.join(",")}` : format;
}
