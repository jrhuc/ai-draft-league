import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentContextEvent } from "./agent-context.js";
import type {
  DecisionLog,
  DecisionStatName,
  DecisionStats,
  GameEnd,
  GameStart,
} from "./battle-agent.js";
import { DECISION_STAT_NAMES, RandomEngine } from "./battle-agent.js";
import { appendJsonlObject, readJsonlObjects } from "./jsonl.js";
import { reasoningForModel } from "./providers.js";
import { commitRunArtifact, readRunArtifacts } from "./run-artifact-store.js";
import { ShowdownReference } from "./reference.js";
import {
  readCompletedSeriesDecisionRows,
  readCompletedSeriesEvidence,
  recordedSeriesIdentity,
  seriesDirectory,
} from "./recorded-series.js";
import type { RecordedSeriesIdentity } from "./recorded-series.js";
import { LLMEngine } from "./llm-engine.js";
import type {
  RecordedSeries,
  RecordedSeriesContext,
  RecordedSeriesFields,
} from "./recorded-series.js";
import { SimBattle } from "./sim.js";
import type { LiveGame } from "./public/live-protocol.js";
import {
  chanceEventCounts,
  closedSheetsFormat,
  foldSeriesGames,
  makeEngine,
  seriesGameResultSchema,
  SINGLE_ELIMINATION_GAME_LIMIT,
} from "./series-core.js";
import type { EngineSetup } from "./series-core.js";
import type { Team } from "./teams.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import type { BattleOutcome, JsonObject, Pid, TimerScale } from "./types.js";
import {
  abortSeriesAttempt,
  completeStoredAdaptation,
  createStoredSeries,
  findStoredSeries,
  finishSeriesAttempt,
  latestSeriesMemory,
  pendingSeriesAdaptations,
  readStoredSeries,
  resolveStoredGame,
  startSeriesAttempt,
} from "./series-store.js";

export interface Bo3Context {
  engines: Record<Pid, RandomEngine | LLMEngine>;
  names: Record<Pid, string>;
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  seriesId: string;
  seriesDir: string;
  runDir: string;
  format: string;
  psDir: string;
  timerScale?: TimerScale;
  attemptId?: string;
  signal?: AbortSignal;
  onGameStart?: (game: number) => void;
  onLiveGame?: (game: LiveGame) => void;
  onGameUpdate?: (game: number, lines: string[], publicLines: string[]) => void;
  onGameEnd?: (
    game: number,
    winner: string | null,
    turns: number,
    score: Record<Pid, number>,
  ) => void;
  requireWinner?: boolean;
  tournamentRound?: "round" | "final";
  completedGames?: JsonObject[];
  runBattle?: (
    seed: [number, number, number, number],
    onUpdate: (lines: string[], publicLines: string[]) => void,
  ) => Promise<BattleOutcome>;
}

export interface Bo3Result {
  score: Record<Pid, number>;
  games: JsonObject[];
  winnerSide: Pid | undefined;
}

