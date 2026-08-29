import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { readArchivedTeambuilds } from "./archive-teambuilds.js";
import { type DraftBoardMon, draftTranscriptRowSchema, loadBoard } from "./draft.js";
import { rankedTable } from "./draftleague-protocol.js";
import { draftLeagueTopology } from "./draftleague-topology.js";
import { seriesGameSummaries } from "./game-usage.js";
import type {
  LeagueChampionView,
  LeagueDistributionView,
  LeagueFranchiseStatsView,
  LeagueFranchiseView,
  LeagueGameResponse,
  LeagueLifecycle,
  LeagueLiveSeriesView,
  LeagueRecordView,
  LeagueResponse,
  LeagueRosterSlotView,
  LeagueSeasonReviewView,
  LeagueSeriesView,
  LeagueTeambuildView,
  LeagueTradeWindowView,
  LeagueUsageView,
  LeagueWeeklyReviewView,
  QuartileView,
} from "./views.js";
import { draftLeagueConfigSchema } from "./league-store.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import { modelKey, type ParsedSeriesRecord } from "./records.js";
import {
  buildSeriesGame,
  count,
  decisionLogPath,
  isRunLive,
  PIDS,
  quantile,
  readDecisionLog,
  readRunJson,
  readRunLines,
  type SeriesSlot,
  scanUnfinishedSeries,
  spriteIdFor,
} from "./run-artifacts.js";
import { runStatusSchema, type StoredRunStatus } from "./run-status.js";
import { storedSeriesMetadataSchema } from "./series.js";
import {
  readCurrentRosterArtifact,
  readTransactionEpochs,
  storedRosterSchema,
  type TradeWindowRoster,
} from "./trade-window.js";
import { isErrnoCode, isRecord, ordinal, text } from "./value.js";

const runModeSchema = z.looseObject({ mode: z.enum(["draft", "tournament"]) });
const leagueConfigSchema = draftLeagueConfigSchema.partial();
const archivedPickSchema = draftTranscriptRowSchema.partial().required({ pick: true });
type ArchivedPick = z.infer<typeof archivedPickSchema>;

function readLeagueConfig(
  runsDir: string,
  runId: string,
): z.infer<typeof leagueConfigSchema> | null {
  const parsed = leagueConfigSchema.safeParse(readRunJson(runsDir, runId, "config.json"));
  return parsed.success ? parsed.data : null;
}

function readRunStatus(runsDir: string, runId: string): StoredRunStatus | null {
  const parsed = runStatusSchema.safeParse(readRunJson(runsDir, runId, "status.json"));
  return parsed.success ? parsed.data : null;
}

export function findLiveCliRun(
  runsDir: string,
): { runId: string; mode: "draft" | "tournament" } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return null;
  }
  const live: Array<{ runId: string; mode: "draft" | "tournament" }> = [];
  for (const runId of entries) {
    if (!SAFE_SEGMENT.test(runId)) continue;
    const config = runModeSchema.safeParse(readRunJson(runsDir, runId, "config.json"));
    if (config.success && isRunLive(runsDir, runId)) live.push({ runId, mode: config.data.mode });
  }
  live.sort((a, b) => a.runId.localeCompare(b.runId));
  return live[live.length - 1] ?? null;
}

function draftRuns(allRows: ParsedSeriesRecord[]): Map<string, ParsedSeriesRecord[]> {
  const runs = new Map<string, ParsedSeriesRecord[]>();
  for (const row of allRows) {
    if (row.mode !== "draft" || !row.players?.p1 || !row.players?.p2) continue;
    const runId = String(row.run_id ?? "");
    if (!SAFE_SEGMENT.test(runId)) continue;
    const list = runs.get(runId) ?? [];
    list.push(row);
    runs.set(runId, list);
  }
  for (const list of runs.values())
    list.sort((a, b) => count(a.series_index) - count(b.series_index));
  return runs;
}

function liveSeriesViews(
  runsDir: string,
  runId: string,
  rows: ParsedSeriesRecord[],
  identity: LeagueIdentity,
): LeagueLiveSeriesView[] {
  const views: LeagueLiveSeriesView[] = [];
  for (const entry of scanUnfinishedSeries(runsDir, runId, rows)) {
    let sides: [number, number] | null = null;
    if (entry.players) {
      const a = entrantForSpec(identity, entry.players.p1);
      const b = entrantForSpec(identity, entry.players.p2);
      if (a >= 0 && b >= 0) sides = [a, b];
    }
    if (entry.decisions === 0 && !sides) continue;
    const slot =
      entry.seriesIndex === null
        ? null
        : leagueSeriesSlot(entry.seriesIndex, identity.models.length);
    views.push({
      seriesId: entry.seriesId,
      seriesIndex: entry.seriesIndex,
      stage: slot?.stage ?? null,
      round: slot?.round ?? null,
      game: entry.game,
      turn: entry.turn,
      decisions: entry.decisions,
      sides,
    });
  }
  return views;
}

