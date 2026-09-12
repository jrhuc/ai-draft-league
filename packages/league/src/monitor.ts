import fs from "node:fs";
import path from "node:path";

import { readArchivedTeambuilds } from "./archive-teambuilds.js";
import { type DraftBoard, loadBoard } from "./draft-protocol.js";
import { buildDraftLeagueSchedule } from "./draftleague-protocol.js";
import { type GameSummary, seriesGameSummaries } from "./game-usage.js";
import { readSubmissionTraces } from "./decision-traces.js";
import {
  latestRosterVersion,
  readFranchiseCheckpoints,
  readFranchiseRosterVersion,
} from "./league-journal.js";
import { loadStoredLeague } from "./league-store.js";
import { type SeatDecisionStats, seatDecisionStats } from "./monitor-decisions.js";
import {
  type DraftHorizonStats,
  draftHorizonStats,
  dropsByWindow,
  type MemoryContinuity,
  memoryContinuity,
  type RetentionRow,
  retentionRows,
} from "./monitor-manager.js";
import { auditGame, type GameMechanicsAudit, type MechanicsFinding } from "./monitor-mechanics.js";
import { defaultPsDir } from "./paths.js";
import {
  readCompletedSeriesDecisionRows,
  readCompletedSeriesGameLogs,
  seriesDirectory,
} from "./recorded-series.js";
import { readRunArtifacts } from "./run-artifact-store.js";
import { RUN_DATABASE_FILE } from "./run-database.js";
import { renderRosterUsage, type RosterUsageEntry, rosterUsage } from "./roster-usage.js";
import { id } from "./reference-mechanics.js";
import { listStoredSeries, readStoredSeries } from "./series-store.js";
import { readTradeWindowArtifacts } from "./trade-window-artifacts.js";
import type { JsonObject } from "./types.js";
import { asRecord, text } from "./value.js";
import type { TeamBuildView } from "./views.js";

export interface MonitorReport {
  runDir: string;
  entrants: string[];
  teamNames: string[];
  completedSeries: number;
  decisions: SeatDecisionStats[];
  mechanics: {
    games: number;
    damagePredictions: number;
    damageMatched: number;
    orderPredictions: number;
    orderMatched: number;
    findings: Array<MechanicsFinding & { series: string; entrant: number }>;
  };
  draft: DraftHorizonStats[];
  usage: RosterUsageEntry[];
  retention: RetentionRow[];
  memory: MemoryContinuity[];
}

