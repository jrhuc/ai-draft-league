import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { BracketView } from "./views.js";
import { defaultPsDir, RESULTS_PATH } from "./paths.js";
import type { ModelReasoningConfig } from "./providers.js";
import { validateModelExecution } from "./providers.js";
import { resolveSeed, seededRng, seriesEntropy, shuffle } from "./random.js";
import type { ParsedSeriesRecord, SeriesRecord } from "./records.js";
import { appendRow, loadSeriesRecords } from "./records.js";
import type { RotationEvent } from "./rotation.js";
import type { ExperimentOptions, RecordedSeriesContext } from "./series.js";
import { playRecordedSeries, readCompletedSeriesEvidence } from "./series.js";
import { showdownCommit } from "./showdown.js";
import type { PoolEvent, Team } from "./teams.js";
import { loadPool, validatePool, validateTeam } from "./teams.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import type { ContributorAttribution, JsonObject, Pid, TimerScale } from "./types.js";

export type TournamentEvent =
  | RotationEvent
  | { type: "bracket"; bracket: BracketView }
  | { type: "series-players"; index: number; players: Record<Pid, string> };

export type ProvenanceMode = "disclosed" | "blind";

export const DEFAULT_PROVENANCE: ProvenanceMode = "disclosed";

export interface TournamentOptions extends ExperimentOptions {
  pool?: string;
  teams?: Team[];
  format?: string;
  provenance?: ProvenanceMode;
  resume?: boolean;
  onEvent?: (event: TournamentEvent) => void;
}

interface Entrant {
  model: string;
  team: Team;
}

interface StoredTournament {
  entrants: Array<{ model: string; team: string }>;
}

interface PlayMatchContext extends ModelReasoningConfig {
  runDir: string;
  format: string;
  poolId: string | null;
  runSeed: number;
  psDir: string;
  seriesSeeds: {
    gameSeeds: Array<[number, number, number, number]>;
    engineSeeds: Record<Pid, number>;
  };
  briefing?: string;
  provenance: ProvenanceMode;
  apiKeys?: Readonly<Record<string, string>>;
  onEvent?: (event: TournamentEvent) => void;
  signal?: AbortSignal;
  contributor?: ContributorAttribution;
  timerScale: TimerScale;
}

interface PlayMatchResult {
  row: SeriesRecord;
  winnerSide: Pid;
}

export const tournamentConfigSchema = z.looseObject({
  mode: z.literal("tournament"),
  models: z.array(z.string()),
  seed: z.number(),
  concurrency: z.number().optional(),
  reasoning: z.string().nullable().optional(),
  reasoning_by_model: z.record(z.string(), z.string()).nullable().optional(),
  timer_scale: z.union([z.number(), z.literal("off")]).optional(),
  pool: z.string().nullable().optional(),
  format: z.string().optional(),
  provenance: z.enum(["disclosed", "blind"]).optional(),
  entrants: z.array(z.looseObject({ model: z.string().min(1), team: z.string().min(1) })).min(2),
});

function loadStoredTournament(runDir: string): StoredTournament {
  const configPath = path.join(runDir, "config.json");
  if (!fs.existsSync(configPath)) throw new Error(`${runDir} holds no tournament config to resume`);
  const config = tournamentConfigSchema.safeParse(JSON.parse(fs.readFileSync(configPath, "utf8")));
  if (!config.success) throw new Error(`${runDir} is not a resumable tournament run`);
  return { entrants: config.data.entrants.map(({ model, team }) => ({ model, team })) };
}

export function briefEvent(event: PoolEvent, count: number): string {
  const field = event.players ? `${event.players}-player ` : "";
  const where = [event.dates, event.location].filter(Boolean).join(", ");
  const lines = [
    `This bracket replays the top ${count} of ${event.name}, a ${field}${event.game} tournament played ${where} under ${event.regulation}${event.structure ? ` (${event.structure})` : ""}.`,
    "Every team here, yours and your opponent\u2019s alike, is one a player took to that top cut; nobody in this bracket built their own. Which of them placed where is not disclosed.",
  ];
  if (event.reconstructedSpreads)
    lines.push(
      "The published lists gave species, items, abilities, natures and moves but no stat points, so every spread here was rebuilt from public sets of the same Pok\u00e9mon in this regulation and is not the players\u2019 own.",
    );
  return lines.join("\n");
}