interface LeagueIdentity {
  models: string[];
  teamNames: string[];
  weeks: number | null;
  board: string | null;
  format: string | null;
}

function leagueIdentity(
  runsDir: string,
  runId: string,
  rows: ParsedSeriesRecord[],
): LeagueIdentity {
  const config = readLeagueConfig(runsDir, runId);
  const entrants = config?.entrants ?? null;
  const teamNames = config?.team_names ?? null;
  if (
    config &&
    entrants &&
    teamNames &&
    entrants.length === teamNames.length &&
    entrants.length >= 2
  ) {
    return {
      models: entrants,
      teamNames,
      weeks: config.weeks ?? null,
      board: config.board ?? null,
      format: config.format ?? null,
    };
  }
  const models: string[] = [];
  const names: string[] = [];
  for (const row of rows) {
    const teams = row.teams;
    for (const pid of PIDS) {
      const name = String(teams?.[pid] ?? "").replace(/\s+wk\d+$/, "");
      if (!name || names.includes(name)) continue;
      names.push(name);
      models.push(row.players[pid]);
    }
  }
  const sample = rows[0] ?? null;
  return {
    models,
    teamNames: names,
    weeks: null,
    board: sample?.board ?? null,
    format: sample?.format ?? null,
  };
}

/** A seat rewired to another provider mid-run keeps its entrant: match the exact spec first,
 * then fall back to the bare model name when it identifies a single entrant. */