export function monitorRun(runDir: string, psDir = defaultPsDir()): MonitorReport {
  if (!fs.existsSync(path.join(runDir, RUN_DATABASE_FILE)))
    throw new Error(`${runDir} has no ${RUN_DATABASE_FILE}; the monitor reads league runs only`);
  const league = loadStoredLeague(runDir);
  const { entrants, teamNames, config } = league;
  const board = loadBoard(config.board, undefined, psDir);
  const { plans } = buildDraftLeagueSchedule(entrants.length, config.seed);
  const builds = readArchivedTeambuilds(runDir);
  const buildFor = (index: number, entrant: number): TeamBuildView | undefined =>
    builds.find((view) => view.seriesIndex === index && view.entrant === entrant);

  const decisionRows = entrants.map((): JsonObject[] => []);
  const games = new Map<number, GameSummary[]>();
  const mechanics: MonitorReport["mechanics"] = {
    games: 0,
    damagePredictions: 0,
    damageMatched: 0,
    orderPredictions: 0,
    orderMatched: 0,
    findings: [],
  };
  let completedSeries = 0;
  let throughWeek = 0;
  for (const summary of listStoredSeries(runDir)) {
    if (!summary.completed || summary.seriesIndex === null) continue;
    const plan = plans[summary.seriesIndex];
    if (!plan) continue;
    const entrantsOf =
      plan.entrants ?? playoffSides(runDir, summary.seriesId, plan.index, builds, board);
    if (!entrantsOf) continue;
    completedSeries += 1;
    if (plan.stage === "roundrobin") throughWeek = Math.max(throughWeek, plan.round);
    const sides = { p1: entrantsOf[0], p2: entrantsOf[1] };
    const rows = {
      p1: readCompletedSeriesDecisionRows(runDir, summary.seriesId, "p1"),
      p2: readCompletedSeriesDecisionRows(runDir, summary.seriesId, "p2"),
    };
    for (const pid of ["p1", "p2"] as const) decisionRows[sides[pid]]!.push(...rows[pid]);
    games.set(
      plan.index,
      seriesGameSummaries(runDir, summary.seriesId, board.mons, [
        buildFor(plan.index, entrantsOf[0]),
        buildFor(plan.index, entrantsOf[1]),
      ]),
    );
    const tracesFor = (pid: "p1" | "p2") => [
      ...readSubmissionTraces(
        seriesDirectory(runDir, summary.seriesId),
        pid,
        new Set(rows[pid].map((row) => text(row.submission_id))),
      ).values(),
    ];
    const traces = { p1: tracesFor("p1"), p2: tracesFor("p2") };
    for (const [index, log] of readCompletedSeriesGameLogs(runDir, summary.seriesId).entries()) {
      const game = index + 1;
      const audit: GameMechanicsAudit = auditGame(game, log, {
        p1: traces.p1.filter((row) => row.game_number === game),
        p2: traces.p2.filter((row) => row.game_number === game),
      });
      mechanics.games += 1;
      mechanics.damagePredictions += audit.damagePredictions;
      mechanics.damageMatched += audit.damageMatched;
      mechanics.orderPredictions += audit.orderPredictions;
      mechanics.orderMatched += audit.orderMatched;
      for (const finding of audit.findings)
        mechanics.findings.push({
          ...finding,
          series: summary.seriesId,
          entrant: sides[finding.pid],
        });
    }
  }

  const windows = config.transactions ?? [];
  const versionForWeek = (week: number) =>
    windows.filter((window) => window.after_week < week).length;
  const rostersByVersion = new Map<number, string[][]>();
  const rosterAt = (version: number): string[][] => {
    let rosters = rostersByVersion.get(version);
    if (!rosters) {
      rosters = entrants.map(() => []);
      for (const state of readFranchiseRosterVersion(runDir, version))
        rosters[state.entrant] = state.roster.map((mon) => mon.id);
      rostersByVersion.set(version, rosters);
    }
    return rosters;
  };
  const currentRosters = rosterAt(latestRosterVersion(runDir));
  const usage = rosterUsage({
    rosters: currentRosters,
    plans: plans.flatMap((plan) =>
      plan.stage === "roundrobin" && plan.entrants
        ? [{ index: plan.index, week: plan.round, entrants: plan.entrants }]
        : [],
    ),
    builds,
    games,
    throughWeek,
    owned: (entrant, week, monId) =>
      rosterAt(versionForWeek(week))[entrant]?.includes(monId) ?? false,
  });

  const checkpoints = readFranchiseCheckpoints(runDir);
  const latestMemory = entrants.map(
    (_, entrant) =>
      checkpoints
        .filter((checkpoint) => checkpoint.entrant === entrant)
        .sort(
          (a, b) =>
            b.week - a.week ||
            (b.stage === "transactions" ? 1 : 0) - (a.stage === "transactions" ? 1 : 0),
        )
        .at(0)?.memory,
  );

  return {
    runDir,
    entrants,
    teamNames,
    completedSeries,
    decisions: entrants.map((model, entrant) =>
      seatDecisionStats(`entrant ${entrant} | ${model}`, decisionRows[entrant]!),
    ),
    mechanics,
    draft: draftHorizonStats(
      readRunArtifacts(runDir, "draft-pick").map(({ value }) => asRecord(value)),
      entrants,
      teamNames,
    ),
    usage,
    retention: retentionRows(
      usage,
      dropsByWindow(readTradeWindowArtifacts(runDir)),
      latestMemory,
      board,
    ),
    memory: memoryContinuity(checkpoints, board),
  };
}

function playoffSides(
  runDir: string,
  seriesId: string,
  index: number,
  builds: readonly TeamBuildView[],
  board: DraftBoard,
): [number, number] | undefined {
  const pair = builds.filter((view) => view.seriesIndex === index);
  if (pair.length !== 2) return undefined;
  const packed = readStoredSeries(runDir, seriesId)?.identity.packed_teams.p1 ?? "";
  const registered = new Set(
    packed.split("]").map((set) => {
      const fields = set.split("|");
      return id(fields[1] || fields[0] || "");
    }),
  );
  const byId = new Map(board.mons.map((mon) => [mon.id, mon]));
  const home = pair.find((view) =>
    view.brought.every((monId) => registered.has(id(byId.get(monId)?.species ?? ""))),
  );
  const [a, b] = pair;
  if (!a || !b) return undefined;
  return home === b ? [b.entrant, a.entrant] : [a.entrant, b.entrant];
}

