import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { writeAtomicJson } from "./atomic-json.js";
import { type RegisteredMon, summarizeGameLogs, teamPreviewPicks } from "./game-usage.js";
import { readJsonlObjects } from "./jsonl.js";
import { SAFE_SEGMENT } from "./path-safety.js";
import { defaultPsDir } from "./paths.js";
import {
  type PublicTournamentBundle,
  publicTournamentBundleSchema,
} from "./public/tournament-protocol.js";
import { readCompletedSeriesDecisionRows, readCompletedSeriesGameLogs } from "./recorded-series.js";
import { loadSeriesRecords, type ParsedSeriesRecord } from "./records.js";
import { buildSeriesGame, type SeriesSlot, spriteIdFor, viewTeamSheet } from "./run-artifacts.js";
import { runStatusSchema } from "./run-status.js";
import { loadShowdown } from "./showdown.js";
import { loadPool } from "./teams.js";
import {
  applyBracketOutcome,
  type BracketMatch,
  briefEvent,
  buildBracket,
  tournamentConfigSchema,
} from "./tournament.js";
import type { JsonObject } from "./types.js";

export interface ExportTournamentOptions {
  out: string;
  recordsPath: string;
  runsDir: string;
  runId: string;
  title: string;
  generatedAt?: string;
}

interface EntrantView {
  id: string;
  model: string;
  team: PublicTournamentBundle["entrants"][number]["team"];
  mons: RegisteredMon[];
}

function entrantRef(position: number): string {
  return `entrant-${position}`;
}

function monKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function battleFormeFor(
  dex: ReturnType<ReturnType<typeof loadShowdown>["Dex"]["mod"]>,
  species: string,
  item: string,
): string | null {
  if (!item) return null;
  const stone = dex.items.get(item);
  const mega = Object.entries(stone.megaStone ?? {}).find(
    ([base]) => monKey(base) === monKey(species),
  )?.[1];
  if (mega) return mega;
  const primal = dex.species.get(`${species}-Primal`);
  if (primal.exists && primal.requiredItem && monKey(primal.requiredItem) === monKey(item)) {
    return primal.name;
  }
  return null;
}

const storedSeedsSchema = z.strictObject({
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
});

const SERIES_ATTEMPTS_FILE = "series-attempts.jsonl";

interface SeriesEvidence {
  logs: string[][];
  decisionRows: [JsonObject[], JsonObject[]];
}

function seriesEvidence(seriesDir: string, seriesId: string, gameCount: number): SeriesEvidence {
  if (fs.existsSync(path.join(seriesDir, SERIES_ATTEMPTS_FILE))) {
    return {
      logs: readCompletedSeriesGameLogs(seriesDir, seriesId),
      decisionRows: [
        readCompletedSeriesDecisionRows(seriesDir, seriesId, "p1"),
        readCompletedSeriesDecisionRows(seriesDir, seriesId, "p2"),
      ],
    };
  }
  return {
    logs: Array.from({ length: gameCount }, (_, index) =>
      fs.readFileSync(path.join(seriesDir, `game-${index + 1}.log`), "utf8").split("\n"),
    ),
    decisionRows: [
      readJsonlObjects(path.join(seriesDir, "p1-decisions.jsonl")),
      readJsonlObjects(path.join(seriesDir, "p2-decisions.jsonl")),
    ],
  };
}