function entrantForSpec(identity: LeagueIdentity, spec: string): number {
  const exact = identity.models.flatMap((model, entrant) => (model === spec ? [entrant] : []));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return -1;
  const matches = identity.models.flatMap((model, entrant) =>
    modelKey(model) === modelKey(spec) ? [entrant] : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
}

interface LeagueProgress {
  phase: "roundrobin" | "playoffs" | "complete";
  week: number;
  champion: LeagueChampionView | null;
  finalists: [number, number] | null;
  eliminatedRound: Map<number, number>;
}

function leagueSeriesSlot(
  seriesIndex: number,
  entrants: number,
): { stage: "roundrobin" | "playoff"; round: number } | null {
  if (!Number.isSafeInteger(seriesIndex) || seriesIndex < 0 || entrants < 2) return null;
  const topology = draftLeagueTopology(entrants);
  if (seriesIndex < topology.roundRobinSeries) {
    return { stage: "roundrobin", round: Math.floor(seriesIndex / Math.floor(entrants / 2)) + 1 };
  }
  const playoffIndex = seriesIndex - topology.roundRobinSeries;
  if (playoffIndex >= topology.playoffSeries) return null;
  return { stage: "playoff", round: topology.playoffRounds === 1 || playoffIndex < 2 ? 1 : 2 };
}

function leagueProgress(rows: ParsedSeriesRecord[], identity: LeagueIdentity): LeagueProgress {
  const playoffRows = rows.filter((row) => row.stage === "playoff");
  const week = Math.max(
    0,
    ...rows.filter((row) => row.stage === "roundrobin").map((row) => count(row.round)),
  );
  const eliminatedRound = new Map<number, number>();
  let champion: LeagueChampionView | null = null;
  let finalists: [number, number] | null = null;
  /** Mirrors the bracket in draftleague.ts: the final is the last round, so a lone finished
   * semifinal must not be mistaken for it while the other semifinal is still playing. */
  const finalRound = draftLeagueTopology(identity.models.length).playoffRounds;
  for (const row of playoffRows) {
    const winnerPid = row.winner_side ?? null;
    if (!winnerPid) continue;
    const [a, b] = recordedSides(row, identity.models.length);
    const loser = winnerPid === "p1" ? b : a;
    if (loser >= 0) eliminatedRound.set(loser, count(row.round));
  }
  const finals = playoffRows.filter((row) => count(row.round) === finalRound);
  if (finals.length === 1) {
    const final = finals[0]!;
    const [a, b] = recordedSides(final, identity.models.length);
    if (a >= 0 && b >= 0) finalists = [a, b];
    const winnerPid = final.winner_side ?? null;
    if (winnerPid) {
      const entrant = winnerPid === "p1" ? a : b;
      if (entrant >= 0) {
        champion = {
          entrant,
          model: identity.models[entrant]!,
          team: identity.teamNames[entrant]!,
        };
      }
    }
  }
  return {
    phase: champion ? "complete" : playoffRows.length > 0 ? "playoffs" : "roundrobin",
    week,
    champion,
    finalists,
    eliminatedRound,
  };
}

function preSeasonPhase(runsDir: string, runId: string): "drafting" | "building" | "roundrobin" {
  try {
    if (fs.readdirSync(path.join(runsDir, runId, "series")).length > 0) return "roundrobin";
  } catch {}
  const builds = readRunLines(runsDir, runId, "teambuild", "teambuild.jsonl");
  return builds.length > 0 ? "building" : "drafting";
}
function leaguePhase(
  runsDir: string,
  runId: string,
  rows: ParsedSeriesRecord[],
  progress: LeagueProgress,
  liveSeries: LeagueLiveSeriesView[],
): "drafting" | "building" | "roundrobin" | "window" | "playoffs" | "complete" {
  if (readTransactionEpochs(path.join(runsDir, runId)).some((epoch) => epoch.inProgress))
    return "window";
  if (liveSeries.some((series) => series.stage === "playoff")) return "playoffs";
  if (rows.length > 0) return progress.phase;
  if (completedDraftOnlyRun(runsDir, runId)) return "complete";
  return preSeasonPhase(runsDir, runId);
}
function isDraftOnly(runsDir: string, runId: string): boolean {
  return readLeagueConfig(runsDir, runId)?.draft_only === true;
}

function completedDraftOnlyRun(runsDir: string, runId: string): boolean {
  return isDraftOnly(runsDir, runId) && readRunStatus(runsDir, runId)?.state === "done";
}

function leagueLifecycle(
  runsDir: string,
  runId: string,
  champion: LeagueChampionView | null,
): LeagueLifecycle {
  if (isRunLive(runsDir, runId)) return "live";
  const state = readRunStatus(runsDir, runId)?.state;
  if (state === "failed" || state === "stopped") return state;
  if (champion || completedDraftOnlyRun(runsDir, runId)) return "complete";
  return "incomplete";
}

function leagueSwapsAllowed(runsDir: string, runId: string): number | null {
  const value = readLeagueConfig(runsDir, runId)?.swaps_allowed;
  return value !== undefined && value >= 0 ? value : null;
}

function transactionWeeks(runsDir: string, runId: string): number[] {
  return (readLeagueConfig(runsDir, runId)?.transactions ?? [])
    .map((window) => window.after_week)
    .filter((afterWeek) => Number.isSafeInteger(afterWeek) && afterWeek > 0);
}

function weeklyReviewViews(runsDir: string, runId: string): LeagueWeeklyReviewView[] {
  const root = path.join(runsDir, runId, "reviews");
  let files: string[] = [];
  try {
    files = fs.readdirSync(root);
  } catch (cause) {
    if (!isErrnoCode(cause, "ENOENT")) throw cause;
  }
  const views: LeagueWeeklyReviewView[] = [];
  for (const file of files.sort()) {
    const match = /^week-(\d+)(-transactions)?\.jsonl$/.exec(file);
    if (!match) continue;
    for (const row of readRunLines(runsDir, runId, "reviews", file)) {
      views.push({
        week: Number(match[1]),
        stage: match[2] ? "transactions" : "week",
        entrant: count(row.entrant),
        rosterVersion: count(row.roster_version),
        reasoning: text(row.reasoning),
        memoryPages: isRecord(row.memory) ? Object.keys(row.memory).length : 0,
        memoryCharacters: isRecord(row.memory)
          ? Object.values(row.memory).reduce((total: number, page) => {
              const parsed = z.string().safeParse(page);
              return total + (parsed.success ? parsed.data.length : 0);
            }, 0)
          : 0,
        fallback: row.fallback === true,
      });
    }
  }
  return views
    .filter(
      (review) =>
        review.reasoning.trim().length > 0 || review.memoryCharacters > 0 || review.fallback,
    )
    .sort((a, b) => a.week - b.week || a.stage.localeCompare(b.stage) || a.entrant - b.entrant);
}

function seasonReviewViews(runsDir: string, runId: string): LeagueSeasonReviewView[] {
  return readRunLines(runsDir, runId, "season.jsonl").map((row) => ({
    entrant: count(row.entrant),
    outcome: text(row.outcome),
    summary: text(row.summary),
    didWell: text(row.did_well),
    didPoorly: text(row.did_poorly),
    wouldChange: text(row.would_change),
    fallback: row.fallback === true,
  }));
}

function transactionViews(runsDir: string, runId: string): LeagueTradeWindowView[] {
  const epochs = readTransactionEpochs(path.join(runsDir, runId));
  const swapsAllowed = leagueSwapsAllowed(runsDir, runId);
  return transactionWeeks(runsDir, runId).map((afterWeek) => {
    const epoch = epochs.find((candidate) => candidate.afterWeek === afterWeek);
    const artifact = epoch?.artifact;
    if (!artifact) {
      return {
        afterWeek,
        state: epoch?.inProgress ? "in-progress" : "scheduled",
        order: [],
        offers: [],
        decisions: [],
      };
    }
    return {
      afterWeek,
      state: "complete",
      order: [...artifact.order],
      offers: artifact.offers.map((offer) => ({
        from: offer.from,
        to: offer.to,
        give: offer.give,
        get: offer.get,
        message: offer.message,
        accepted: offer.accepted,
        offerReasoning: offer.offerReasoning,
        responseReasoning: offer.responseReasoning,
      })),
      decisions: artifact.decisions.map((decision) => ({
        entrant: decision.entrant,
        swaps: decision.swaps.map(({ drop, add }) => ({ drop, add })),
        swapsRemaining:
          artifact.swaps_used && swapsAllowed !== null
            ? Math.max(0, swapsAllowed - count(artifact.swaps_used[decision.entrant]))
            : null,
        reasoning: decision.reasoning,
        fallback: decision.fallback,
      })),
    };
  });
}

interface RosterEntry {
  model: string;
  teamName: string;
  spent: number;
  budgetLeft: number;
  roster: LeagueRosterSlotView[];
}

function draftPickEntrant(pick: ArchivedPick, entrants: number): number | null {
  if (pick.entrant !== undefined)
    return pick.entrant >= 0 && pick.entrant < entrants ? pick.entrant : null;
  const offset = pick.pick - 1;
  if (offset < 0 || entrants < 1) return null;
  const round = Math.floor(offset / entrants);
  const seat = offset % entrants;
  return round % 2 === 0 ? seat : entrants - seat - 1;
}

function readRosters(
  runsDir: string,
  runId: string,
  identity: LeagueIdentity,
  current = true,
): RosterEntry[] {
  let source: TradeWindowRoster[];
  if (current) {
    source = readCurrentRosterArtifact(path.join(runsDir, runId)) ?? [];
  } else {
    const stored = z
      .array(storedRosterSchema)
      .safeParse(readRunJson(runsDir, runId, "rosters.json"));
    source = stored.success
      ? stored.data.map((roster, entrant) => ({ ...roster, entrant: roster.entrant ?? entrant }))
      : [];
  }
  const picks = readRunLines(runsDir, runId, "draft", "draft.jsonl").map((pick) =>
    archivedPickSchema.parse(pick),
  );
  const pickByEntrantAndMon = new Map<string, ArchivedPick>();
  for (const pick of picks) {
    const entrant = draftPickEntrant(pick, identity.models.length);
    if (entrant !== null) pickByEntrantAndMon.set(`${entrant}:${pick.mon}`, pick);
  }
  const windowAdds = new Map<number, Set<string>>();
  if (current) {
    for (const { artifact } of readTransactionEpochs(path.join(runsDir, runId))) {
      for (const decision of artifact?.decisions ?? []) {
        const adds = windowAdds.get(decision.entrant) ?? new Set<string>();
        for (const swap of decision.swaps) adds.add(swap.add);
        windowAdds.set(decision.entrant, adds);
      }
    }
  }
  const entries: RosterEntry[] = [];

  for (const [entrant, model] of identity.models.entries()) {
    const record = source.find((candidate) => candidate.entrant === entrant) ?? source[entrant];
    let roster = (record?.roster ?? []).map((mon): LeagueRosterSlotView => {
      const viaWindow = windowAdds.get(entrant)?.has(mon.id) === true;
      const pick = viaWindow ? undefined : pickByEntrantAndMon.get(`${entrant}:${mon.id}`);
      return {
        id: mon.id,
        name: mon.name,
        spriteId: spriteIdFor(mon.id),
        cost: mon.cost,
        pick: pick?.pick ?? null,
        rationale: pick?.rationale ?? "",
        fallback: pick?.fallback === true,
        acquired: viaWindow ? "window" : "draft",
      };
    });
    let spent = record?.spent ?? 0;
    let budgetLeft = record?.budget_left ?? 0;
    if (roster.length === 0) {
      const own = picks
        .filter((pick) => draftPickEntrant(pick, identity.models.length) === entrant)
        .sort((a, b) => a.pick - b.pick);
      roster = own.map((pick): LeagueRosterSlotView => ({
        id: pick.mon ?? "",
        name: pick.name ?? pick.mon ?? "",
        spriteId: spriteIdFor(pick.mon ?? ""),
        cost: pick.cost ?? 0,
        pick: pick.pick,
        rationale: pick.rationale ?? "",
        fallback: pick.fallback === true,
        acquired: "draft",
      }));
      spent = own.reduce((total, pick) => total + (pick.cost ?? 0), 0);
      const last = own[own.length - 1];
      if (last) budgetLeft = last.budget_left ?? 0;
    }
    entries.push({
      model,
      teamName: identity.teamNames[entrant] ?? record?.team_name ?? "",
      spent,
      budgetLeft,
      roster,
    });
  }
  return entries;
}

function finishLabel(
  entrant: number,
  progress: LeagueProgress,
  rank: number,
  playoffsSeen: boolean,
): string {
  if (progress.champion?.entrant === entrant) return "Champion";
  if (progress.champion && progress.finalists?.includes(entrant)) return "Runner-up";
  const eliminated = progress.eliminatedRound.get(entrant);
  if (eliminated !== undefined && !progress.finalists?.includes(entrant)) {
    return "Eliminated in the semifinals";
  }
  if (progress.phase === "complete" && playoffsSeen) return `${ordinal(rank)} in the round robin`;
  return "";
}

function recordedSides(row: ParsedSeriesRecord, entrantCount: number): [number, number] {
  const entrants = row.entrants;
  if (
    !entrants ||
    !Number.isSafeInteger(entrants[0]) ||
    entrants[0] < 0 ||
    entrants[0] >= entrantCount ||
    !Number.isSafeInteger(entrants[1]) ||
    entrants[1] < 0 ||
    entrants[1] >= entrantCount
  ) {
    return [-1, -1];
  }
  return entrants;
}

function recordSeries(
  recordA: LeagueRecordView,
  recordB: LeagueRecordView,
  winner: number | null,
  entrantA: number,
  score: { p1?: number | undefined; p2?: number | undefined } | undefined,
): void {
  if (winner !== null) {
    if (winner === entrantA) {
      recordA.w += 1;
      recordB.l += 1;
    } else {
      recordB.w += 1;
      recordA.l += 1;
    }
  }
  recordA.gw += count(score?.p1);
  recordA.gl += count(score?.p2);
  recordB.gw += count(score?.p2);
  recordB.gl += count(score?.p1);
}

export function buildLeague(
  allRows: ParsedSeriesRecord[],
  runsDir: string,
  runId: string,
): LeagueResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const live = isRunLive(runsDir, runId);
  const rows = draftRuns(allRows).get(runId) ?? [];
  if (rows.length === 0 && !live && !isDraftOnly(runsDir, runId)) return null;
  const identity = leagueIdentity(runsDir, runId, rows);
  if (identity.models.length < 2) return null;
  let boardMons: DraftBoardMon[] = [];
  let boardPicks: number | null = null;
  let boardBudget: number | null = null;
  if (identity.board) {
    try {
      const board = loadBoard(identity.board);
      boardMons = board.mons;
      boardPicks = board.picks;
      boardBudget = board.budget;
    } catch {}
  }
  const liveSeries = live ? liveSeriesViews(runsDir, runId, rows, identity) : [];
  const rosters = readRosters(runsDir, runId, identity);
  const draftRosters = readRosters(runsDir, runId, identity, false);
  const teambuilds = readArchivedTeambuilds(runsDir, runId);
  const progress = leagueProgress(rows, identity);

  const roundRobinRecords: LeagueRecordView[] = identity.models.map(() => ({
    w: 0,
    l: 0,
    gw: 0,
    gl: 0,
  }));
  const overallRecords: LeagueRecordView[] = identity.models.map(() => ({
    w: 0,
    l: 0,
    gw: 0,
    gl: 0,
  }));
  const statsAgg: LeagueFranchiseStatsView[] = identity.models.map(() => ({
    decisions: 0,
    latency: null,
    reasoningTokens: null,
    cost: null,
    toolLookups: 0,
    parseFailures: 0,
    fallbacks: 0,
    moveSelections: 0,
    switchSelections: 0,
    protectSelections: 0,
    consecutiveProtects: 0,
    spreadSelections: 0,
    megaSelections: 0,
    buildAttempts: 0,
    leadChanges: 0,
    bringChanges: 0,
  }));
  const entrantCost = identity.models.map(() => ({ total: 0, seen: false }));
  const entrantReasoning = identity.models.map(() => ({ total: 0, seen: false }));
  const entrantLatencies: number[][] = identity.models.map(() => []);
  const series: LeagueSeriesView[] = [];
  const buildFor = new Map<string, LeagueTeambuildView>();
  for (const build of teambuilds) buildFor.set(`${build.seriesIndex}:${build.entrant}`, build);
  for (const row of rows) {
    const [a, b] = recordedSides(row, identity.models.length);
    if (a < 0 || b < 0) continue;
    const score = row.score;
    const winner = row.winner_side === "p1" ? a : row.winner_side === "p2" ? b : null;
    const dstats = row.decision_stats;
    for (const [pid, entrant] of [
      ["p1", a],
      ["p2", b],
    ] as const) {
      const d = dstats?.[pid];
      const agg = statsAgg[entrant]!;
      if (d) {
        agg.decisions += count(d.decisions);
        agg.fallbacks += count(d.fallbacks);
        agg.parseFailures += count(d.parse_failures);
        agg.toolLookups += count(d.tool_lookups);
        agg.moveSelections += count(d.move_selections);
        agg.switchSelections += count(d.switch_selections);
        agg.protectSelections += count(d.protect_selections);
        agg.consecutiveProtects += count(d.consecutive_protect_selections);
        agg.spreadSelections += count(d.spread_move_selections);
        agg.megaSelections += count(d.mega_selections);
        agg.leadChanges += count(d.lead_changes);
        agg.bringChanges += count(d.bring_changes);
        if (d.cost !== undefined) {
          entrantCost[entrant]!.total += count(d.cost);
          entrantCost[entrant]!.seen = true;
        }
        if (d.reasoning_tokens !== undefined) {
          entrantReasoning[entrant]!.total += count(d.reasoning_tokens);
          entrantReasoning[entrant]!.seen = true;
        }
      }
      const file = decisionLogPath(runsDir, runId, String(row.series_id ?? ""), pid);
      if (file) {
        for (const entry of readDecisionLog(file)) {
          if (entry.kind !== "decision" || entry.automatic) continue;
          if (entry.latencyMs !== null && entry.latencyMs > 0)
            entrantLatencies[entrant]!.push(entry.latencyMs);
        }
      }
    }
    const seriesId = String(row.series_id ?? "");
    const firstBuild = buildFor.get(`${count(row.series_index)}:${a}`);
    const secondBuild = buildFor.get(`${count(row.series_index)}:${b}`);
    const summaries =
      boardMons.length && SAFE_SEGMENT.test(seriesId)
        ? seriesGameSummaries(path.join(runsDir, runId, "series", seriesId), seriesId, boardMons, [
            firstBuild,
            secondBuild,
          ])
        : [];
    const games = (row.games ?? []).map((game, index) => {
      const gameSummary = summaries[index];
      const brought: [string[], string[]] = gameSummary?.brought ?? [[], []];
      const fielded: [string[], string[]] = gameSummary?.fielded ?? [[], []];
      const megaEvolved: [string | null, string | null] = gameSummary?.megaEvolved ?? [null, null];
      const faints: [Record<string, number>, Record<string, number>] = gameSummary?.faints ?? [
        {},
        {},
      ];
      return {
        winner: game.winner_side === "p1" ? a : game.winner_side === "p2" ? b : null,
        turns: count(game.turns),
        brought,
        fielded,
        megaEvolved,
        faints,
      };
    });
    recordSeries(overallRecords[a]!, overallRecords[b]!, winner, a, score);
    if (row.stage === "roundrobin") {
      recordSeries(roundRobinRecords[a]!, roundRobinRecords[b]!, winner, a, score);
    }
    series.push({
      seriesIndex: count(row.series_index),
      seriesId: String(row.series_id ?? ""),
      stage: row.stage === "playoff" ? "playoff" : "roundrobin",
      round: count(row.round),
      timestamp: String(row.timestamp ?? ""),
      sides: [a, b],
      score: [count(score?.p1), count(score?.p2)],
      winner,
      turns: count(row.turns),
      games,
    });
  }

  const ranks = rankedTable(
    roundRobinRecords.map((record, entrant) => ({ entrant, ...record })),
  ).map((record) => record.entrant);
  const rankOf = new Map(ranks.map((entrant, index) => [entrant, index + 1]));
  const playoffsSeen = rows.some((row) => row.stage === "playoff");

  for (const build of teambuilds) {
    const agg = statsAgg[build.entrant];
    if (agg) agg.buildAttempts += build.attempts;
  }
  for (const [entrant, agg] of statsAgg.entries()) {
    agg.latency = summary(entrantLatencies[entrant]!);
    if (entrantCost[entrant]!.seen) agg.cost = Math.round(entrantCost[entrant]!.total * 1e4) / 1e4;
    if (entrantReasoning[entrant]!.seen) agg.reasoningTokens = entrantReasoning[entrant]!.total;
  }

  const franchises: LeagueFranchiseView[] = rosters.map((entry, entrant) => ({
    entrant,
    model: entry.model,
    teamName: entry.teamName,
    spent: entry.spent,
    budgetLeft: entry.budgetLeft,
    overallRecord: overallRecords[entrant]!,
    roundRobinRecord: roundRobinRecords[entrant]!,
    finish: finishLabel(entrant, progress, rankOf.get(entrant) ?? entrant + 1, playoffsSeen),
    roster: entry.roster,
    draftRoster: draftRosters[entrant]?.roster ?? entry.roster,
    stats: statsAgg[entrant]!,
  }));

  const usageMap = new Map<string, LeagueUsageView>();
  const usageOf = (entrant: number, id: string): LeagueUsageView => {
    const key = `${entrant}:${id}`;
    let usage = usageMap.get(key);
    if (!usage) {
      const slot =
        rosters[entrant]?.roster.find((mon) => mon.id === id) ??
        draftRosters[entrant]?.roster.find((mon) => mon.id === id);
      usage = {
        entrant,
        id,
        name: slot?.name ?? id,
        spriteId: slot?.spriteId ?? spriteIdFor(id),
        cost: slot?.cost ?? 0,
        pick: slot?.pick ?? null,
        builds: 0,
        seriesWins: 0,
        seriesLosses: 0,
        gamesFielded: 0,
        gameWins: 0,
        gameLosses: 0,
        faints: 0,
      };
      usageMap.set(key, usage);
    }
    return usage;
  };
  for (const view of series) {
    for (const sideIndex of [0, 1] as const) {
      const entrant = view.sides[sideIndex];
      const build = buildFor.get(`${view.seriesIndex}:${entrant}`);
      if (!build) continue;
      for (const id of build.brought) {
        const usage = usageOf(entrant, id);
        usage.builds += 1;
        if (view.winner === entrant) usage.seriesWins += 1;
        else if (view.winner !== null) usage.seriesLosses += 1;
      }
      for (const game of view.games) {
        for (const id of game.fielded[sideIndex]) {
          const usage = usageOf(entrant, id);
          usage.gamesFielded += 1;
          if (game.winner === entrant) usage.gameWins += 1;
          else if (game.winner !== null) usage.gameLosses += 1;
          usage.faints += game.faints[sideIndex][id] ?? 0;
        }
      }
    }
  }
  for (const [entrant, entry] of rosters.entries()) {
    for (const slot of entry.roster) usageOf(entrant, slot.id);
  }
  const usage = [...usageMap.values()].sort(
    (a, b) =>
      b.gamesFielded - a.gamesFielded ||
      b.gameWins - a.gameWins ||
      b.builds - a.builds ||
      b.cost - a.cost ||
      a.name.localeCompare(b.name),
  );

  const itemCounts = new Map<string, number>();
  for (const build of teambuilds) {
    for (const set of build.sets) {
      const item = text(set.item).trim();
      if (item) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
    }
  }
  const distribution: LeagueDistributionView = {
    speciesDrafted: new Set(rosters.flatMap((entry) => entry.roster.map((mon) => mon.id))).size,
    speciesBuilt: new Set(teambuilds.flatMap((build) => build.brought)).size,
    speciesFielded: new Set(
      usage.filter((entry) => entry.gamesFielded > 0).map((entry) => entry.id),
    ).size,
    itemsUsed: itemCounts.size,
    topItems: [...itemCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([item, itemCount]) => ({ item, count: itemCount })),
  };

  let decisions = 0;
  let meteredCost = 0;
  let tokens = 0;
  let tokensSeen = false;
  let reasoning = 0;
  let reasoningSeen = false;
  for (const row of rows) {
    const stats = row.decision_stats;
    for (const pid of PIDS) {
      decisions += count(stats?.[pid]?.decisions);
      meteredCost += count(stats?.[pid]?.cost);
      const file = decisionLogPath(runsDir, runId, String(row.series_id ?? ""), pid);
      if (!file) continue;
      for (const entry of readDecisionLog(file)) {
        if (entry.totalTokens !== null) {
          tokens += entry.totalTokens;
          tokensSeen = true;
        }
        if (entry.reasoningTokens !== undefined && entry.reasoningTokens !== null) {
          reasoning += entry.reasoningTokens;
          reasoningSeen = true;
        }
      }
    }
  }

  const timestamps = rows
    .map((row) => String(row.timestamp ?? ""))
    .filter(Boolean)
    .sort();
  const sample = rosters.find((entry) => entry.spent + entry.budgetLeft > 0);
  const started = readRunStatus(runsDir, runId)?.start_time ?? "";
  return {
    runId,
    when: timestamps[0] ?? started,
    lastPlayed: timestamps[timestamps.length - 1] ?? null,
    board: identity.board,
    format: identity.format,
    budget: boardBudget ?? (sample ? sample.spent + sample.budgetLeft : null),
    picksPerEntrant:
      boardPicks ?? rosters.find((entry) => entry.roster.length > 0)?.roster.length ?? null,
    weeks: identity.weeks,
    playoffRounds: draftLeagueTopology(identity.models.length).playoffRounds,
    phase: leaguePhase(runsDir, runId, rows, progress, liveSeries),
    week: progress.week,
    champion: progress.champion,
    draftOnly: isDraftOnly(runsDir, runId) && rows.length === 0,
    lifecycle: leagueLifecycle(runsDir, runId, progress.champion),
    liveSeries,
    transactions: transactionViews(runsDir, runId),
    swapsAllowed: leagueSwapsAllowed(runsDir, runId),
    weeklyReviews: weeklyReviewViews(runsDir, runId),
    seasonReviews: seasonReviewViews(runsDir, runId),
    franchises,
    series,
    teambuilds,
    spend: {
      decisions,
      tokens: tokensSeen ? tokens : null,
      reasoningTokens: reasoningSeen ? reasoning : null,
      cost: meteredCost > 0 ? Math.round(meteredCost * 1e4) / 1e4 : null,
    },
    usage,
    distribution,
  };
}

