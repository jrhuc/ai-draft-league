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
import { appendJsonlObject } from "./jsonl.js";
import { LLMEngine } from "./llm-engine.js";
import { reasoningForModel } from "./providers.js";
import { ShowdownReference } from "./reference.js";
import { SimBattle } from "./sim.js";
import type { Team } from "./teams.js";
import { DEFAULT_TIMER_SCALE } from "./timer.js";
import type { BattleOutcome, JsonObject, Pid, TimerScale } from "./types.js";
import {
  closedSheetsFormat,
  foldSeriesGames,
  makeEngine,
  SINGLE_ELIMINATION_GAME_LIMIT,
} from "./series-core.js";
import type { EngineSetup } from "./series-core.js";
import {
  adoptSeriesDir,
  appendAttemptRecord,
  attemptRecord,
  completedGameEvidence,
  contextLedgerHeads,
  gameCompletionMarkerPath,
  incompleteAttempts,
  RECORDED_SERIES_METADATA_SCHEMA_VERSION,
  recordedSeriesIdentity,
  recordedSeriesMetadataSchema,
  relativeSeriesFile,
  writeGameCompletionMarker,
} from "./recorded-series.js";
import type {
  RecordedSeries,
  RecordedSeriesContext,
  RecordedSeriesFields,
} from "./recorded-series.js";