export interface BracketMatch {
  round: number;
  seriesIndex: number | null;
  slots: [number | null, number | null];
  winner: number | null;
}

/**
 * Classic single-elimination seed order: seed 0 meets the highest seed, so byes
 * (seeds beyond the entrant count) spread across distinct first-round matches.
 */
export function seedPositions(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((position) => [position, doubled - 1 - position]);
  }
  return order;
}

export function buildBracket(count: number): BracketMatch[][] {
  let size = 1;
  while (size < count) size *= 2;
  const order = seedPositions(size);
  let series = 0;
  const first: BracketMatch[] = [];
  for (let position = 0; position < size; position += 2) {
    const a = order[position]! < count ? order[position]! : null;
    const b = order[position + 1]! < count ? order[position + 1]! : null;
    const played = a !== null && b !== null;
    first.push({
      round: 0,
      seriesIndex: played ? series++ : null,
      slots: [a, b],
      winner: played ? null : (a ?? b),
    });
  }
  const rounds = [first];
  for (let width = size / 4; width >= 1; width /= 2) {
    rounds.push(
      Array.from({ length: width }, () => ({
        round: rounds.length,
        seriesIndex: series++,
        slots: [null, null] satisfies [number | null, number | null],
        winner: null,
      })),
    );
  }
  for (const [position, match] of first.entries()) {
    const next = rounds[1]?.[position >> 1];
    if (match.seriesIndex === null && next) next.slots[position % 2] = match.winner;
  }
  return rounds;
}

export function applyBracketOutcome(
  rounds: readonly (readonly BracketMatch[])[],
  scheduled: Readonly<BracketMatch>,
  winnerSide: Pid,
): BracketMatch[][] {
  if (scheduled.seriesIndex === null) throw new Error("a bye has no scheduled series outcome");
  const round = rounds[scheduled.round];
  const position = round?.findIndex((match) => match.seriesIndex === scheduled.seriesIndex) ?? -1;
  const current = position < 0 ? undefined : round![position];
  if (
    !current ||
    current.round !== scheduled.round ||
    current.slots[0] !== scheduled.slots[0] ||
    current.slots[1] !== scheduled.slots[1]
  ) {
    throw new Error(`bracket series ${scheduled.seriesIndex} is stale or is not scheduled here`);
  }
  if (current.slots[0] === null || current.slots[1] === null) {
    throw new Error(`bracket series ${scheduled.seriesIndex} has unresolved prerequisites`);
  }
  if (current.winner !== null)
    throw new Error(`bracket series ${scheduled.seriesIndex} already has an outcome`);

  const winner = current.slots[winnerSide === "p1" ? 0 : 1];
  const next = rounds[scheduled.round + 1]?.[position >> 1];
  const nextSide = position % 2;
  if (next && next.slots[nextSide] !== null) {
    throw new Error(
      `bracket series ${scheduled.seriesIndex} dependent slot already has an entrant`,
    );
  }

  const updated = rounds.map((round) => [...round]);
  const resolvedRound = [...round!];
  resolvedRound[position] = { ...current, winner };
  updated[scheduled.round] = resolvedRound;
  if (next) {
    const dependentRound = [...rounds[scheduled.round + 1]!];
    dependentRound[position >> 1] = { ...next, slots: [...next.slots] };
    dependentRound[position >> 1]!.slots[nextSide] = winner;
    updated[scheduled.round + 1] = dependentRound;
  }
  return updated;
}