function summary(values: number[]): QuartileView | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1]!,
  };
}

function liveSeriesByIndex(
  runsDir: string,
  runId: string,
  seriesIndex: number,
  identity: LeagueIdentity,
): {
  seriesId: string;
  sides: [number, number];
  stage: "roundrobin" | "playoff";
  round: number;
} | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(runsDir, runId, "series"));
  } catch {
    return null;
  }
  for (const seriesId of entries) {
    if (!SAFE_SEGMENT.test(seriesId)) continue;
    const parsedMeta = storedSeriesMetadataSchema.safeParse(
      readRunJson(runsDir, runId, "series", seriesId, "series.json"),
    );
    if (
      !parsedMeta.success ||
      parsedMeta.data.seriesIndex !== seriesIndex ||
      !parsedMeta.data.players
    )
      continue;
    const players = parsedMeta.data.players;
    const a = entrantForSpec(identity, players.p1);
    const b = entrantForSpec(identity, players.p2);
    const slot = leagueSeriesSlot(seriesIndex, identity.models.length);
    if (a >= 0 && b >= 0 && slot) return { seriesId, sides: [a, b], ...slot };
  }
  return null;
}

export function buildLeagueGame(
  allRows: ParsedSeriesRecord[],
  runsDir: string,
  runId: string,
  seriesIndex: number,
  game: number,
): LeagueGameResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const rows = draftRuns(allRows).get(runId) ?? [];
  const identity = leagueIdentity(runsDir, runId, rows);
  const row = rows.find((entry) => count(entry.series_index) === seriesIndex);
  let slot: SeriesSlot;
  if (row) {
    const [a, b] = recordedSides(row, identity.models.length);
    if (a < 0 || b < 0) return null;
    slot = {
      seriesId: String(row.series_id ?? ""),
      sides: [a, b],
      stage: row.stage === "playoff" ? "playoff" : "roundrobin",
      round: count(row.round),
      models: identity.models,
      labels: identity.teamNames,
    };
  } else {
    const found = liveSeriesByIndex(runsDir, runId, seriesIndex, identity);
    if (!found) return null;
    slot = { ...found, models: identity.models, labels: identity.teamNames };
  }
  return buildSeriesGame(runsDir, runId, seriesIndex, game, slot, row);
}