export interface Bo3Context {
  engines: Record<Pid, RandomEngine | LLMEngine>;
  names: Record<Pid, string>;
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  seriesId: string;
  seriesDir: string;
  format: string;
  psDir: string;
  timerScale?: TimerScale;
  attemptId?: string;
  signal?: AbortSignal;
  onGameStart?: (game: number) => void;
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
  const { engines, names, seriesId } = context;
  const submissionNamespace = context.attemptId ?? randomUUID();
  const games: JsonObject[] = [...(context.completedGames ?? [])];
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
    const gameId = `${seriesId}-${gameNumber}`;
    fs.rmSync(gameCompletionMarkerPath(context.seriesDir, gameNumber), { force: true });
    const start: GameStart = { gameId, gameNumber, seriesId, seriesScore: { ...score } };
    const modelFallbacksAtStart = {
      p1: engines.p1.decisionStats().fallbacks ?? 0,
      p2: engines.p2.decisionStats().fallbacks ?? 0,
    };
    for (const engine of Object.values(engines)) engine.beginGame(start);
    context.onGameStart?.(gameNumber);
    const players = {
      p1: { name: names.p1, team: context.teams.p1.packed },
      p2: { name: names.p2, team: context.teams.p2.packed },
    };
    const logPath = path.join(context.seriesDir, `game-${gameNumber}.log`);
    fs.writeFileSync(logPath, "", "utf8");
    const onUpdate = (lines: string[], publicLines: string[]) => {
      if (lines.length) fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
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
    const modelChoiceFallbacks = {
      p1: (engines.p1.decisionStats().fallbacks ?? 0) - modelFallbacksAtStart.p1,
      p2: (engines.p2.decisionStats().fallbacks ?? 0) - modelFallbacksAtStart.p2,
    };
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
    await Promise.all(
      (["p1", "p2"] as const).map(async (pid) => {
        const end: GameEnd = {
          outcome: {
            winner: outcome.winner,
            winner_side: winnerSide ?? null,
            won: winnerSide === pid,
            turns: outcome.turns,
            pov_lines: outcome.pov[pid],
            errors: outcome.errors[pid],
            model_choice_fallbacks: modelChoiceFallbacks[pid],
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
        await engines[pid].endGame(end);
      }),
    );
    const canonicalLog = Buffer.from(`${outcome.log.join("\n")}\n`, "utf8");
    fs.writeFileSync(logPath, canonicalLog);
    const completed = completedGameEvidence({
      seriesId,
      attemptId: submissionNamespace,
      gameNumber,
      seed: gameSeed,
      players: context.players,
      winnerSide,
      outcome,
      modelChoiceFallbacks,
      coachNotes: { p1: engines.p1.coachingNote(), p2: engines.p2.coachingNote() },
      log: relativeSeriesFile(logPath),
      logBytes: canonicalLog,
    });
    writeGameCompletionMarker(context.seriesDir, completed.marker);
    games.push(completed.result);
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
      if (row.fallback === true) add("reflection_fallbacks");
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
    if (row.fallback === true) add("fallbacks");
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

function loadAgentContext(seriesDir: string, seriesId: string, pid: Pid): AgentContextEvent[] {
  const file = path.join(seriesDir, `${pid}-context.jsonl`);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  let lastNonempty = lines.length - 1;
  while (lastNonempty >= 0 && !lines[lastNonempty]) lastNonempty -= 1;
  const events: AgentContextEvent[] = [];
  let byteOffset = 0;
  for (const [index, line] of lines.entries()) {
    const lineOffset = byteOffset;
    byteOffset += Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index !== lastNonempty)
        throw new Error(`invalid ${pid} context row ${index + 1}`, { cause: error });
      fs.truncateSync(file, lineOffset);
      break;
    }
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

export async function playRecordedSeries(context: RecordedSeriesContext): Promise<RecordedSeries> {
  context.signal?.throwIfAborted();
  const timerScale = context.timerScale ?? DEFAULT_TIMER_SCALE;
  const identity = recordedSeriesIdentity(context);
  const adopted = context.seriesIndex === undefined ? undefined : adoptSeriesDir(context, identity);
  const seriesId = adopted?.seriesId ?? randomUUID().replaceAll("-", "").slice(0, 12);
  const seriesDir = adopted?.seriesDir ?? path.join(context.runDir, "series", seriesId);
  const adoptedCompletedGames = adopted?.games.length ?? 0;
  fs.mkdirSync(seriesDir, { recursive: true });
  if (!adopted) {
    const metadata = recordedSeriesMetadataSchema.parse({
      schema_version: RECORDED_SERIES_METADATA_SCHEMA_VERSION,
      series_id: seriesId,
      started: new Date().toISOString(),
      identity,
    });
    fs.writeFileSync(path.join(seriesDir, "series.json"), `${JSON.stringify(metadata)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  const attemptId = randomUUID();
  const startHeads = contextLedgerHeads(seriesDir);
  const priorIncomplete = incompleteAttempts(seriesDir, seriesId);
  appendAttemptRecord(
    seriesDir,
    attemptRecord(
      "attempt_started",
      attemptId,
      seriesId,
      adoptedCompletedGames,
      startHeads,
      startHeads,
      adopted?.resumeFrom ? { resumed_from: adopted.resumeFrom } : {},
    ),
  );

  try {
    for (const prior of priorIncomplete) {
      appendAttemptRecord(
        seriesDir,
        attemptRecord(
          "attempt_superseded",
          prior.attemptId,
          seriesId,
          prior.adoptedCompletedGames,
          prior.contextStartHeads,
          startHeads,
          { superseded_by: attemptId },
        ),
      );
    }
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

    const engineFor = (pid: Pid) => {
      const setup: EngineSetup = {
        pid,
        spec: context.players[pid],
        seed: context.engineSeeds[pid],
        decisionLog: decisionSink(pid),
        traceLog: path.join(seriesDir, `${pid}-trace.jsonl`),
        contextLog: path.join(seriesDir, `${pid}-context.jsonl`),
        initialContext: adopted ? loadAgentContext(seriesDir, seriesId, pid) : [],
        format: context.format,
        psDir: context.psDir,
        reasoning: reasoning[pid],
        reference,
        signal: context.signal,
        apiKey: context.apiKeys?.[context.players[pid]],
        initialNotebook: adopted?.notebooks[pid] ?? context.initialNotebooks?.[pid],
        carryInNotebook: context.initialNotebooks?.[pid],
        draftRoster: context.draftRosters?.[pid],
        briefing: context.briefings?.[pid],
        closedSheets: context.closedSheets,
      };
      return makeEngine(setup);
    };
    const engines = { p1: engineFor("p1"), p2: engineFor("p2") };
    for (const pid of ["p1", "p2"] as const) {
      const engine = engines[pid];
      if (adopted?.replay[pid].length && engine instanceof LLMEngine)
        engine.primeReplay(adopted.replay[pid]);
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
    if (adopted?.games.length) battleContext.completedGames = adopted.games;
    const { score, games, winnerSide } = await playBo3(battleContext);
    const stats = {
      p1: combinedDecisionStats(
        projectedDecisionStats(adopted?.decisions.p1 ?? []),
        engines.p1.decisionStats(),
      ),
      p2: combinedDecisionStats(
        projectedDecisionStats(adopted?.decisions.p2 ?? []),
        engines.p2.decisionStats(),
      ),
    };
    const fields: RecordedSeriesFields = {
      timestamp: new Date().toISOString(),
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
      coachNotes: { p1: engines.p1.coachingNote(), p2: engines.p2.coachingNote() },
      winnerSide,
      fields,
    };
    appendAttemptRecord(
      seriesDir,
      attemptRecord(
        "attempt_completed",
        attemptId,
        seriesId,
        adoptedCompletedGames,
        startHeads,
        contextLedgerHeads(seriesDir),
        { completed_games: games.length },
      ),
    );
    return result;
  } catch (error) {
    appendAttemptRecord(
      seriesDir,
      attemptRecord(
        "attempt_aborted",
        attemptId,
        seriesId,
        adoptedCompletedGames,
        startHeads,
        contextLedgerHeads(seriesDir),
        {
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ),
    );
    throw error;
  }
}
