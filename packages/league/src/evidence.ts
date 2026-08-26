import fs from "node:fs";
import path from "node:path";

import { z } from "zod";
import type {
  ArchivedMatchView,
  BracketEntrantView,
  LeagueGameResponse,
  TournamentArchiveView,
  TournamentEventView,
  TournamentLiveSeriesView,
  TournamentSummary,
  TournamentsResponse,
} from "./views.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import { type ParsedSeriesRecord, TEST_POOL } from "./records.js";
import {
  buildSeriesGame,
  isRunLive,
  scanUnfinishedSeries,
  viewTeamSheet,
} from "./run-artifacts.js";
import { runStatusSchema } from "./run-status.js";
import { loadPool } from "./teams.js";
import { buildBracket, tournamentConfigSchema } from "./tournament.js";

const safeIntegerSchema = z.number().int().safe();
const tournamentSeedsSchema = z.strictObject({ p1: safeIntegerSchema, p2: safeIntegerSchema });
const runConfigSchema = tournamentConfigSchema.partial().extend({
  mode: z.enum(["rotation", "exhibition", "tournament", "draft"]).optional(),
  entrants: z
    .array(
      tournamentConfigSchema.shape.entrants.element.extend({
        seed: z.number().nullable().optional(),
        placement: z.number().nullable().optional(),
      }),
    )
    .optional(),
});

type RunConfig = z.output<typeof runConfigSchema>;

type SeriesIndexArtifact = number | null | undefined;

interface PoolProvenance {
  event: TournamentEventView | null;
  teams: Map<string, BracketEntrantView>;
}

function summarizeTournaments(
  tournaments: Array<{ rounds: ArchivedMatchView[][] }>,
): TournamentSummary {
  const counts = tournaments.map(
    (archive) =>
      archive.rounds.flat().filter((match) => match.seriesIndex !== null && match.score !== null)
        .length,
  );
  return {
    tournaments: counts.filter((matches) => matches > 0).length,
    matches: counts.reduce((a, b) => a + b, 0),
  };
}

function liveTournamentRuns(runsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const runId = entry.name;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_SEGMENT.test(runId)) return [];
    return runConfig(runsDir, runId)?.mode === "tournament" && isRunLive(runsDir, runId)
      ? [runId]
      : [];
  });
}

function runConfig(runsDir: string, runId: string): RunConfig | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  try {
    const parsed = runConfigSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(runsDir, runId, "config.json"), "utf8")),
    );
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function runStartedAt(runsDir: string, runId: string): string {
  if (!SAFE_SEGMENT.test(runId)) return "";
  try {
    const parsed = runStatusSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(runsDir, runId, "status.json"), "utf8")),
    );
    return parsed.success ? (parsed.data.start_time ?? "") : "";
  } catch {
    return "";
  }
}

function configEntrants(config: RunConfig | null): BracketEntrantView[] | null {
  if (!config?.entrants) return null;
  return config.entrants.every((entry) => entry.model && entry.team) ? config.entrants : null;
}

function poolProvenance(poolId: string | null, teamsDir?: string): PoolProvenance {
  const teams = new Map<string, BracketEntrantView>();
  if (!poolId) return { event: null, teams };
  try {
    const pool = loadPool(poolId, teamsDir);
    for (const team of pool.teams) {
      teams.set(team.id, {
        model: "",
        team: team.id,
        seed: team.seed ?? null,
        placement: team.provenance?.placement ?? null,
        player: team.provenance?.player ?? "",
        paste: team.provenance?.paste ?? "",
        teamSheet: viewTeamSheet(team.packed),
      });
    }
    const event = pool.event;
    return {
      event: event
        ? {
            name: event.name,
            game: event.game,
            regulation: event.regulation,
            location: event.location,
            dates: event.dates,
            players: event.players,
            structure: event.structure,
            url: event.url,
            reconstructedSpreads: event.reconstructedSpreads,
          }
        : null,
      teams,
    };
  } catch {
    return { event: null, teams };
  }
}

interface TournamentEntrantFact {
  model: string;
  team: string;
  seed?: number | null;
  placement?: number | null;
}

interface TournamentSeriesLocation {
  round: number;
  slots: [number | null, number | null];
}

interface TournamentFold {
  entrants: TournamentEntrantFact[];
  rounds: ArchivedMatchView[][];
  champion: number | null;
  rowsBySeries: Map<number, ParsedSeriesRecord>;
  locations: Map<number, TournamentSeriesLocation>;
}

interface TournamentProjection<View> {
  view: View;
  fold: TournamentFold;
}