export async function runTournament(
  models: string[],
  runDir: string,
  options: TournamentOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error("a tournament needs at least two models");

  fs.mkdirSync(runDir, { recursive: true });
  const runId = path.basename(runDir);
  const stored = options.resume ? loadStoredTournament(runDir) : undefined;
  if (stored && stored.entrants.length !== models.length) {
    throw new Error(
      `run ${runId} seats ${stored.entrants.length} entrants, not ${models.length}; it cannot resume`,
    );
  }
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
  const psDir = options.psDir ?? defaultPsDir();
  const seed = resolveSeed(options.seed);
  const timerScale = options.timerScale ?? DEFAULT_TIMER_SCALE;
  const random = seededRng(seed);

  let format: string;
  let poolId: string | null;
  let assignedTeams: Team[];
  let event: PoolEvent | null = null;
  if (options.teams) {
    if (options.teams.length !== models.length)
      throw new Error("inline tournaments need one team per model");
    if (!options.format) throw new Error("inline teams need an explicit format");
    format = options.format;
    for (const team of options.teams) {
      try {
        validateTeam(team.packed, format, psDir);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid team ${JSON.stringify(team.id)}: ${detail}`);
      }
    }
    poolId = null;
    assignedTeams = options.teams;
    fs.writeFileSync(
      path.join(runDir, "teams.json"),
      `${JSON.stringify(options.teams, null, 2)}\n`,
      "utf8",
    );
  } else {
    const pool = loadPool(options.pool ?? "test");
    validatePool(pool, psDir);
    if (pool.teams.length < models.length) {
      throw new Error(
        `pool ${JSON.stringify(pool.id)} has ${pool.teams.length} teams for ${models.length} entrants`,
      );
    }
    format = pool.format;
    poolId = pool.id;
    event = pool.event;
    const seeded = pool.teams.every((team) => team.seed !== undefined);
    assignedTeams = seeded
      ? [...pool.teams].sort((a, b) => a.seed! - b.seed!).slice(0, models.length)
      : shuffle(pool.teams, random).slice(0, models.length);
  }

  const placement = shuffle(
    models.map((_, index) => index),
    random,
  );
  const entrants: Entrant[] = placement.map((modelIndex, position) => ({
    model: stored ? stored.entrants[position]!.model : models[modelIndex]!,
    team: assignedTeams[position]!,
  }));
  if (stored) {
    for (const [position, entrant] of entrants.entries()) {
      const seat = stored.entrants[position]!;
      if (seat.team !== entrant.team.id) {
        throw new Error(
          `run ${runId} seats ${seat.team} at entrant ${position + 1}, not ${entrant.team.id}; it cannot resume`,
        );
      }
    }
  }
  validateModelExecution(
    entrants.map((entrant) => entrant.model),
    options,
  );
  const provenance = options.provenance ?? DEFAULT_PROVENANCE;
  const briefing =
    provenance === "disclosed" && event ? briefEvent(event, entrants.length) : undefined;
  let rounds = buildBracket(entrants.length);
  const seriesCount = entrants.length - 1;
  const seriesSeeds = Array.from({ length: seriesCount }, () => seriesEntropy(random));

  const bracketView = (): BracketView => ({
    entrants: entrants.map((entrant) => ({ model: entrant.model, team: entrant.team.id })),
    rounds: rounds.map((round) =>
      round.map((match) => ({
        seriesIndex: match.seriesIndex,
        slots: [...match.slots],
        winner: match.winner,
      })),
    ),
    champion: rounds[rounds.length - 1]![0]!.winner,
  });

  if (!stored)
    fs.writeFileSync(
      path.join(runDir, "config.json"),
      `${JSON.stringify(
        {
          mode: "tournament",
          models,
          seed,
          concurrency: options.concurrency ?? 4,
          reasoning: options.reasoning ?? null,
          pool: poolId,
          reasoning_by_model: options.reasoningByModel ?? null,
          timer_scale: timerScale,
          format,
          provenance,
          event: event?.name ?? null,
          entrants: entrants.map((entrant) => ({
            model: entrant.model,
            team: entrant.team.id,
            seed: entrant.team.seed ?? null,
            placement: entrant.team.provenance?.placement ?? null,
          })),
          contributor: options.contributor ?? null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

  const playersFor = (match: BracketMatch) => ({
    p1: match.slots[0] === null ? "TBD" : entrants[match.slots[0]]!.model,
    p2: match.slots[1] === null ? "TBD" : entrants[match.slots[1]]!.model,
  });
  options.onEvent?.({
    type: "plans",
    mode: "tournament",
    plans: rounds
      .flat()
      .filter((match) => match.seriesIndex !== null)
      .sort((a, b) => a.seriesIndex! - b.seriesIndex!)
      .map((match) => ({ index: match.seriesIndex!, players: playersFor(match) })),
    pool: poolId ?? "",
    seed,
  });

  const validateStoredMatch = (match: BracketMatch, row: ParsedSeriesRecord): Pid => {
    const index = match.seriesIndex!;
    const sides = { p1: entrants[match.slots[0]!]!, p2: entrants[match.slots[1]!]! };
    const evidenceContext: RecordedSeriesContext = {
      players: { p1: sides.p1.model, p2: sides.p2.model },
      teams: { p1: sides.p1.team, p2: sides.p2.team },
      seriesIndex: index,
      gameSeeds: seriesSeeds[index]!.gameSeeds,
      engineSeeds: seriesSeeds[index]!.engineSeeds,
      format,
      psDir,
      runDir,
      requireWinner: true,
      timerScale,
      briefings: briefing === undefined ? undefined : { p1: briefing, p2: briefing },
      reasoningByModel: options.reasoningByModel,
      reasoning: options.reasoning,
    };
    const canonical = readCompletedSeriesEvidence(evidenceContext);
    if (!canonical.winnerSide) {
      throw new Error(`run ${runId} tournament series ${index} has no canonical winner`);
    }
    const storedFields: JsonObject = {
      series_id: row.series_id,
      attempt_id: row.attempt_id,
      format: row.format,
      players: row.players,
      teams: row.teams,
      winner: row.winner,
      winner_side: row.winner_side,
      score: row.score,
      turns: row.turns,
      games: row.games,
      engine_seeds: row.engine_seeds,
      timer_scale: row.timer_scale,
      reasoning: row.reasoning,
      sampling: "provider-default",
    };
    if (row.closed_sheets !== undefined) storedFields.closed_sheets = row.closed_sheets;
    if (row.reasoning_by_player !== undefined)
      storedFields.reasoning_by_player = row.reasoning_by_player;
    const winner = match.slots[canonical.winnerSide === "p1" ? 0 : 1]!;
    if (
      row.schema_version !== 1 ||
      row.mode !== "tournament" ||
      row.series_index !== index ||
      row.round !== match.round + 1 ||
      row.entrant_count !== entrants.length ||
      !isDeepStrictEqual(row.seeds, { p1: match.slots[0], p2: match.slots[1] }) ||
      row.provenance !== provenance ||
      row.pool !== (poolId ?? undefined) ||
      row.advanced !== entrants[winner]!.model ||
      row.run_seed !== seed ||
      row.ps_commit !== showdownCommit(psDir) ||
      !isDeepStrictEqual(storedFields, canonical.fields)
    ) {
      throw new Error(
        `run ${runId} tournament series ${index} does not match its canonical completed series evidence`,
      );
    }
    return canonical.winnerSide;
  };

  const results: SeriesRecord[] = [];
  const started = new Set<number>();
  if (stored) {
    const recorded = new Map<number, ParsedSeriesRecord>();
    for (const row of loadSeriesRecords(recordsPath)) {
      if (row.run_id !== runId || row.mode !== "tournament") continue;
      const index = row.series_index;
      if (recorded.has(index))
        throw new Error(`run ${runId} repeats tournament series ${index}; it cannot resume`);
      recorded.set(index, row);
    }
    let settled = true;
    while (settled) {
      settled = false;
      for (const match of rounds.flat()) {
        if (match.seriesIndex === null || started.has(match.seriesIndex)) continue;
        if (match.slots[0] === null || match.slots[1] === null) continue;
        const row = recorded.get(match.seriesIndex);
        if (!row) continue;
        const winnerSide = validateStoredMatch(match, row);
        rounds = applyBracketOutcome(rounds, match, winnerSide);
        started.add(match.seriesIndex);
        results.push(row);
        options.onEvent?.({ type: "series-end", index: match.seriesIndex, record: row });
        settled = true;
      }
    }
  }
  options.onEvent?.({ type: "bracket", bracket: bracketView() });

  const active = new Set<Promise<void>>();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, seriesCount));
  let failure: { error: unknown } | undefined;

  const runMatch = async (match: BracketMatch): Promise<void> => {
    try {
      const matchContext: PlayMatchContext = {
        runDir,
        format,
        poolId,
        runSeed: seed,
        psDir,
        signal: controller.signal,
        seriesSeeds: seriesSeeds[match.seriesIndex!]!,
        provenance,
        timerScale,
        briefing,
        reasoning: options.reasoning,
        apiKeys: options.apiKeys,
        reasoningByModel: options.reasoningByModel,
        onEvent: options.onEvent,
        contributor: options.contributor,
      };
      const { row, winnerSide } = await playMatch(match, entrants, matchContext);
      rounds = applyBracketOutcome(rounds, match, winnerSide);
      appendRow(recordsPath, row);
      results.push(row);
      options.onEvent?.({ type: "series-end", index: match.seriesIndex!, record: row });
      options.onEvent?.({ type: "bracket", bracket: bracketView() });
    } catch (error) {
      if (!controller.signal.aborted) {
        failure ??= { error };
        controller.abort();
      }
    }
  };

  const startReady = (): void => {
    while (active.size < concurrency && !controller.signal.aborted) {
      const match = rounds
        .flat()
        .find(
          (candidate) =>
            candidate.seriesIndex !== null &&
            candidate.slots[0] !== null &&
            candidate.slots[1] !== null &&
            !started.has(candidate.seriesIndex),
        );
      if (!match) break;
      started.add(match.seriesIndex!);
      const task = runMatch(match);
      active.add(task);
      void task.finally(() => {
        active.delete(task);
        startReady();
      });
    }
  };

  startReady();
  while (active.size) await Promise.race(active);
  options.signal?.removeEventListener("abort", forwardAbort);
  if (failure && !options.signal?.aborted) throw failure.error;
  results.sort((a, b) => a.series_index! - b.series_index!);
  return results;
}
async function playMatch(
  match: BracketMatch,
  entrants: Entrant[],
  context: PlayMatchContext,
): Promise<PlayMatchResult> {
  context.signal?.throwIfAborted();
  const index = match.seriesIndex!;
  const sides = { p1: entrants[match.slots[0]!]!, p2: entrants[match.slots[1]!]! };
  const players = { p1: sides.p1.model, p2: sides.p2.model };
  context.onEvent?.({ type: "series-players", index, players });
  context.onEvent?.({ type: "series-start", index });
  const seriesContext: RecordedSeriesContext = {
    players,
    teams: { p1: sides.p1.team, p2: sides.p2.team },
    seriesIndex: index,
    gameSeeds: context.seriesSeeds.gameSeeds,
    engineSeeds: context.seriesSeeds.engineSeeds,
    format: context.format,
    psDir: context.psDir,
    runDir: context.runDir,
    requireWinner: true,
    timerScale: context.timerScale,
    onGameUpdate: (game, lines, publicLines) =>
      context.onEvent?.({ type: "game-update", index, game, lines, publicLines }),
    onGameEnd: (game, winner, turns, score) =>
      context.onEvent?.({ type: "game-end", index, game, winner, turns, score }),
    onDecision: (pid, row) => context.onEvent?.({ type: "decision", index, pid, row }),
    briefings:
      context.briefing === undefined ? undefined : { p1: context.briefing, p2: context.briefing },
    reasoningByModel: context.reasoningByModel,
    reasoning: context.reasoning,
    apiKeys: context.apiKeys,
    signal: context.signal,
  };
  const { winnerSide, fields } = await playRecordedSeries(seriesContext);

  if (!winnerSide) throw new Error(`single-elimination series ${index + 1} ended without a winner`);
  const winner = match.slots[winnerSide === "p1" ? 0 : 1]!;
  const row: SeriesRecord = {
    schema_version: 1,
    mode: "tournament",
    series_index: index,
    round: match.round + 1,
    entrant_count: entrants.length,
    seeds: { p1: match.slots[0], p2: match.slots[1] },
    provenance: context.provenance,
    advanced: entrants[winner]!.model,
    run_seed: context.runSeed,
    ps_commit: showdownCommit(context.psDir),
    ...fields,
  };
  if (context.poolId !== null) row.pool = context.poolId;
  if (context.contributor !== undefined) row.contributor = context.contributor;
  return { row, winnerSide };
}