function rate(part: number, whole: number): string {
  return whole ? `${part}/${whole} (${Math.round((part / whole) * 1000) / 10}%)` : "0/0";
}

export function renderMonitorReport(report: MonitorReport): string {
  const lines: string[] = [];
  const label = (entrant: number) => `entrant ${entrant} | ${report.entrants[entrant]}`;
  lines.push(`# Harness monitor for ${path.basename(report.runDir)}`, "");
  lines.push(`${report.completedSeries} completed series, ${report.mechanics.games} games.`, "");

  lines.push("## Decision integrity (model decisions exclude automatic ones)", "");
  for (const seat of report.decisions) {
    const model = seat.decisions - seat.automatic;
    lines.push(
      `- ${seat.label}: ${seat.decisions} decisions (${seat.automatic} automatic); ` +
        `substitutions ${seat.substitutions}; ` +
        `parse failures ${rate(seat.parseFailureDecisions, model)}; notebook edits ${rate(seat.notebookUpdates, model)}; ` +
        `tool queries median ${seat.toolQueries.median}, p90 ${seat.toolQueries.p90}, max ${seat.toolQueries.max}; ` +
        `latency s median ${seat.latencySeconds.median}, p90 ${seat.latencySeconds.p90}; ` +
        `tokens median ${seat.totalTokens.median}, p90 ${seat.totalTokens.p90}; ` +
        `reflections ${seat.reflections}`,
    );
  }

  lines.push("", "## Mechanics audit (tool predictions vs the simulator)", "");
  lines.push(
    `- estimate_damage: ${report.mechanics.damagePredictions} predictions, ${report.mechanics.damageMatched} matched a hit that landed as predicted (same crit and spread state)`,
    `- compare_action_order: ${report.mechanics.orderPredictions} predictions, ${report.mechanics.orderMatched} matched both moves`,
  );
  const byKind = new Map<string, number>();
  for (const finding of report.mechanics.findings)
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  lines.push(
    `- findings: ${[...byKind.entries()].map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}`,
  );
  const formeChanges = report.mechanics.findings.filter((finding) =>
    finding.detail.includes("changed forme this turn"),
  ).length;
  if (formeChanges)
    lines.push(
      `- ${formeChanges} of those followed a forme change (Mega, Stance Change) in the same turn`,
    );
  for (const finding of report.mechanics.findings)
    lines.push(
      `  - ${finding.series} g${finding.game} t${finding.turn} ${label(finding.entrant)} ${finding.kind}: ${finding.detail}`,
    );

  lines.push("", "## Draft horizon (stated reasons per pick)", "");
  for (const row of report.draft)
    lines.push(
      `- ${label(row.entrant)}: ${row.picks} picks, ${row.withoutReason} without a reason; ` +
        `${row.namingAnotherCoach} name another coach, ${row.namingTheSeason} speak about the season beyond this pick`,
    );

  lines.push("", "## Roster usage", "");
  lines.push(...renderRosterUsage(report.usage, label));

  lines.push("", "## Never registered while owned for two or more completed weeks", "");
  if (!report.retention.length) lines.push("- none");
  for (const row of report.retention)
    lines.push(
      `- ${label(row.entrant)} | ${row.monId}: owned ${row.ownedWeeks} weeks, ` +
        (row.droppedAfterWeek === null
          ? "still owned"
          : `dropped after week ${row.droppedAfterWeek}`) +
        `, ${row.namedInMemory ? "named" : "not named"} in the latest memory`,
    );

  lines.push("", "## Memory continuity per barrier (board Pokémon named in memory)", "");
  for (const row of report.memory)
    lines.push(
      `- ${label(row.entrant)} ${row.stage} ${row.week}: notebook ${row.notebookChars} chars, ${row.pages} pages, ${row.totalChars} chars total; ` +
        `names ${row.monsNamed} Pokémon, carried ${row.monsCarried}, dropped ${row.monsDropped}`,
    );
  return lines.join("\n");
}
