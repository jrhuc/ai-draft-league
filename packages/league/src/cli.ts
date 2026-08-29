#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { DraftLeagueOptions } from "./draftleague-protocol.js";
import type { ExhibitionOptions } from "./exhibition.js";
import { exportSeasonBundle } from "./export-season.js";
import { draftLeagueConfigSchema } from "./league-store.js";
import { makeRunDirectory, prepareDataDirectories, RESULTS_PATH, RUNS_DIR } from "./paths.js";
import type { ReasoningLevel } from "./providers.js";
import { isReasoningLevel, nitroSpec } from "./providers.js";
import type { ParsedSeriesRecord, SeriesRecord } from "./records.js";
import { loadSeriesRecords, scopeRows, TEST_POOL } from "./records.js";
import { writeReport } from "./report.js";
import { runRotation } from "./rotation.js";
import { withRunStatus } from "./run-status.js";
import type { ExperimentOptions } from "./series.js";
import { teamProvenanceSchema, type Team } from "./teams.js";
import { parseTimerScale } from "./timer.js";
import type { TournamentOptions } from "./tournament.js";
import { tournamentConfigSchema } from "./tournament.js";
import type { TimerScale } from "./types.js";
import { asRecord, count, text } from "./value.js";

const EXPERIMENT_CLI_OPTIONS = {
  models: { type: "string", multiple: true },
  seed: { type: "string" },
  concurrency: { type: "string", default: "4" },
  reasoning: { type: "string" },
  "timer-scale": { type: "string" },
  nitro: { type: "boolean", default: false },
} as const;

interface ExperimentCliValues {
  seed?: string;
  concurrency: string;
  reasoning?: string;
  "timer-scale"?: string;
  nitro: boolean;
}

type ExperimentExecutionOptions = Pick<
  ExperimentOptions,
  "seed" | "reasoning" | "reasoningByModel" | "timerScale"
> & {
  recordsPath: string;
};

const tournamentResumeConfigSchema = tournamentConfigSchema.pick({
  models: true,
  seed: true,
  pool: true,
  format: true,
  provenance: true,
  concurrency: true,
  reasoning: true,
  reasoning_by_model: true,
  timer_scale: true,
});
const draftResumeConfigSchema = draftLeagueConfigSchema
  .pick({
    models: true,
    seed: true,
    board: true,
    concurrency: true,
    reasoning: true,
    timer_scale: true,
    sequential_weeks: true,
    closed_sheets: true,
    draft_only: true,
    transactions: true,
  })
  .partial({ sequential_weeks: true, draft_only: true, transactions: true });
const storedTeamSchema = z.looseObject({
  id: z.string(),
  packed: z.string(),
  seed: z.number().optional(),
  provenance: teamProvenanceSchema.optional(),
  source: z.record(z.string(), z.json()).optional(),
});

function loadStoredTeams(file: string): Team[] {
  return z
    .array(storedTeamSchema)
    .parse(JSON.parse(fs.readFileSync(file, "utf8")))
    .map((stored) => {
      const team: Team = {
        id: stored.id,
        packed: stored.packed,
        seed: stored.seed,
        provenance: stored.provenance,
        source: stored.source,
      };
      return team;
    });
}