/** Rebuilds a tournament solely from selected structural facts and rejects facts that cannot all be true. */
function foldTournament(
  rows: ParsedSeriesRecord[],
  configured: readonly TournamentEntrantFact[] | null,
): TournamentFold | null {
  let size = configured?.length ?? null;
  if (size !== null && size < 2) return null;
  for (const row of rows) {
    const entrantCount = row.entrant_count;
    if (!Number.isSafeInteger(entrantCount) || Number(entrantCount) < 2) return null;
    if (size === null) size = Number(entrantCount);
    else if (entrantCount !== size) return null;
  }
  if (size === null) return null;

  const identities: Array<{ model: string; team: string } | null> = configured
    ? configured.map(({ model, team }) => (model && team ? { model, team } : null))
    : Array.from({ length: size }, () => null);
  if (configured && identities.some((identity) => identity === null)) return null;
  const rowsBySeries = new Map<number, ParsedSeriesRecord>();
  const seedsBySeries = new Map<number, z.output<typeof tournamentSeedsSchema>>();
  for (const row of rows) {
    const seriesIndex = row.series_index;
    if (rowsBySeries.has(seriesIndex)) return null;
    rowsBySeries.set(seriesIndex, row);
    const parsedSeeds = tournamentSeedsSchema.safeParse(row.seeds);
    if (!parsedSeeds.success) return null;
    const seeds = parsedSeeds.data;
    seedsBySeries.set(seriesIndex, seeds);
    for (const pid of ["p1", "p2"] as const) {
      const seed = seeds[pid];
      if (seed >= size) return null;
      const entrant = { model: row.players[pid], team: row.teams[pid] };
      const previous = identities[seed];
      if (previous && (previous.model !== entrant.model || previous.team !== entrant.team))
        return null;
      identities[seed] = entrant;
    }
    if (seeds.p1 === seeds.p2) return null;
  }
  const resolvedIdentities = identities.filter((identity) => identity !== null);
  if (resolvedIdentities.length !== size) return null;
  if (new Set(resolvedIdentities.map((identity) => identity.model)).size !== size) return null;

  const entrants = configured
    ? configured.map((entrant) => ({ ...entrant }))
    : resolvedIdentities.map((identity) => ({ ...identity }));
  const bracket = buildBracket(size);
  const expectedSeries = new Set(
    bracket.flatMap((round) =>
      round.flatMap((match) => (match.seriesIndex === null ? [] : [match.seriesIndex])),
    ),
  );
  if ([...rowsBySeries.keys()].some((seriesIndex) => !expectedSeries.has(seriesIndex))) return null;

  const rounds: ArchivedMatchView[][] = [];
  const winners = new Map<number, number | null>();
  const locations = new Map<number, TournamentSeriesLocation>();
  for (const [roundIndex, round] of bracket.entries()) {
    const views: ArchivedMatchView[] = [];
    for (const [matchIndex, match] of round.entries()) {
      const slots: [number | null, number | null] =
        roundIndex === 0
          ? [...match.slots]
          : [winners.get(matchIndex * 2) ?? null, winners.get(matchIndex * 2 + 1) ?? null];
      let winner = match.seriesIndex === null ? (slots[0] ?? slots[1]) : null;
      let score: [number, number] | null = null;
      let turns: number | null = null;
      if (match.seriesIndex !== null) {
        locations.set(match.seriesIndex, { round: roundIndex, slots });
        const row = rowsBySeries.get(match.seriesIndex);
        if (row) {
          const seeds = seedsBySeries.get(match.seriesIndex)!;
          const firstScore = row.score.p1;
          const secondScore = row.score.p2;
          if (
            slots[0] === null ||
            slots[1] === null ||
            seeds.p1 !== slots[0] ||
            seeds.p2 !== slots[1] ||
            (row.round !== undefined && row.round !== roundIndex + 1) ||
            (row.winner_side !== "p1" && row.winner_side !== "p2")
          ) {
            return null;
          }
          const winnerPid = row.winner_side;
          if (
            (winnerPid === "p1" && firstScore <= secondScore) ||
            (winnerPid === "p2" && secondScore <= firstScore)
          ) {
            return null;
          }
          const winnerModel = row.players[winnerPid];
          if (
            (row.winner !== null && row.winner !== winnerModel) ||
            (row.advanced !== undefined && row.advanced !== winnerModel)
          ) {
            return null;
          }
          score = [firstScore, secondScore];
          turns = row.turns;
          winner = slots[winnerPid === "p1" ? 0 : 1];
        }
      }
      views.push({ seriesIndex: match.seriesIndex, slots, winner, score, turns });
    }
    for (const [matchIndex, view] of views.entries()) winners.set(matchIndex, view.winner);
    rounds.push(views);
  }
  return {
    entrants,
    rounds,
    champion: rounds[rounds.length - 1]?.[0]?.winner ?? null,
    rowsBySeries,
    locations,
  };
}

function tournamentSeriesLocation(
  fold: TournamentFold,
  seriesIndex: SeriesIndexArtifact,
): TournamentSeriesLocation | null {
  const parsed = safeIntegerSchema.safeParse(seriesIndex);
  return parsed.success ? (fold.locations.get(parsed.data) ?? null) : null;
}