export async function playBo3(context: Bo3Context): Promise<Bo3Result> {
  const { engines, names, seriesId, runDir } = context;
  const submissionNamespace = context.attemptId ?? randomUUID();
  const ownsAttempt = context.attemptId === undefined;
  let stored = ownsAttempt ? readStoredSeries(runDir, seriesId) : undefined;
  if (ownsAttempt && !stored) {
    const identity = {
      players: context.players,
      team_ids: { p1: context.teams.p1.id, p2: context.teams.p2.id },
      packed_teams: { p1: context.teams.p1.packed, p2: context.teams.p2.packed },
      format: context.format,
      game_seeds: context.gameSeeds,
      series_index: null,
      engine_seeds: { p1: 0, p2: 0 },
      showdown_commit: "unknown",
      scaffold: {
        timer_scale: context.timerScale ?? DEFAULT_TIMER_SCALE,
        require_winner: context.requireWinner ?? false,
        closed_sheets: false,
        reasoning: null,
        reasoning_by_model: null,
        initial_notebook_digests: { p1: null, p2: null },
        draft_roster_digests: { p1: null, p2: null },
        briefing_digests: { p1: null, p2: null },
      },
    } satisfies RecordedSeriesIdentity;
    createStoredSeries(runDir, seriesId, new Date().toISOString(), identity);
    stored = readStoredSeries(runDir, seriesId);
  }
  if (ownsAttempt) {
    startSeriesAttempt({
      runDir,
      seriesId,
      attemptId: submissionNamespace,
      adoptedGames: stored?.games.length ?? 0,
    });
    if (stored) {
      for (const adaptation of pendingSeriesAdaptations(stored)) {
        const memoryState = await engines[adaptation.pid].completeGameEnd(adaptation.task);
        completeStoredAdaptation({
          runDir,
          seriesId,
          gameNumber: adaptation.gameNumber,
          pid: adaptation.pid,
          memoryState,
        });
      }
    }
  }
  const games: JsonObject[] = [
    ...(context.completedGames ?? stored?.games.map((game) => game.result) ?? []),
  ];
  let folded = foldSeriesGames(context.gameSeeds, games, {
    requireWinner: context.requireWinner,
    players: context.players,
  });

  while (!folded.complete) {
    const gameSeed = folded.nextSeed;
    if (!gameSeed) {
      throw new Error(
        `single-elimination series remained tied after ${SINGLE_ELIMINATION_GAME_LIMIT} games`,
      );
    }
    const score = folded.score;
    const index = games.length;
    context.signal?.throwIfAborted();
    const gameNumber = index + 1;
    const gameId = `${seriesId}-${gameNumber}${context.timerScale && context.timerScale !== "off" ? `-${submissionNamespace}` : ""}`;
    const start: GameStart = { gameId, gameNumber, seriesId, seriesScore: { ...score } };
    for (const engine of Object.values(engines)) engine.beginGame(start);
    context.onGameStart?.(gameNumber);
    const live: LiveGame = {
      seriesId,
      game: gameNumber,
      attempt: submissionNamespace,
      players: context.players,
      score: { ...score },
      raw: "",
      turn: 0,
      winner: null,
      state: "playing",
    };
    context.onLiveGame?.(live);
    const players = {
      p1: { name: names.p1, team: context.teams.p1.packed },
      p2: { name: names.p2, team: context.teams.p2.packed },
    };
    const logPath = path.join(context.seriesDir, `game-${gameNumber}.log`);
    fs.writeFileSync(logPath, "", "utf8");
    const onUpdate = (lines: string[], publicLines: string[]) => {
      if (lines.length) fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
      if (publicLines.length) {
        live.raw += `${publicLines.join("\n")}\n`;
        for (const line of publicLines) {
          if (line.startsWith("|turn|")) live.turn = Number(line.slice(6));
        }
        context.onLiveGame?.(live);
      }
      context.onGameUpdate?.(gameNumber, lines, publicLines);
    };
    const outcome = context.runBattle
      ? await context.runBattle(gameSeed, onUpdate)
      : await new SimBattle(
          context.format,
          players,
          gameSeed,
          context.psDir,
          context.timerScale ?? DEFAULT_TIMER_SCALE,
          undefined,
          `${submissionNamespace}:${gameNumber}`,
        ).run(engines, onUpdate, context.signal);
    context.signal?.throwIfAborted();
    const winnerSide = (["p1", "p2"] as const).find((pid) => names[pid] === outcome.winner);
    if (winnerSide) score[winnerSide] += 1;
    live.state = "ended";
    live.winner = winnerSide ? context.players[winnerSide] : null;
    live.score = { ...score };
    context.onLiveGame?.(live);
    const nextFolded = foldSeriesGames(
      context.gameSeeds,
      [
        ...games,
        {
          number: gameNumber,
          seed: gameSeed,
          winner: winnerSide ? context.players[winnerSide] : null,
          winner_side: winnerSide ?? null,
        },
      ],
      { requireWinner: context.requireWinner, players: context.players },
    );
    const seriesOver = nextFolded.complete;
    const endFor = (pid: Pid): GameEnd => {
      return {
        outcome: {
          winner: outcome.winner,
          winner_side: winnerSide ?? null,
          won: winnerSide === pid,
          turns: outcome.turns,
          pov_lines: outcome.pov[pid],
          errors: outcome.errors[pid],
          simulator_substitutions: outcome.simulatorSubstitutions[pid],
          timer_autodefaults: outcome.timerAutodefaults[pid],
        },
        gameNumber,
        seriesOver,
        seriesScore: { ...score },
        tournamentStatus:
          context.tournamentRound === undefined
            ? undefined
            : !seriesOver
              ? "active"
              : nextFolded.winnerSide === pid
                ? context.tournamentRound === "final"
                  ? "champion"
                  : "advancing"
                : "eliminated",
      };
    };
    const ends = { p1: endFor("p1"), p2: endFor("p2") };
    const canonicalLog = Buffer.from(`${outcome.log.join("\n")}\n`, "utf8");
    fs.writeFileSync(logPath, canonicalLog);
    const result = seriesGameResultSchema.parse({
      number: gameNumber,
      seed: gameSeed,
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      turns: outcome.turns,
      errors: outcome.errors,
      simulator_substitutions: outcome.simulatorSubstitutions,
      timer_autodefaults: outcome.timerAutodefaults,
      chance_events: chanceEventCounts(outcome.log),
      log: path.relative(runDir, logPath),
    });
    const adaptations = {
      p1: engines.p1.prepareGameEnd(ends.p1),
      p2: engines.p2.prepareGameEnd(ends.p2),
    };
    resolveStoredGame({
      runDir,
      seriesId,
      attemptId: submissionNamespace,
      gameNumber,
      seed: gameSeed,
      result,
      logPath,
      logBytes: canonicalLog,
      adaptations,
    });
    await Promise.all(
      (["p1", "p2"] as const).map(async (pid) => {
        const memoryState = await engines[pid].completeGameEnd(adaptations[pid]);
        completeStoredAdaptation({
          runDir,
          seriesId,
          gameNumber,
          pid,
          memoryState,
        });
      }),
    );
    games.push(result);
    context.onGameEnd?.(
      gameNumber,
      winnerSide ? context.players[winnerSide] : null,
      outcome.turns,
      { ...score },
    );
    folded = foldSeriesGames(context.gameSeeds, games, {
      requireWinner: context.requireWinner,
      players: context.players,
    });
  }

  if (ownsAttempt) finishSeriesAttempt(runDir, seriesId, submissionNamespace);
  return { score: folded.score, games, winnerSide: folded.winnerSide };
}