export function buildTournamentExport(
  options: Omit<ExportTournamentOptions, "out">,
): PublicTournamentBundle {
  if (!SAFE_SEGMENT.test(options.runId))
    throw new Error(`invalid run id ${JSON.stringify(options.runId)}`);
  const runDir = path.join(options.runsDir, options.runId);
  const config = tournamentConfigSchema.parse(
    JSON.parse(fs.readFileSync(path.join(runDir, "config.json"), "utf8")),
  );
  if (!config.pool)
    throw new Error(`run ${options.runId} keeps inline teams; only pool tournaments export`);
  const pool = loadPool(config.pool);
  const format = config.format ?? pool.format;
  if (format !== pool.format)
    throw new Error(`run ${options.runId} plays ${format}, not pool format ${pool.format}`);
  const provenance = config.provenance ?? "disclosed";

  const psDir = defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(format).mod || "base");
  const teamsById = new Map(pool.teams.map((team) => [team.id, team]));

  const entrants: EntrantView[] = config.entrants.map((entrant, position) => {
    const team = teamsById.get(entrant.team);
    if (!team)
      throw new Error(`run ${options.runId} seats ${entrant.team}, unknown in pool ${pool.id}`);
    const mons: RegisteredMon[] = [];
    const sets = viewTeamSheet(team.packed).map((set) => {
      const setId = `${entrantRef(position)}-${monKey(set.species)}`;
      const forme = battleFormeFor(dex, set.species, set.item);
      mons.push({ id: setId, species: set.species, forme: forme ?? undefined });
      return {
        id: setId,
        species: set.species,
        spriteId: set.spriteId,
        item: set.item,
        ability: set.ability,
        nature: set.nature,
        moves: [...set.moves],
        evs: { ...set.evs },
        mega: forme ? { species: forme, spriteId: spriteIdFor(forme) } : null,
      };
    });
    return {
      id: entrantRef(position),
      model: entrant.model,
      team: {
        id: team.id,
        seed: team.seed ?? null,
        placement: team.provenance?.placement ?? null,
        player: team.provenance?.player ?? "",
        handle: team.provenance?.handle ?? "",
        swiss: team.provenance?.swiss ?? "",
        paste: team.provenance?.paste ?? "",
        sets,
      },
      mons,
    };
  });

  const rows = new Map<number, ParsedSeriesRecord>();
  for (const row of loadSeriesRecords(options.recordsPath)) {
    if (row.run_id !== options.runId || row.mode !== "tournament") continue;
    if (rows.has(row.series_index))
      throw new Error(`run ${options.runId} repeats tournament series ${row.series_index}`);
    rows.set(row.series_index, row);
  }

  let rounds = buildBracket(entrants.length);
  const settled = new Map<number, { match: BracketMatch; row: ParsedSeriesRecord }>();
  for (;;) {
    const match = rounds
      .flat()
      .find(
        (candidate) =>
          candidate.seriesIndex !== null &&
          candidate.slots[0] !== null &&
          candidate.slots[1] !== null &&
          !settled.has(candidate.seriesIndex) &&
          rows.has(candidate.seriesIndex),
      );
    if (!match) break;
    const row = rows.get(match.seriesIndex!)!;
    const seeds = storedSeedsSchema.parse(row.seeds);
    if (seeds.p1 !== match.slots[0] || seeds.p2 !== match.slots[1]) {
      throw new Error(
        `run ${options.runId} series ${match.seriesIndex} seats do not match its bracket slots`,
      );
    }
    if (!row.winner_side)
      throw new Error(`run ${options.runId} series ${match.seriesIndex} has no winner`);
    const winner = entrants[match.slots[row.winner_side === "p1" ? 0 : 1]!]!;
    if (row.advanced !== winner.model) {
      throw new Error(
        `run ${options.runId} series ${match.seriesIndex} advanced ${row.advanced}, not its winner`,
      );
    }
    rounds = applyBracketOutcome(rounds, match, row.winner_side);
    settled.set(match.seriesIndex!, { match, row });
  }
  const unsettled = [...rows.keys()].filter((index) => !settled.has(index));
  if (unsettled.length > 0) {
    throw new Error(
      `run ${options.runId} recorded series ${unsettled.join(", ")} outside the bracket order`,
    );
  }

  const models = entrants.map((entrant) => entrant.model);
  const matches = new Map<
    number,
    PublicTournamentBundle["bracket"]["rounds"][number][number]["match"]
  >();
  const replays: PublicTournamentBundle["replays"] = {};
  for (const { row } of settled.values()) {
    const sides: [number, number] = [
      storedSeedsSchema.parse(row.seeds).p1,
      storedSeedsSchema.parse(row.seeds).p2,
    ];
    const refs: [string, string] = [entrantRef(sides[0]), entrantRef(sides[1])];
    const seriesDir = path.join(options.runsDir, options.runId, "series", row.series_id);
    const evidence = seriesEvidence(seriesDir, row.series_id, row.games.length);
    if (evidence.logs.length !== row.games.length) {
      throw new Error(
        `series ${row.series_id} has ${evidence.logs.length} completed logs for ${row.games.length} recorded games`,
      );
    }
    const teamPicks = teamPreviewPicks(evidence.decisionRows, row.games.length);
    for (const [gameIndex, picks] of teamPicks.entries()) {
      for (const side of [0, 1] as const) {
        if (!picks[side]) {
          throw new Error(
            `series ${row.series_id} game ${gameIndex + 1} has no accepted team-preview pick for p${side + 1}`,
          );
        }
      }
    }
    const summaries = summarizeGameLogs(
      evidence.logs,
      [entrants[sides[0]]!.mons, entrants[sides[1]]!.mons],
      teamPicks,
    );
    const slot: SeriesSlot = {
      seriesId: row.series_id,
      sides,
      stage: "playoff",
      round: row.round ?? 1,
      models,
      labels: models,
    };
    const gameSummaries = row.games.map((game, index) => {
      const summary = summaries[index];
      if (!summary)
        throw new Error(`series ${row.series_id} game ${game.number} has no verified summary`);
      return {
        number: game.number,
        winnerId: game.winner_side === null ? null : refs[game.winner_side === "p1" ? 0 : 1],
        turns: game.turns,
        brought: summary.brought,
        megaEvolved: summary.megaEvolved,
        faints: summary.faints,
      };
    });
    replays[row.series_id] = {
      seriesId: row.series_id,
      entrants: refs,
      games: row.games.map((game, index) => {
        const built = buildSeriesGame(
          options.runsDir,
          options.runId,
          row.series_index,
          game.number,
          slot,
          row,
        );
        if (!built)
          throw new Error(`series ${row.series_id} game ${game.number} has no verified replay`);
        return {
          ...gameSummaries[index]!,
          raw: evidence.logs[index]!.join("\n"),
          events: built.log.map((entry) => ({ ...entry })),
          decisions: built.decisions.map((decision) => ({
            entrantId: refs[decision.side],
            turn: decision.turn,
            phase: decision.phase,
            action: decision.action,
            selection: [...decision.selection],
            rationale: decision.rationale,
            notebook: decision.notebook,
            fallback: decision.fallback,
            automatic: decision.automatic,
            latencyMs: decision.latencyMs,
            reasoningTokens: decision.reasoningTokens,
          })),
          reflections: built.reflections.map((reflection) => ({
            entrantId: refs[reflection.side],
            result: reflection.result,
            summary: reflection.summary,
            adjustment: reflection.adjustment,
            notebook: reflection.notebook,
            fallback: reflection.fallback,
          })),
        };
      }),
    };
    matches.set(row.series_index, {
      seriesIndex: row.series_index,
      seriesId: row.series_id,
      entrants: refs,
      score: [row.score.p1, row.score.p2],
      winnerId: refs[row.winner_side === "p1" ? 0 : 1],
      games: gameSummaries,
    });
  }

  const settledRows = [...settled.values()].map(({ row }) => row);
  const commits = new Set(settledRows.map((row) => row.ps_commit));
  if (commits.size > 1)
    throw new Error(`run ${options.runId} mixes Showdown commits ${[...commits].join(", ")}`);
  const showdownCommit = [...commits][0];
  const timestamps = settledRows.map((row) => row.timestamp).sort();
  const seriesStarts = settledRows.flatMap((row) => {
    try {
      const metadata = z
        .looseObject({ started: z.iso.datetime() })
        .safeParse(
          JSON.parse(
            fs.readFileSync(path.join(runDir, "series", row.series_id, "series.json"), "utf8"),
          ),
        );
      return metadata.success ? [metadata.data.started] : [];
    } catch {
      return [];
    }
  });
  let storedStart: string | undefined;
  try {
    const status = runStatusSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8")),
    );
    if (status.success) storedStart = status.data.start_time;
  } catch {}
  const startedAt = [
    ...(storedStart ? [storedStart] : []),
    ...timestamps,
    ...seriesStarts,
  ].sort()[0];
  if (!startedAt) throw new Error(`run ${options.runId} has no start time and no played series`);

  const champion = rounds[rounds.length - 1]![0]!.winner;
  return publicTournamentBundleSchema.parse({
    generatedAt: options.generatedAt ?? timestamps[timestamps.length - 1] ?? startedAt,
    tournament: {
      id: options.runId,
      title: options.title,
      format,
      provenance,
      showdownCommit: showdownCommit === "unknown" ? null : (showdownCommit ?? null),
      startedAt,
      championId: champion === null ? null : entrantRef(champion),
    },
    event: pool.event,
    briefing:
      provenance === "disclosed" && pool.event ? briefEvent(pool.event, entrants.length) : null,
    entrants: entrants.map(({ id, model, team }) => ({ id, model, team })),
    bracket: {
      rounds: rounds.map((round) =>
        round.map((match) => ({
          seriesIndex: match.seriesIndex,
          slots: [
            match.slots[0] === null ? null : entrantRef(match.slots[0]),
            match.slots[1] === null ? null : entrantRef(match.slots[1]),
          ],
          match: match.seriesIndex === null ? null : (matches.get(match.seriesIndex) ?? null),
        })),
      ),
    },
    replays,
  });
}

export function exportTournamentBundle(options: ExportTournamentOptions): PublicTournamentBundle {
  const bundle = buildTournamentExport(options);
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  writeAtomicJson(options.out, bundle);
  return bundle;
}