function locateTournamentStarts<T>(
  fold: TournamentFold,
  starts: Array<{ value: T; seriesIndex: SeriesIndexArtifact }>,
): Array<{ value: T; seriesIndex: number; location: TournamentSeriesLocation }> | null {
  const seen = new Set<number>();
  const located: Array<{ value: T; seriesIndex: number; location: TournamentSeriesLocation }> = [];
  for (const start of starts) {
    const parsed = safeIntegerSchema.safeParse(start.seriesIndex);
    if (!parsed.success) continue;
    const seriesIndex = parsed.data;
    if (fold.rowsBySeries.has(seriesIndex)) continue;
    const location = tournamentSeriesLocation(fold, seriesIndex);
    if (
      !location ||
      location.slots[0] === null ||
      location.slots[1] === null ||
      seen.has(seriesIndex)
    )
      return null;
    seen.add(seriesIndex);
    located.push({ value: start.value, seriesIndex, location });
  }
  return located;
}

function archiveTournament(
  runId: string,
  rows: ParsedSeriesRecord[],
  runsDir: string,
  teamsDir?: string,
): TournamentProjection<TournamentArchiveView> | null {
  const config = runConfig(runsDir, runId);
  const fold = foldTournament(rows, configEntrants(config));
  if (!fold) return null;
  const pool = rows.find((row) => row.pool !== undefined)?.pool ?? config?.pool ?? null;
  const { event, teams } = poolProvenance(pool, teamsDir);
  const detailed = fold.entrants.map((entrant) => ({
    ...entrant,
    ...teams.get(entrant.team),
    model: entrant.model,
  }));
  const live = isRunLive(runsDir, runId);
  const unfinished = live
    ? scanUnfinishedSeries(runsDir, runId, rows).filter(
        (entry) => entry.decisions > 0 || entry.players,
      )
    : [];
  const located = locateTournamentStarts(
    fold,
    unfinished.map((entry) => ({ value: entry, seriesIndex: entry.seriesIndex })),
  );
  if (!located) return null;
  const liveSeries: TournamentLiveSeriesView[] = located.map(
    ({ value: entry, seriesIndex, location }) => ({
      seriesId: entry.seriesId,
      seriesIndex,
      round: location.round,
      slots: location.slots,
      game: entry.game,
      turn: entry.turn,
      decisions: entry.decisions,
    }),
  );
  const timestamps = rows.map((row) => String(row.timestamp ?? "")).filter(Boolean);
  const provenance = config?.provenance;
  return {
    fold,
    view: {
      runId,
      when: timestamps.sort()[0] ?? runStartedAt(runsDir, runId),
      pool,
      entrants: detailed,
      rounds: fold.rounds,
      champion: fold.champion,
      complete: fold.champion !== null,
      live,
      liveSeries,
      event,
      provenance: provenance ?? null,
    },
  };
}

export function buildTournamentGame(
  allRows: ParsedSeriesRecord[],
  runsDir: string,
  runId: string,
  seriesIndex: number,
  game: number,
  teamsDir?: string,
): LeagueGameResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const rows = allRows.filter(
    (row) => row.mode === "tournament" && String(row.run_id ?? "") === runId,
  );
  const projection = archiveTournament(runId, rows, runsDir, teamsDir);
  if (!projection) return null;
  const location = tournamentSeriesLocation(projection.fold, seriesIndex);
  if (!location || location.slots[0] === null || location.slots[1] === null) return null;
  const row = projection.fold.rowsBySeries.get(seriesIndex);
  const seriesId =
    row === undefined
      ? (projection.view.liveSeries.find((entry) => entry.seriesIndex === seriesIndex)?.seriesId ??
        "")
      : String(row.series_id ?? "");
  if (!seriesId) return null;
  return buildSeriesGame(
    runsDir,
    runId,
    seriesIndex,
    game,
    {
      seriesId,
      sides: [location.slots[0], location.slots[1]],
      stage: "playoff",
      round: location.round + 1,
      models: projection.view.entrants.map((entrant) => entrant.model),
      labels: projection.view.entrants.map((entrant) => entrant.team || entrant.model),
    },
    row,
  );
}

export function buildTournaments(
  allRows: ParsedSeriesRecord[],
  runsDir: string,
  pool: string | null,
  teamsDir?: string,
): TournamentsResponse {
  const tournamentRows = allRows.filter(
    (row) =>
      row.mode === "tournament" && (pool === null ? row.pool !== TEST_POOL : row.pool === pool),
  );
  const pools = [
    ...new Set(
      allRows
        .filter((row) => row.mode === "tournament")
        .map((row) => row.pool ?? "")
        .filter(Boolean),
    ),
  ].sort();
  const runs = new Map<string, ParsedSeriesRecord[]>();
  for (const row of tournamentRows) {
    const runId = String(row.run_id ?? "");
    if (!runId) continue;
    const list = runs.get(runId) ?? [];
    list.push(row);
    runs.set(runId, list);
  }
  for (const runId of liveTournamentRuns(runsDir)) if (!runs.has(runId)) runs.set(runId, []);
  const tournaments = [...runs.entries()]
    .flatMap(([runId, rows]) => {
      const archive = archiveTournament(runId, rows, runsDir, teamsDir);
      return archive ? [archive.view] : [];
    })
    .sort((a, b) => b.when.localeCompare(a.when));
  return { pool, pools, summary: summarizeTournaments(tournaments), tournaments };
}