const HELP = `Usage: vgcleague <command>

Commands:
  selfcheck                           run one random-vs-random series through the simulator
  rotation --models <spec> <spec>...  run the controlled team-rotation protocol
      [--series-per-pair <n>] [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>]
      [--timer-scale <n|off>] [--nitro]
  tournament --models <spec> <spec>...  play a single-elimination BO3 bracket; each model keeps one team
      [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>] [--timer-scale <n|off>]
      [--nitro] [--provenance <disclosed|blind>] [--resume <run-dir>]
      a pool that seeds its teams keeps the real bracket order instead of drawing positions at random
      --provenance disclosed (default) may name the event and teams; placements/finishes stay withheld
      blind withholds the event context too
      --resume continues a stopped bracket: finished series stand; only an eligible interrupted series
      with matching native requests replays recorded decisions without provider calls. Random-seat,
      timer-autodefault, and other ineligible cases may restart or continue live (models, pool, seed,
      and provenance come from the run's recorded config)
  draft --models <spec> <spec>...     snake-draft rosters from a board, then a weekly round robin and playoffs
      each coach drafts 10 within a 100-point budget, then picks 6 and builds every set before each match
      [--board <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>] [--timer-scale <n|off>]
      [--nitro] [--through-week <n>] [--resume <run-dir>] [--sequential-weeks] [--closed-sheets]
      [--transactions <weeks|off>] [--swaps <n>] [--draft-only] [--rosters <preset.json>]
      --swaps sets each franchise's season allowance of free-agent swaps (default 6)
      --draft-only stops once rosters are drafted and plays no games; resume the run to play the season
      --rosters seeds the league from a packaged roster preset instead of holding a live draft
      --through-week stops cleanly after that round-robin week, including the transaction window
      that follows it when one is scheduled; --resume continues a stored league
      round-robin series run concurrently with blind teambuilds; --sequential-weeks restores
      week-by-week play (implied by --through-week); --closed-sheets hides opposing team sheets
      the free-agent window defaults to week 3 (or the last week in shorter leagues); pass off for locked rosters
      (models, board, and seed come from the run's config; the trade window does too only after season
      settings were fixed—draft-only resumes choose and fix it when season play begins)
  exhibition --opponent <spec>        host one bo3 where a terminal agent plays a seat over a local bridge
      [--seat p1|p2] [--name <label>] [--pool <name>] [--seed <n>] [--port <n>] [--reasoning <level>]
      [--agent-dir <path>]
      opponent specs: openrouter:<model-id>, prime:<model-id>, gateway:<model-id>, opencode-go:<model-id>, opencode-zen:<model-id>, or random
  outcomes [--pool <name>]            print contextual per-series outcomes without an aggregate ranking
  report [--out <path>] [--pool <name>]  write an HTML report
  export-season --run <id> --through-week <n> [--title <text>] [--out <file>]
      atomically write one validated public season bundle;
      n past the last regular-season week releases playoff rounds
  export-tournament --run <id> [--title <text>] [--out <file>]
      atomically write one validated public tournament bundle for a pool bracket;
      every recorded series is released, unplayed bracket slots stay open

Model specs are exactly openrouter:<model-id>, prime:<model-id>, gateway:<model-id>,
opencode-go:<model-id>, opencode-zen:<model-id>, or random.
CLI calls read OPENROUTER_API_KEY, PRIME_API_KEY, AI_GATEWAY_API_KEY, or OPENCODE_API_KEY
for the selected provider. Model IDs are entered manually.


--nitro adds the :nitro throughput-routing variant to every OpenRouter spec that
does not already carry a routing variant. Faster, usually pricier; skip it when
slower seats set the pace anyway.

Without --pool, outcomes and report retain all rows except the disposable "test" pool;
pass --pool <name> to inspect every row in one pool. All modes remain contextual rows
and are never aggregated into a ranking.`;

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be an integer of at least 1`);
  return parsed;
}

function nonnegativeInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`--${name} must be a nonnegative integer`);
  return parsed;
}

function optionalInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function reasoningLevel(value: string | undefined): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  if (!isReasoningLevel(value))
    throw new Error("--reasoning must be one of: minimal, low, medium, high, xhigh");
  return value;
}

function timerScaleOption(value: string | undefined): TimerScale | undefined {
  if (value === undefined) return undefined;
  try {
    return parseTimerScale(value);
  } catch (error) {
    throw new Error(`--timer-scale ${error instanceof Error ? error.message : String(error)}`);
  }
}

function experimentModels(
  command: string,
  models: string[] | undefined,
  positionals: string[],
  nitro = false,
): string[] {
  const selected = [...(models ?? []), ...positionals];
  if (selected.length < 2) throw new Error(`${command} requires at least two --models`);
  return nitro ? selected.map(nitroSpec) : selected;
}

function experimentExecution(values: ExperimentCliValues): ExperimentExecutionOptions {
  return {
    recordsPath: RESULTS_PATH,
    seed: optionalInteger("seed", values.seed),
    reasoning: reasoningLevel(values.reasoning),
    timerScale: timerScaleOption(values["timer-scale"]),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  prepareDataDirectories();
  const [command, ...rest] = argv;
  if (command === "selfcheck") return selfcheck();
  if (command === "rotation") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        ...EXPERIMENT_CLI_OPTIONS,
        "series-per-pair": { type: "string", default: "2" },
        pool: { type: "string", default: "test" },
      },
    });
    const models = experimentModels(command, values.models, positionals, values.nitro);
    const execution = experimentExecution(values);
    const runDir = makeRunDirectory();
    const rows = await withRunStatus(runDir, () =>
      runRotation(models, positiveInteger("series-per-pair", values["series-per-pair"]), runDir, {
        pool: values.pool,
        concurrency: positiveInteger("concurrency", values.concurrency),
        ...execution,
      }),
    );
    printResults(rows);
    return 0;
  }
  if (command === "tournament") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        ...EXPERIMENT_CLI_OPTIONS,
        pool: { type: "string", default: "test" },
        provenance: { type: "string" },
        resume: { type: "string" },
      },
    });
    const { runTournament, DEFAULT_PROVENANCE } = await import("./tournament.js");
    const resumeDir = values.resume ? path.resolve(values.resume) : undefined;
    const storedConfig = resumeDir
      ? tournamentResumeConfigSchema.parse(
          JSON.parse(fs.readFileSync(path.join(resumeDir, "config.json"), "utf8")),
        )
      : undefined;
    const storedTeams =
      resumeDir && storedConfig && !storedConfig.pool
        ? loadStoredTeams(path.join(resumeDir, "teams.json"))
        : undefined;
    const models = storedConfig
      ? storedConfig.models
      : experimentModels(command, values.models, positionals, values.nitro);
    let execution: ExperimentExecutionOptions;
    if (storedConfig) {
      const storedReasoning = storedConfig.reasoning
        ? reasoningLevel(storedConfig.reasoning)
        : undefined;
      const storedByModel = Object.entries(storedConfig.reasoning_by_model ?? {}).flatMap(
        ([model, level]) => {
          const parsed = reasoningLevel(level);
          return parsed === undefined ? [] : [[model, parsed] as const];
        },
      );
      execution = {
        recordsPath: RESULTS_PATH,
        seed: storedConfig.seed,
        reasoning: storedReasoning,
        reasoningByModel: storedByModel.length > 0 ? Object.fromEntries(storedByModel) : undefined,
        timerScale: storedConfig.timer_scale,
      };
    } else {
      execution = experimentExecution(values);
    }
    const provenance = storedConfig?.provenance ?? values.provenance ?? DEFAULT_PROVENANCE;
    if (provenance !== "disclosed" && provenance !== "blind")
      throw new Error('--provenance must be "disclosed" or "blind"');
    const runDir = resumeDir ?? makeRunDirectory();
    const tournamentOptions: TournamentOptions = {
      provenance,
      concurrency: storedConfig?.concurrency ?? positiveInteger("concurrency", values.concurrency),
      ...execution,
    };
    if (storedTeams) {
      tournamentOptions.teams = storedTeams;
      if (storedConfig?.format) tournamentOptions.format = storedConfig.format;
    } else {
      tournamentOptions.pool = storedConfig?.pool ?? values.pool;
    }
    if (resumeDir) tournamentOptions.resume = true;
    const rows = await withRunStatus(runDir, () =>
      runTournament(models, runDir, tournamentOptions),
    );
    printResults(rows);
    const champion = rows[rows.length - 1];
    if (champion) console.log(`Champion: ${champion.advanced ?? champion.winner ?? "?"}`);
    return 0;
  }
  if (command === "draft") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        ...EXPERIMENT_CLI_OPTIONS,
        board: { type: "string", default: "regmb-202607" },
        "through-week": { type: "string" },
        resume: { type: "string" },
        "sequential-weeks": { type: "boolean", default: false },
        "closed-sheets": { type: "boolean", default: false },
        transactions: { type: "string" },
        swaps: { type: "string" },
        "draft-only": { type: "boolean", default: false },
        rosters: { type: "string" },
      },
    });
    const { runDraftLeague } = await import("./draftleague.js");
    const { loadRosterPreset } = await import("./roster-preset.js");
    if (values.rosters && values.resume)
      throw new Error("--rosters applies to a new league; resume reads stored rosters");
    const preset = values.rosters ? loadRosterPreset(path.resolve(values.rosters)) : undefined;
    const { draftLeagueTopology } = await import("./draftleague-topology.js");
    const { parseTransactionWeeks } = await import("./trade-window.js");
    const resumeDir = values.resume ? path.resolve(values.resume) : undefined;
    const storedConfig = resumeDir
      ? draftResumeConfigSchema.parse(
          JSON.parse(fs.readFileSync(path.join(resumeDir, "config.json"), "utf8")),
        )
      : undefined;
    const models = storedConfig
      ? storedConfig.models
      : experimentModels(command, values.models, positionals, values.nitro);
    let execution: ExperimentExecutionOptions;
    if (storedConfig) {
      const storedReasoning = storedConfig.reasoning
        ? reasoningLevel(storedConfig.reasoning)
        : undefined;
      execution = {
        recordsPath: RESULTS_PATH,
        seed: storedConfig.seed,
        reasoning: storedReasoning,
        timerScale: storedConfig.timer_scale,
      };
    } else {
      execution = experimentExecution(values);
    }
    const throughWeek =
      values["through-week"] === undefined
        ? undefined
        : positiveInteger("through-week", values["through-week"]);
    const storedSchedule =
      storedConfig && storedConfig.draft_only !== true
        ? (storedConfig.transactions ?? []).map((window) => ({
            afterWeek: window.after_week,
            tradesAllowed: window.trades_allowed,
          }))
        : undefined;
    const transactions =
      storedSchedule ??
      (values.transactions === undefined
        ? undefined
        : parseTransactionWeeks(values.transactions, draftLeagueTopology(models.length).weekCount));
    const runDir = resumeDir ?? makeRunDirectory();
    let lastTeambuilds = 0;
    const draftOptions: DraftLeagueOptions = {
      board: storedConfig ? storedConfig.board : values.board,
      concurrency: storedConfig?.concurrency ?? positiveInteger("concurrency", values.concurrency),
      ...execution,
      onEvent: (event) => {
        if (event.type !== "draft") return;
        if (event.draft.phase === "draft" && event.draft.picks.length > 0) {
          const pick = event.draft.picks[event.draft.picks.length - 1]!;
          const coach = event.draft.teamNames[pick.entrant] || event.draft.entrants[pick.entrant];
          console.log(
            `pick ${pick.pick}: ${coach} takes ${pick.mon}${pick.fallback ? " (fallback)" : ""}`,
          );
        }
        if (event.draft.teambuilds.length > lastTeambuilds) {
          lastTeambuilds = event.draft.teambuilds.length;
          const build = event.draft.teambuilds[lastTeambuilds - 1]!;
          const repaired = build.sets.filter((set) => set.repaired).length;
          console.log(
            `teambuild: ${event.draft.teamNames[build.entrant] || event.draft.entrants[build.entrant]} vs ` +
              `${event.draft.teamNames[build.opponent] || event.draft.entrants[build.opponent]} — ` +
              `${build.brought.join(", ")}${repaired ? ` (${repaired} repaired)` : ""}`,
          );
        }
      },
      throughWeek,
      resume: Boolean(resumeDir),
      sequentialWeeks: storedConfig
        ? storedConfig.sequential_weeks === true
        : values["sequential-weeks"],
      closedSheets: storedConfig ? storedConfig.closed_sheets === true : values["closed-sheets"],
      transactions,
      swapsAllowed:
        values.swaps === undefined ? undefined : nonnegativeInteger("swaps", values.swaps),
      draftOnly: values["draft-only"],
      preset,
    };
    const rows = await withRunStatus(runDir, () => runDraftLeague(models, runDir, draftOptions));
    printResults(rows);
    const totalSeries = draftLeagueTopology(models.length).totalSeries;
    if (values["draft-only"]) {
      console.log(`Draft complete; no games played. Rosters: ${path.join(runDir, "rosters.json")}`);
      console.log(`Play the season later with: vgcleague draft --resume ${runDir}`);
    } else if (rows.length < totalSeries) {
      console.log(`League stopped after ${rows.length} of ${totalSeries} series.`);
      console.log(`Resume with: vgcleague draft --resume ${runDir}`);
    } else {
      const champion = text(rows[rows.length - 1]?.advanced);
      if (!champion) throw new Error("draft final did not identify a champion");
      console.log(`Champion: ${champion}`);
    }
    console.log(`Draft logs: ${path.join(runDir, "draft")}`);
    console.log(`Teambuild logs: ${path.join(runDir, "teambuild")}`);
    return 0;
  }
  if (command === "exhibition") {
    const { values } = parseArgs({
      args: rest,
      options: {
        opponent: { type: "string" },
        seat: { type: "string", default: "p1" },
        name: { type: "string", default: "cli-agent" },
        pool: { type: "string", default: "test" },
        seed: { type: "string" },
        port: { type: "string" },
        reasoning: { type: "string" },
        "agent-dir": { type: "string" },
      },
    });
    if (!values.opponent) throw new Error("exhibition requires --opponent <spec|random>");
    if (values.seat !== "p1" && values.seat !== "p2") throw new Error("--seat must be p1 or p2");
    const opponent = values.opponent;
    const seat = values.seat;
    const reasoning = reasoningLevel(values.reasoning);
    const seed = optionalInteger("seed", values.seed);
    const { runExhibition } = await import("./exhibition.js");
    const runDir = makeRunDirectory();
    const exhibitionOptions: ExhibitionOptions = {
      opponent,
      seat,
      name: values.name,
      pool: values.pool,
      recordsPath: RESULTS_PATH,
      onNotice: (line) => console.log(line),
      onReady: ({ url, agentDir }) => {
        console.log(`Seat bridge listening at ${url}`);
        console.log(`Agent workspace: ${agentDir}`);
        console.log(
          "Start the terminal agent with that directory as its working directory and have it read SEAT.md.",
        );
      },
      seed,
      port: values.port === undefined ? undefined : positiveInteger("port", values.port),
      reasoning,
      agentDir: values["agent-dir"],
    };
    const row = await withRunStatus(runDir, () => runExhibition(runDir, exhibitionOptions));
    printResults([row]);
    return 0;
  }
  if (command === "export-season") {
    const { values } = parseArgs({
      args: rest,
      options: {
        out: { type: "string" },
        run: { type: "string" },
        title: { type: "string", default: "AI Draft League" },
        "through-week": { type: "string" },
      },
    });
    if (!values.run) throw new Error("export-season requires --run <id>");
    if (values["through-week"] === undefined) {
      throw new Error(
        "export-season requires --through-week <n> so publication never advances implicitly",
      );
    }
    const releasedThroughWeek = nonnegativeInteger("through-week", values["through-week"]);
    const out = path.resolve(
      values.out ?? path.join("artifacts", "public", "seasons", values.run, "season-bundle.json"),
    );
    const bundle = exportSeasonBundle({
      out,
      recordsPath: RESULTS_PATH,
      runsDir: RUNS_DIR,
      runId: values.run,
      title: values.title,
      releasedThroughWeek,
    });
    console.log(
      `${bundle.season.title} exported through week ${bundle.season.releasedThroughWeek}` +
        (bundle.season.releasedPlayoffRounds > 0
          ? ` + ${bundle.season.releasedPlayoffRounds} playoff round(s)`
          : "") +
        ` to ${out}`,
    );
    return 0;
  }
  if (command === "export-tournament") {
    const { values } = parseArgs({
      args: rest,
      options: {
        out: { type: "string" },
        run: { type: "string" },
        title: { type: "string", default: "AI Replay Bracket" },
      },
    });
    if (!values.run) throw new Error("export-tournament requires --run <id>");
    const out = path.resolve(
      values.out ??
        path.join("artifacts", "public", "tournaments", values.run, "tournament-bundle.json"),
    );
    const { exportTournamentBundle } = await import("./export-tournament.js");
    const bundle = exportTournamentBundle({
      out,
      recordsPath: RESULTS_PATH,
      runsDir: RUNS_DIR,
      runId: values.run,
      title: values.title,
    });
    const played = Object.keys(bundle.replays).length;
    console.log(
      `${bundle.tournament.title} exported with ${played} of ${bundle.entrants.length - 1} series to ${out}`,
    );
    return 0;
  }
  if (command === "outcomes" || command === "report") {
    const { values } = parseArgs({
      args: rest,
      options: {
        pool: { type: "string" },
        out: { type: "string", default: path.join(path.dirname(RESULTS_PATH), "report.html") },
      },
    });
    if (command === "report") {
      console.log(writeReport(RESULTS_PATH, values.out, values.pool));
      return 0;
    }
    if (values.pool === undefined)
      console.log(`All pools except ${JSON.stringify(TEST_POOL)}; use --pool for one.\n`);
    printOutcomes(scopeRows(loadSeriesRecords(RESULTS_PATH), values.pool));
    return 0;
  }
  console.error(HELP);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

async function selfcheck(): Promise<number> {
  const directory = makeRunDirectory();
  try {
    const rows = await runRotation(["random", "random"], 1, directory, {
      seed: 1,
      concurrency: 1,
      recordsPath: path.join(directory, "results.jsonl"),
    });
    printResults(rows);
    return 0;
  } catch (error) {
    console.error(`selfcheck failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printResults(rows: SeriesRecord[]): void {
  for (const row of rows) {
    const score = asRecord(row.score);
    const games = Array.isArray(row.games) ? row.games : [];
    console.log(
      `${row.players.p1} vs ${row.players.p2}: ${row.winner ?? "tie"} (${count(score.p1)}-${count(score.p2)}, ${games.length} games, ${row.turns} turns)`,
    );
  }
}

function renderTable(head: string[], rows: string[][]): string {
  const widths = head.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
  const rule = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
  return [line(head), rule, ...rows.map(line)].join("\n");
}

function printOutcomes(rows: ParsedSeriesRecord[]): void {
  console.log(
    `${rows.length} contextual series records. Outcomes are not aggregated into a model ranking; compare only like-for-like run settings.`,
  );
  if (!rows.length) return;
  console.log(
    renderTable(
      ["Mode", "Pool", "Clock", "p1", "p2", "Score", "Winner", "Run / series"],
      rows.map((row) => {
        const score = row.score;
        const clock = row.timer_scale === "off" ? "off" : `${row.timer_scale ?? 1}x`;
        return [
          row.mode,
          row.pool ?? "unrecorded",
          clock,
          row.players.p1,
          row.players.p2,
          `${score.p1}-${score.p2}`,
          row.winner ?? "tie",
          `${row.run_id} / ${row.series_id}`,
        ];
      }),
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