const numericDecisionStatSchema = z.number();
const decisionActionSchema = z.string();
const persistedAgentContextSchema = z.looseObject({
  kind: z.literal("agent_context"),
  pid: z.enum(["p1", "p2"]),
  series_id: z.string(),
  context_id: z.string(),
  sequence: z.number(),
  context_kind: z.enum(["episode", "observation", "decision", "reflection"]),
  payload: z.record(z.string(), z.json()),
});

function projectedDecisionStats(rows: JsonObject[]): DecisionStats {
  const stats: DecisionStats = {};
  const add = (key: DecisionStatName, value = 1) => {
    stats[key] = (stats[key] ?? 0) + value;
  };
  for (const row of rows) {
    if (row.kind === "game_reflection") {
      add("reflections");
      const reasoningTokens = numericDecisionStatSchema.safeParse(row.reasoning_tokens);
      if (reasoningTokens.success) add("reasoning_tokens", reasoningTokens.data);
      const cost = numericDecisionStatSchema.safeParse(row.cost);
      if (cost.success) add("cost", cost.data);
      continue;
    }
    if (row.kind !== "decision") continue;
    if (row.submission_source !== "model" && row.submission_source !== "model-default") continue;
    if (row.automatic === true) continue;
    add("decisions");
    if (Array.isArray(row.tool_lookups)) add("tool_lookups", row.tool_lookups.length);
    const parseFailures = numericDecisionStatSchema.safeParse(row.parse_failures);
    if (parseFailures.success) add("parse_failures", parseFailures.data);
    const reasoningTokens = numericDecisionStatSchema.safeParse(row.reasoning_tokens);
    if (reasoningTokens.success) add("reasoning_tokens", reasoningTokens.data);
    const cost = numericDecisionStatSchema.safeParse(row.cost);
    if (cost.success) add("cost", cost.data);
    if (row.requested_choices !== undefined) add("substituted_actions");
    const parsedAction = decisionActionSchema.safeParse(row.action);
    const action = parsedAction.success ? parsedAction.data : "";
    const parts = action.split(",");
    add("move_selections", parts.filter((part) => /(?:^|\s)move\s/.test(part)).length);
    add("switch_selections", parts.filter((part) => /(?:^|\s)switch\s/.test(part)).length);
    add("mega_selections", parts.filter((part) => part.trimEnd().endsWith(" mega")).length);
    add("ally_target_selections", parts.filter((part) => / -[12](?:\s|$)/.test(part)).length);
    if (row.phase === "team_preview") add("team_previews");
    if (Array.isArray(row.selection)) {
      add(
        "protect_selections",
        row.selection.filter((label) => /^Protect(?:\b|\s)/i.test(String(label))).length,
      );
      add(
        "spread_move_selections",
        row.selection.filter((label) =>
          /\((?:both foes|your side|all adjacent|spread)/i.test(String(label)),
        ).length,
      );
    }
  }
  return stats;
}

function combinedDecisionStats(restored: DecisionStats, current: DecisionStats): DecisionStats {
  const combined = { ...current };
  for (const key of DECISION_STAT_NAMES) {
    const value = restored[key];
    if (value !== undefined) combined[key] = (combined[key] ?? 0) + value;
  }
  if (combined.cost !== undefined) combined.cost = Math.round(combined.cost * 1e6) / 1e6;
  return combined;
}

function loadAgentContext(runDir: string, seriesId: string, pid: Pid): AgentContextEvent[] {
  const events: AgentContextEvent[] = [];
  const rows = readRunArtifacts(runDir, `series-context:${seriesId}:${pid}`);
  for (const [index, { value }] of rows.entries()) {
    const parsed = persistedAgentContextSchema.safeParse(value);
    const sequence = events.length + 1;
    if (
      !parsed.success ||
      parsed.data.pid !== pid ||
      parsed.data.series_id !== seriesId ||
      parsed.data.context_id !== `ctx-${String(sequence).padStart(8, "0")}` ||
      parsed.data.sequence !== sequence
    ) {
      throw new Error(`invalid ${pid} context row ${index + 1}`);
    }
    events.push({
      id: parsed.data.context_id,
      sequence,
      kind: parsed.data.context_kind,
      payload: parsed.data.payload,
    });
  }
  return events;
}

async function runRecordedSeries(context: RecordedSeriesContext): Promise<RecordedSeries> {
  context.signal?.throwIfAborted();
  const timerScale = context.timerScale ?? DEFAULT_TIMER_SCALE;
  const identity = recordedSeriesIdentity(context);
  const adopted =
    context.seriesIndex === undefined
      ? undefined
      : findStoredSeries(context.runDir, context.seriesIndex, identity);
  const seriesId = adopted?.seriesId ?? randomUUID().replaceAll("-", "").slice(0, 12);
  const seriesDir = seriesDirectory(context.runDir, seriesId);
  const decisionRows = (pid: Pid) => readCompletedSeriesDecisionRows(context.runDir, seriesId, pid);
  if (adopted?.completedAttemptId) {
    const canonical = readCompletedSeriesEvidence(context);
    return {
      coachNotes: canonical.coachNotes,
      winnerSide: canonical.winnerSide,
      fields: {
        timestamp: adopted.startedAt,
        run_id: path.basename(context.runDir),
        ...canonical.fields,
        decision_stats: {
          p1: projectedDecisionStats(decisionRows("p1")),
          p2: projectedDecisionStats(decisionRows("p2")),
        },
      },
    };
  }
  const started = adopted?.startedAt ?? new Date().toISOString();
  fs.mkdirSync(seriesDir, { recursive: true });
  if (!adopted) createStoredSeries(context.runDir, seriesId, started, identity);
  const attemptId = randomUUID();
  startSeriesAttempt({
    runDir: context.runDir,
    seriesId,
    attemptId,
    adoptedGames: adopted?.games.length ?? 0,
  });

  try {
    const names = { p1: `p1-${context.players.p1}`, p2: `p2-${context.players.p2}` };
    const reference = Object.values(context.players).some((player) => player !== "random")
      ? new ShowdownReference(context.format, context.psDir)
      : undefined;
    const reasoning = {
      p1: reasoningForModel(context.players.p1, context),
      p2: reasoningForModel(context.players.p2, context),
    };
    const decisionSink = (pid: Pid): DecisionLog => {
      const file = path.join(seriesDir, `${pid}-decisions.jsonl`);
      let first = true;
      return (row) => {
        const recordedRow = { ...row, attempt_id: attemptId };
        if (first) appendJsonlObject(file, recordedRow);
        else fs.appendFileSync(file, `${JSON.stringify(recordedRow)}\n`, "utf8");
        first = false;
        context.onDecision?.(pid, recordedRow);
      };
    };
    const contextSink =
      (pid: Pid): DecisionLog =>
      (row) => {
        const contextId = z.string().min(1).safeParse(row.context_id);
        if (!contextId.success) throw new Error(`${pid} context event has no identity`);
        commitRunArtifact(context.runDir, `series-context:${seriesId}:${pid}`, contextId.data, row);
      };

    const engineFor = (pid: Pid) => {
      const setup: EngineSetup = {
        runAgent: context.agents.run,
        pid,
        spec: context.players[pid],
        seed: context.engineSeeds[pid],
        decisionLog: decisionSink(pid),
        traceLog: path.join(seriesDir, `${pid}-trace.jsonl`),
        contextLog: contextSink(pid),
        initialContext: adopted ? loadAgentContext(context.runDir, seriesId, pid) : [],
        format: context.format,
        psDir: context.psDir,
        reasoning: reasoning[pid],
        reference,
        signal: context.signal,
        initialNotebook: adopted
          ? (latestSeriesMemory(adopted, pid) ?? context.initialNotebooks?.[pid])
          : context.initialNotebooks?.[pid],
        draftRoster: context.draftRosters?.[pid],
        briefing: context.briefings?.[pid],
        closedSheets: context.closedSheets,
      };
      return makeEngine(setup);
    };
    const engines = { p1: engineFor("p1"), p2: engineFor("p2") };
    if (adopted) {
      for (const adaptation of pendingSeriesAdaptations(adopted)) {
        const memoryState = await engines[adaptation.pid].completeGameEnd(adaptation.task);
        completeStoredAdaptation({
          runDir: context.runDir,
          seriesId,
          gameNumber: adaptation.gameNumber,
          pid: adaptation.pid,
          memoryState,
        });
      }
    }
    const battleFormat = context.closedSheets
      ? closedSheetsFormat(context.format, context.psDir)
      : context.format;
    const battleContext: Bo3Context = {
      engines,
      names,
      players: context.players,
      teams: context.teams,
      gameSeeds: context.gameSeeds,
      seriesId,
      seriesDir,
      runDir: context.runDir,
      onLiveGame: context.agents.live.game,
      format: battleFormat,
      psDir: context.psDir,
      timerScale,
      attemptId,
      requireWinner: context.requireWinner,
      tournamentRound: context.tournamentRound,
      signal: context.signal,
      onGameUpdate: context.onGameUpdate,
      onGameEnd: context.onGameEnd,
    };
    if (adopted?.games.length) {
      battleContext.completedGames = adopted.games.map((game) => game.result);
    }
    const adoptedRows = (pid: Pid): JsonObject[] => {
      if (!adopted) return [];
      const owners = new Map(adopted.games.map((game) => [game.gameNumber, game.attemptId]));
      return readJsonlObjects(path.join(seriesDir, `${pid}-decisions.jsonl`)).filter(
        (row) => owners.get(Number(row.game_number)) === row.attempt_id,
      );
    };
    const { score, games, winnerSide } = await playBo3(battleContext);
    const stats = {
      p1: combinedDecisionStats(
        projectedDecisionStats(adoptedRows("p1")),
        engines.p1.decisionStats(),
      ),
      p2: combinedDecisionStats(
        projectedDecisionStats(adoptedRows("p2")),
        engines.p2.decisionStats(),
      ),
    };
    const fields: RecordedSeriesFields = {
      timestamp: started,
      run_id: path.basename(context.runDir),
      series_id: seriesId,
      attempt_id: attemptId,
      format: context.format,
      players: context.players,
      teams: { p1: context.teams.p1.id, p2: context.teams.p2.id },
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      score,
      turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
      games,
      engine_seeds: context.engineSeeds,
      timer_scale: timerScale,
      reasoning: context.reasoning ?? null,
      sampling: "provider-default",
      decision_stats: stats,
    };
    if (context.closedSheets) fields.closed_sheets = true;
    if (context.reasoningByModel !== undefined) {
      fields.reasoning_by_player = { p1: reasoning.p1 ?? null, p2: reasoning.p2 ?? null };
    }
    const result: RecordedSeries = {
      coachNotes: { p1: engines.p1.coachingState(), p2: engines.p2.coachingState() },
      winnerSide,
      fields,
    };
    finishSeriesAttempt(context.runDir, seriesId, attemptId);
    return result;
  } catch (error) {
    abortSeriesAttempt(
      context.runDir,
      seriesId,
      attemptId,
      error instanceof Error ? error : String(error),
    );
    throw error;
  }
}

export class MatchRunner {
  constructor(private readonly context: RecordedSeriesContext) {}

  run(): Promise<RecordedSeries> {
    return runRecordedSeries(this.context);
  }
}
