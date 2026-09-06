import path from "node:path";
import { storedNotebookText } from "./battle-memory.js";
import { buildBriefing } from "./build-briefing.js";
import type { DraftBoardMon } from "./draft.js";
import type { DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import type { DraftLeagueContext, LeagueCoordinator } from "./league-coordinator.js";
import { linkedStoredArtifact, type StoredBuild } from "./league-store.js";
import { seededRng } from "./random.js";
import type { SeriesRecord } from "./records.js";
import { recordRow } from "./records.js";
import type { RecordedSeriesContext } from "./series.js";
import { MatchRunner } from "./series.js";
import { runTeambuild, type TeamBuildOptions } from "./teambuild.js";
import { validateTeam } from "./teams.js";
import type { Pid } from "./types.js";
import type { TeamBuildView } from "./views.js";

function builtTeamSummary(build: TeamBuildView): string {
  const sets = build.sets.map((set) => {
    const evs = Object.entries(set.evs)
      .filter(([, value]) => Number(value) > 0)
      .map(([stat, value]) => `${stat} ${value}`)
      .join("/");
    return `${set.species} @ ${set.item}; ${set.ability}; ${set.nature}; ${set.moves.join("/")}; ${evs || "0 investment"}`;
  });
  return `Plan: ${build.rationale || "(none)"} Registered sets: ${sets.join(" | ")}`;
}

function draftRosterSummary(roster: readonly DraftBoardMon[], build: TeamBuildView): string {
  const registered = new Set(build.brought);
  const names = (mons: readonly DraftBoardMon[]) =>
    mons.map((mon) => mon.name).join(", ") || "(none)";
  return (
    `registered for this series: ${names(roster.filter((mon) => registered.has(mon.id)))}; ` +
    `left behind: ${names(roster.filter((mon) => !registered.has(mon.id)))}.`
  );
}

export function draftLeaguePlayoffReview(
  summary: string,
  build: TeamBuildView,
  notebook: string,
): string {
  return `${summary}. ${builtTeamSummary(build)} Final private battle note: ${notebook || "(empty)"}`;
}

function priorContextFor(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  entrant: number,
  opponent: number,
): string[] {
  const monName = (id: string): string =>
    context.board.mons.find((mon) => mon.id === id)?.name ?? id;
  const franchise = runtime.franchises[entrant]!;
  const lines: string[] = [];
  for (const plan of context.plans) {
    if (!plan.entrants?.includes(entrant) || !runtime.completed.has(plan.index)) continue;
    const summary = franchise.resultSummaries.get(plan.index);
    if (summary === undefined) continue;
    const build = runtime.teambuilds.find(
      (view) => view.seriesIndex === plan.index && view.entrant === entrant,
    );
    const registered = build ? `; registered ${build.brought.map(monName).join(", ")}` : "";
    lines.push(`${summary}${registered}`);
    const dossier = franchise.opponentDossiers.get(plan.index);
    if (plan.entrants.includes(opponent) && dossier) lines.push(`Against this coach: ${dossier}`);
  }
  return lines;
}

async function teambuildFor(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  plan: DraftLeagueSeriesPlan,
  entrant: number,
  opponent: number,
  signal: AbortSignal,
): Promise<StoredBuild> {
  const { board, entrants, options, psDir, runDir, seed, sheetPolicy } = context;
  const franchise = runtime.franchises[entrant]!;
  const rival = runtime.franchises[opponent]!;
  const stored = context.storedBuilds.get(`${plan.index}:${entrant}`);
  const reused =
    stored &&
    linkedStoredArtifact(stored, {
      model: franchise.model,
      opponentModel: rival.model,
      format: board.format,
      psDir,
      sheetPolicy,
      stage: plan.stage,
      seriesIndex: plan.index,
      entrant,
      opponent,
      rosterIds: franchise.roster.map((mon) => mon.id),
      opponentRosterIds: rival.roster.map((mon) => mon.id),
    });
  const adopt = (build: StoredBuild): StoredBuild => {
    validateTeam(build.packed, board.format, psDir);
    runtime.teambuilds.push(build.view);
    options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
    return build;
  };
  if (reused) return adopt(reused);
  const teambuildOptions: TeamBuildOptions = {
    runDir,
    psDir,
    logDir: path.join(runDir, "teambuild"),
    rng: seededRng(`${seed}:tb:${plan.index}:${entrant}`),
    signal,
    reasoning: options.reasoning,
    reasoningByModel: options.reasoningByModel,
    apiKeys: options.apiKeys,
  };
  const result = await runTeambuild(
    {
      seriesIndex: plan.index,
      entrant,
      opponent,
      stage: plan.stage,
      model: entrants[entrant]!,
      opponentModel: entrants[opponent]!,
      franchiseName: franchise.teamName,
      roster: franchise.roster,
      opponentRoster: rival.roster,
      memory: franchise.memory,
      playoffContext: priorContextFor(context, runtime, entrant, opponent),
      format: board.format,
      sheetPolicy,
    },
    teambuildOptions,
  );
  return adopt({ packed: result.packed, view: result.view });
}

function applyOutcome(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  plan: DraftLeagueSeriesPlan,
  coaching: Record<Pid, { build: TeamBuildView; notebook: string }>,
): void {
  const [a, b] = plan.entrants!;
  const { winnerSide, score } = runtime.outcomeFor(plan);
  for (const [entrant, opponent, side] of [
    [a, b, "p1"],
    [b, a, "p2"],
  ] as const) {
    const result = winnerSide ? (winnerSide === side ? "beat" : "lost to") : "drew with";
    const summary =
      `${plan.stage === "playoff" ? `Playoff round ${plan.round}` : `Round-robin week ${plan.round}`}: ${result} ` +
      `${context.entrants[opponent]} ${score[side]}-${score[side === "p1" ? "p2" : "p1"]}`;
    const franchise = runtime.franchises[entrant]!;
    franchise.resultSummaries.set(plan.index, summary);
    franchise.opponentDossiers.set(
      plan.index,
      draftLeaguePlayoffReview(summary, coaching[side].build, coaching[side].notebook),
    );
    franchise.seriesNotes.set(plan.index, coaching[side].notebook);
  }
}

/** Plays one scheduled series, or adopts it when the database already holds it complete. */
export async function playSeries(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
  plan: DraftLeagueSeriesPlan,
  signal: AbortSignal,
): Promise<SeriesRecord> {
  const { board, configuredTransactions, entrants, options, psCommit, psDir, runDir, seed } =
    context;
  const [a, b] = plan.entrants!;
  const players = { p1: entrants[a]!, p2: entrants[b]! };
  options.onEvent?.({ type: "series-players", index: plan.index, players });
  const [home, away] = await Promise.all([
    teambuildFor(context, runtime, plan, a, b, signal),
    teambuildFor(context, runtime, plan, b, a, signal),
  ]);
  options.onEvent?.({ type: "series-start", index: plan.index });
  const seriesContext: RecordedSeriesContext = {
    seriesIndex: plan.index,
    players,
    teams: {
      p1: { id: `${entrants[a]} wk${plan.round}`, packed: home.packed },
      p2: { id: `${entrants[b]} wk${plan.round}`, packed: away.packed },
    },
    briefings: { p1: buildBriefing(home.view), p2: buildBriefing(away.view) },
    draftRosters: {
      p1: draftRosterSummary(runtime.franchises[a]!.roster, home.view),
      p2: draftRosterSummary(runtime.franchises[b]!.roster, away.view),
    },
    gameSeeds: plan.gameSeeds,
    engineSeeds: plan.engineSeeds,
    format: board.format,
    psDir,
    runDir,
    signal,
    requireWinner: plan.stage === "playoff",
    closedSheets: options.closedSheets,
    reasoning: options.reasoning,
    apiKeys: options.apiKeys,
    reasoningByModel: options.reasoningByModel,
    timerScale: context.timerScale,
    onGameUpdate: (game, lines, publicLines) =>
      options.onEvent?.({ type: "game-update", index: plan.index, game, lines, publicLines }),
    onGameEnd: (game, winner, turns, score) =>
      options.onEvent?.({ type: "game-end", index: plan.index, game, winner, turns, score }),
    onDecision: (pid, row) => options.onEvent?.({ type: "decision", index: plan.index, pid, row }),
  };
  const { winnerSide, fields, coachNotes } = await new MatchRunner(seriesContext).run();
  const row: SeriesRecord = {
    schema_version: 1,
    mode: "draft",
    series_index: plan.index,
    entrants: [a, b],
    stage: plan.stage,
    round: plan.round,
    board: board.id,
    transactions: configuredTransactions,
    roster_version: runtime.rosterVersionFor(plan),
    run_seed: seed,
    ps_commit: psCommit,
    ...fields,
  };
  if (plan.stage === "playoff") {
    if (!winnerSide)
      throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
    row.advanced = entrants[winnerSide === "p1" ? a : b]!;
  }
  if (options.contributor !== undefined) row.contributor = options.contributor;
  recordRow(context.recordsPath, row);
  runtime.completed.set(plan.index, { row, score: fields.score, winnerSide });
  applyOutcome(context, runtime, plan, {
    p1: { build: home.view, notebook: storedNotebookText(coachNotes.p1) },
    p2: { build: away.view, notebook: storedNotebookText(coachNotes.p2) },
  });
  options.onEvent?.({ type: "series-end", index: plan.index, record: row });
  if (plan.stage === "roundrobin")
    options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
  return row;
}
