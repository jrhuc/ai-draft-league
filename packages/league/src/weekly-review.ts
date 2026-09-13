import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { createBoardSearch } from "./board-search.js";
import type { AgentRunner, AgentTool } from "./agent-runtime.js";
import { reviewReferenceTools, runStage, submissionTool } from "./stage-agent.js";
import type { DraftBoard, DraftBoardMon } from "./draft.js";
import {
  cloneMemory,
  type FranchiseMemory,
  MEMORY_LIMITS,
  MEMORY_TOOL_NOTICE,
  parseMemoryReply,
  READ_MEMORY_PAGE,
  readMemoryPage,
  renderMemory,
} from "./franchise-memory.js";
import { type GameSummary, seriesGameSummaries } from "./game-usage.js";
import type { DraftTableRow, TeamBuildView } from "./views.js";
import { BattleLog } from "./battlelog.js";
import { readFranchiseCheckpoints, storeFranchiseCheckpoint } from "./league-journal.js";
import {
  FORMAT_AUTHORITY_NOTICE,
  MANAGER_CHARGE,
  PARALLEL_TOOLS_RULE,
  renderPromptTemplate,
} from "./prompts.js";
import { reasoningForModel, type ModelReasoningConfig } from "./providers.js";
import { ShowdownReference } from "./reference.js";
import {
  mapLimit,
  readCompletedSeriesDecisionRows,
  readCompletedSeriesGameLogs,
} from "./series.js";
import type { JsonObject } from "./types.js";
import { count, fileSlug, text } from "./value.js";

const MEMORY_NOTICE = `- Your memory is yours to organise: a plan page shown to later managers and team builders, plus up to ${MEMORY_LIMITS.pages - 1} named pages they can fetch with read_memory_page. Each page holds at most ${MEMORY_LIMITS.pageChars} characters, ${MEMORY_LIMITS.totalChars} in all. The builder passes its team plan and set notes to the battle pilot. Completed series and earlier memory checkpoints remain available through the league tools; your review reasoning is recorded as evidence, but is not included in later prompts.`;

const LEAGUE_TOOLS_NOTICE =
  `You have the Showdown dex tools and five league tools: read_public_series returns the spectator log of any completed series, read_own_series returns your own turn-by-turn choices with their stated reasons and your end-of-game notes, read_own_build returns the six you registered for a series, your plan, and what you brought, Mega Evolved, and lost in each game, read_memory_page returns one of your pages in full, and read_memory_history returns your memory as it stood after an earlier review or reconciliation. ${PARALLEL_TOOLS_RULE}`;

const WEEKLY_REVIEW_PROMPT_POLICY = {
  systemTemplate: [
    "You are {{model}}, manager of a franchise in a Pokémon VGC draft league played in the format {{format}}.",
    MANAGER_CHARGE,
    FORMAT_AUTHORITY_NOTICE,
    "",
    "Round-robin week {{week}} of {{weeks}} is complete. This is your private weekly review: the one point where you revise the memory that every later team build and transaction decision of yours reads.",
    "- The six registered and the games played this week were built and piloted from the memory you had written; judge them as work done on your behalf.",
    MEMORY_NOTICE,
    "- Every coach builds a new six from its roster for every matchup. Sets, items, moves and spreads you saw this week were built for that one series and may not return.",
    "- Rosters change only in transaction windows. {{windowNotice}}",
    "",
    LEAGUE_TOOLS_NOTICE,
  ],
  reconcileSystemTemplate: [
    "You are {{model}}, manager of a franchise in a Pokémon VGC draft league played in the format {{format}}.",
    MANAGER_CHARGE,
    FORMAT_AUTHORITY_NOTICE,
    "",
    "The transaction window after round-robin week {{week}} of {{weeks}} has closed and your roster changed. This is your private reconciliation: revise the memory that every later team build and transaction decision of yours reads so that it describes the roster you now own.",
    MEMORY_NOTICE,
    "- Every coach builds a new six from its roster for every matchup.",
    "- {{windowNotice}}",
    "",
    LEAGUE_TOOLS_NOTICE,
  ],
  standingsHeading: "LEAGUE STANDINGS AFTER WEEK {{week}} (rank | coach | W-L | games):",
  ownResultsHeading: "YOUR SERIES THIS PERIOD:",
  publicResultsHeading: "OTHER RESULTS THIS PERIOD (series index | result):",
  scheduleHeading: "YOUR REMAINING SCHEDULE (week | opponent | their current roster):",
  transactionsHeading: "PUBLIC TRANSACTIONS SO FAR:",
  rosterHeading: "YOUR ROSTER:",
  previousRosterHeading: "YOUR ROSTER BEFORE THE WINDOW:",
  currentRosterHeading: "YOUR ROSTER NOW:",
  replyTemplate: [
    'Call submit_review with {"plan":"<complete replacement plan page>","set_pages":{"<name>":"<complete page text>",...},"delete_pages":["<name>",...]}. Every field is optional and every omission keeps what exists: "set_pages" writes only the pages it names and leaves the rest as they are; only "delete_pages" removes a page. An optional "reasoning":"<concise note on what changed and why>" field is recorded as evidence.',
    "An empty object {} keeps the current memory unchanged and is a complete answer.",
  ],
  rationaleLimit: 2_000,
  toolOutputLimit: 24_000,
} as const;

export interface WeeklyReviewSeries {
  index: number;
  week: number;
  seriesId: string;
  entrants: [number, number];
  score: [number, number];
  winner: number | null;
  context: Record<number, string>;
  builds: Record<number, TeamBuildView | undefined>;
  /** Each entrant's roster at the version the series was played under, not its current one. */
  rosters: Record<number, readonly DraftBoardMon[]>;
}

export type ReviewStage = "week" | "transactions";

interface WeeklyReviewStateBase {
  board: DraftBoard;
  models: string[];
  week: number;
  weeks: number;
  rosterVersion: number;
  rosters: DraftBoardMon[][];
  memories: FranchiseMemory[];
  standings: DraftTableRow[];
  series: WeeklyReviewSeries[];
  period: number[];
  schedule: Array<{ index: number; week: number; entrants: [number, number] }>;
  transactions: string[];
  nextWindowWeek: number | null;
  seats?: number[];
}

export type WeeklyReviewState = WeeklyReviewStateBase &
  (
    | { stage: "week"; previousRosters?: never }
    | { stage: "transactions"; previousRosters: DraftBoardMon[][] }
  );

export interface RunWeeklyReviewOptions extends ModelReasoningConfig {
  runDir: string;
  psDir: string;
  concurrency?: number;
  signal?: AbortSignal;
  runAgent: AgentRunner;
  onReview?: (review: WeeklyReview) => void;
}

export interface WeeklyReview {
  entrant: number;
  model: string;
  stage: ReviewStage;
  week: number;
  roster_version: number;
  memory: FranchiseMemory;
  reasoning: string;
}

function storeReviewCheckpoint(runDir: string, review: WeeklyReview): void {
  storeFranchiseCheckpoint(runDir, {
    stage: review.stage,
    week: review.week,
    entrant: review.entrant,
    model: review.model,
    rosterVersion: review.roster_version,
    memory: review.memory,
    reasoning: review.reasoning,
  });
}

function reviewLogDir(runDir: string, week: number, stage: ReviewStage): string {
  return path.join(
    runDir,
    "reviews",
    stage === "week" ? `week-${week}` : `week-${week}-transactions`,
  );
}

export interface ParsedWeeklyReview {
  memory: FranchiseMemory;
  reasoning: string;
}

const memoryPage = z
  .string()
  .max(MEMORY_LIMITS.pageChars, `a page exceeds ${MEMORY_LIMITS.pageChars} characters`);

export const weeklyReviewReplySchema = z.object({
  plan: memoryPage
    .optional()
    .describe("Complete replacement text for your plan page; omit it to keep the current plan."),
  set_pages: z
    .record(z.string(), memoryPage)
    .optional()
    .describe(
      "Named pages to write, each with its complete text. Pages not named are kept as they are.",
    ),
  delete_pages: z.array(z.string()).optional().describe("Names of pages to remove."),
  reasoning: z
    .string()
    .max(WEEKLY_REVIEW_PROMPT_POLICY.rationaleLimit)
    .optional()
    .describe("Why you changed what you changed; recorded, never shown to you again."),
});

export function parseWeeklyReviewResult(
  input: JsonObject,
  current: FranchiseMemory,
): ParsedWeeklyReview {
  const reply = weeklyReviewReplySchema.safeParse(input);
  if (!reply.success) throw new Error(z.prettifyError(reply.error));
  const { reasoning = "", plan, ...pages } = reply.data;
  const memoryReply = plan === undefined ? pages : { ...pages, notebook: plan };
  const parsed = parseMemoryReply(memoryReply, current);
  return {
    memory: parsed.memory,
    reasoning: reasoning.trim(),
  };
}

function windowNotice(state: WeeklyReviewState): string {
  if (state.nextWindowWeek === null) return "Rosters are now locked for the rest of the season.";
  if (state.nextWindowWeek === state.week && state.stage === "week") {
    return "A transaction window opens as soon as this review closes; your plan page is what you take into it.";
  }
  return `The next transaction window opens after week ${state.nextWindowWeek}.`;
}

function systemPrompt(state: WeeklyReviewState, entrant: number): string {
  const template =
    state.stage === "week"
      ? WEEKLY_REVIEW_PROMPT_POLICY.systemTemplate
      : WEEKLY_REVIEW_PROMPT_POLICY.reconcileSystemTemplate;
  return renderPromptTemplate(template, [
    ["model", state.models[entrant]!],
    ["format", state.board.format],
    ["week", String(state.week)],
    ["weeks", String(state.weeks)],
    ["windowNotice", windowNotice(state)],
  ]);
}

function rosterLine(roster: readonly DraftBoardMon[]): string {
  return roster.map((mon) => `${mon.name} (${mon.id}, ${mon.cost})`).join(", ");
}

function resultLine(series: WeeklyReviewSeries, models: readonly string[]): string {
  const [a, b] = series.entrants;
  if (series.winner === null)
    return `${models[a]} drew with ${models[b]} ${series.score[0]}-${series.score[1]}`;
  const loser = series.winner === a ? b : a;
  const [won, lost] = series.winner === a ? series.score : [series.score[1], series.score[0]];
  return `${models[series.winner]} beat ${models[loser]} ${won}-${lost}`;
}

function userPrompt(state: WeeklyReviewState, entrant: number): string {
  const lines: string[] = [
    WEEKLY_REVIEW_PROMPT_POLICY.standingsHeading.replace("{{week}}", String(state.week)),
  ];
  for (const [rank, row] of state.standings.entries()) {
    lines.push(
      `${rank + 1}. entrant ${row.entrant} | ${state.models[row.entrant]} | ${row.w}-${row.l} | ${row.gw}-${row.gl}`,
    );
  }
  if (state.stage === "week") {
    const period = new Set(state.period);
    lines.push("", WEEKLY_REVIEW_PROMPT_POLICY.ownResultsHeading);
    const own = state.series.filter(
      (series) => period.has(series.index) && series.entrants.includes(entrant),
    );
    if (!own.length) lines.push("- (none)");
    for (const series of own) {
      lines.push(
        `- Series ${series.index}, week ${series.week}: ${series.context[entrant] ?? resultLine(series, state.models)}`,
      );
    }
    lines.push("", WEEKLY_REVIEW_PROMPT_POLICY.publicResultsHeading);
    const others = state.series.filter(
      (series) => period.has(series.index) && !series.entrants.includes(entrant),
    );
    if (!others.length) lines.push("- (none)");
    for (const series of others)
      lines.push(
        `- Series ${series.index}, week ${series.week}: ${resultLine(series, state.models)}`,
      );
  }
  lines.push("", WEEKLY_REVIEW_PROMPT_POLICY.scheduleHeading);
  const ahead = state.schedule.filter(
    (plan) => plan.week > state.week && plan.entrants.includes(entrant),
  );
  if (!ahead.length)
    lines.push("- (the round robin is complete; playoffs seed from the standings)");
  for (const plan of ahead) {
    const opponent = plan.entrants[0] === entrant ? plan.entrants[1] : plan.entrants[0];
    lines.push(
      `- Week ${plan.week} | ${state.models[opponent]} | ${rosterLine(state.rosters[opponent]!)}`,
    );
  }
  lines.push("", WEEKLY_REVIEW_PROMPT_POLICY.transactionsHeading);
  if (!state.transactions.length) lines.push("- (none yet)");
  lines.push(...state.transactions);
  if (state.stage === "week") {
    lines.push(
      "",
      `${WEEKLY_REVIEW_PROMPT_POLICY.rosterHeading} ${rosterLine(state.rosters[entrant]!)}`,
    );
  } else {
    lines.push(
      "",
      `${WEEKLY_REVIEW_PROMPT_POLICY.previousRosterHeading} ${rosterLine(state.previousRosters[entrant]!)}`,
      `${WEEKLY_REVIEW_PROMPT_POLICY.currentRosterHeading} ${rosterLine(state.rosters[entrant]!)}`,
    );
  }
  lines.push(
    "",
    ...renderMemory(state.memories[entrant]!),
    "",
    MEMORY_TOOL_NOTICE,
    "",
    ...WEEKLY_REVIEW_PROMPT_POLICY.replyTemplate,
  );
  return lines.join("\n");
}

export function renderWeeklyReviewPrompt(state: WeeklyReviewState, entrant: number): string {
  return [systemPrompt(state, entrant), "", userPrompt(state, entrant)].join("\n");
}

function boundedToolOutput(text: string, offset = 0): string {
  const limit = WEEKLY_REVIEW_PROMPT_POLICY.toolOutputLimit;
  const end = offset + limit;
  const page = text.slice(offset, end);
  return text.length > end
    ? `${page}\n[More available: repeat this query with offset ${end}.]`
    : page;
}

export function narratePublicSeries(
  runDir: string,
  series: WeeklyReviewSeries,
  models: readonly string[],
  offset = 0,
): string {
  const [a, b] = series.entrants;
  const names = { P1: models[a]!, P2: models[b]! } satisfies Record<"P1" | "P2", string>;
  const lines: string[] = [
    `Series ${series.index}, week ${series.week}: ${resultLine(series, models)}.`,
  ];
  for (const [gameIndex, gameLines] of readCompletedSeriesGameLogs(
    runDir,
    series.seriesId,
  ).entries()) {
    const log = new BattleLog(Number.POSITIVE_INFINITY);
    log.feed(gameLines);
    lines.push("", `Game ${gameIndex + 1}:`);
    for (const entry of log.entries) {
      lines.push(
        `${entry.turn ? `T${entry.turn} ` : ""}${entry.text.replace(
          /\bP[12]\b/g,
          (seatName: string) => (seatName === "P1" ? names.P1 : names.P2),
        )}`,
      );
    }
  }
  return boundedToolOutput(lines.join("\n"), offset);
}

export function narrateOwnSeries(
  runDir: string,
  series: WeeklyReviewSeries,
  entrant: number,
  offset = 0,
): string {
  const pid = series.entrants[0] === entrant ? "p1" : "p2";
  const rows = readCompletedSeriesDecisionRows(runDir, series.seriesId, pid);
  const lines: string[] = [`Series ${series.index}, week ${series.week}, your seat ${pid}.`];
  let game = -1;
  for (const row of rows) {
    const gameNumber = count(row.game_number, -1);
    if (gameNumber !== game) {
      game = gameNumber;
      lines.push("", `Game ${game}:`);
    }
    if (row.kind === "decision") {
      const rationale = z.string().safeParse(row.rationale);
      const why = rationale.success && rationale.data ? ` — ${rationale.data}` : "";
      const action = text(row.action);
      lines.push(
        `${row.phase === "team_preview" ? "Preview" : `T${count(row.turn)}`}: ${action}${why}`,
      );
    } else if (row.kind === "game_reflection") {
      const adjustment = text(row.adjustment);
      lines.push(
        `After the game (${text(row.result)}): ${text(row.summary)}${adjustment ? ` Adjustment: ${adjustment}` : ""}`,
      );
    }
  }
  if (series.context[entrant]) lines.push("", `Series note: ${series.context[entrant]}`);
  return boundedToolOutput(lines.join("\n"), offset);
}

export function describeOwnBuild(
  series: WeeklyReviewSeries,
  entrant: number,
  usage: readonly GameSummary[] = [],
  offset = 0,
): string {
  const build = series.builds[entrant];
  if (!build) return `No stored build for series ${series.index}.`;
  const roster = series.rosters[entrant] ?? [];
  const displayName = new Map(roster.map((mon) => [mon.id, mon.name]));
  const registered = new Set(build.brought);
  const lines = [
    `Series ${series.index}, week ${series.week}. Plan: ${build.rationale || "(none)"}`,
  ];
  for (const set of build.sets) {
    const investment = Object.entries(set.evs)
      .filter(([, value]) => Number(value) > 0)
      .map(([stat, value]) => `${stat} ${value}`)
      .join("/");
    lines.push(
      `- ${set.species} @ ${set.item}; ${set.ability}; ${set.nature}; ${set.moves.join("/")}; ${investment || "0 investment"}`,
    );
  }
  const left = roster.filter(
    (mon) => !registered.has(mon.id) && build.sets.every((set) => set.species !== mon.name),
  );
  if (left.length) lines.push(`Left behind: ${left.map((mon) => mon.name).join(", ")}`);
  const side = series.entrants[0] === entrant ? 0 : 1;
  const name = (id: string) => displayName.get(id) ?? id;
  for (const [index, game] of usage.entries()) {
    const brought = game.brought[side].map(name).join(", ") || "(none)";
    const megaId = game.megaEvolved[side];
    const fainted = Object.keys(game.faints[side]).map(name).join(", ") || "none";
    lines.push(
      `Game ${index + 1}: brought ${brought}; Mega Evolved ${megaId ? name(megaId) : "none"}; fainted ${fainted}`,
    );
  }
  return boundedToolOutput(lines.join("\n"), offset);
}

function reviewTools(
  state: WeeklyReviewState,
  entrant: number,
  options: RunWeeklyReviewOptions,
): AgentTool[] {
  const completed = new Map(state.series.map((series) => [series.index, series] as const));
  const seriesIndex = z.object({
    series_index: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative().default(0),
  });
  const seriesParameters: JsonObject = {
    type: "object",
    properties: {
      series_index: { type: "integer", minimum: 0 },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Character offset for a continuation page; defaults to 0.",
      },
    },
    required: ["series_index"],
    additionalProperties: false,
  };
  const seriesTool = (
    name: string,
    description: string,
    run: (seriesIndex: number, offset: number) => string,
  ): AgentTool => ({
    definition: { name, description, parameters: seriesParameters },
    run: (args) => {
      const query = seriesIndex.parse(args);
      return run(query.series_index, query.offset);
    },
  });
  return [
    seriesTool(
      "read_public_series",
      "The spectator log of one completed series this season: registrations, leads, every turn, and the result.",
      (index, offset) => {
        const series = completed.get(index);
        return series
          ? narratePublicSeries(options.runDir, series, state.models, offset)
          : `Series ${index} has not been completed yet or does not exist.`;
      },
    ),
    seriesTool(
      "read_own_series",
      "Your own choices in one of your completed series, with the reasons you gave at the time and your end-of-game notes.",
      (index, offset) => {
        const series = completed.get(index);
        return series?.entrants.includes(entrant)
          ? narrateOwnSeries(options.runDir, series, entrant, offset)
          : `Series ${index} is not one of your completed series.`;
      },
    ),
    seriesTool(
      "read_own_build",
      "The six you registered for one of your completed series, the plan you wrote for it, and what you brought, Mega Evolved, and lost in each game.",
      (index, offset) => {
        const series = completed.get(index);
        if (!series?.entrants.includes(entrant)) {
          return `Series ${index} is not one of your completed series.`;
        }
        const first = series.builds[series.entrants[0]];
        const second = series.builds[series.entrants[1]];
        return describeOwnBuild(
          series,
          entrant,
          seriesGameSummaries(options.runDir, series.seriesId, state.board.mons, [first, second]),
          offset,
        );
      },
    ),
    {
      definition: {
        name: "read_memory_page",
        description: READ_MEMORY_PAGE.description,
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      run: (args) =>
        readMemoryPage(state.memories[entrant]!, z.object({ name: z.string() }).parse(args)),
    },
    {
      definition: {
        name: "read_memory_history",
        description:
          'Your memory as it stood after an earlier barrier, page names included: stage "week" is the weekly review, stage "transactions" is the reconciliation after that week\'s transaction window.',
        parameters: {
          type: "object",
          properties: {
            week: { type: "integer", minimum: 1 },
            stage: { type: "string", enum: ["week", "transactions"] },
          },
          required: ["week"],
          additionalProperties: false,
        },
      },
      run: (args) => {
        const { week, stage } = z
          .object({
            week: z.number().int().positive(),
            stage: z.enum(["week", "transactions"]).default("week"),
          })
          .parse(args);
        const precedes =
          week < state.week ||
          (week === state.week && stage === "week" && state.stage === "transactions");
        const row = precedes
          ? readFranchiseCheckpoints(options.runDir, stage, week).find(
              (candidate) => candidate.entrant === entrant,
            )
          : undefined;
        if (!row) {
          return `You have no stored ${stage === "week" ? "review" : "reconciliation"} for week ${week}. Stored barriers: ${
            storedBarriers(options.runDir, state, entrant).join(", ") || "none"
          }.`;
        }
        return renderMemory(row.memory, "full").join("\n");
      },
    },
  ];
}

function storedBarriers(runDir: string, state: WeeklyReviewState, entrant: number): string[] {
  const barriers: string[] = [];
  const checkpoints = readFranchiseCheckpoints(runDir);
  for (let week = 1; week <= state.week; week += 1) {
    for (const stage of ["week", "transactions"] as const) {
      if (week === state.week && (stage === "transactions" || state.stage === "week")) continue;
      if (
        checkpoints.some(
          (row) => row.week === week && row.stage === stage && row.entrant === entrant,
        )
      ) {
        barriers.push(`week ${week} ${stage}`);
      }
    }
  }
  return barriers;
}

export function readWeeklyReviews(
  runDir: string,
  week: number,
  stage: ReviewStage = "week",
): WeeklyReview[] {
  return readFranchiseCheckpoints(runDir, stage, week).map((checkpoint) => ({
    entrant: checkpoint.entrant,
    model: checkpoint.model,
    stage,
    week: checkpoint.week,
    roster_version: checkpoint.rosterVersion,
    memory: checkpoint.memory,
    reasoning: checkpoint.reasoning,
  }));
}

export async function runWeeklyReview(
  state: WeeklyReviewState,
  options: RunWeeklyReviewOptions,
): Promise<WeeklyReview[]> {
  const logDir = reviewLogDir(options.runDir, state.week, state.stage);
  const reviews = readWeeklyReviews(options.runDir, state.week, state.stage);
  for (const review of reviews) {
    if (
      review.roster_version !== state.rosterVersion ||
      review.entrant >= state.models.length ||
      review.model !== state.models[review.entrant]
    ) {
      throw new Error(
        `stored ${state.stage} review for week ${review.week} has roster version ${review.roster_version} for entrant ${review.entrant}`,
      );
    }
    state.memories[review.entrant] = cloneMemory(review.memory);
  }
  const pending = (state.seats ?? state.models.map((_, entrant) => entrant)).filter(
    (entrant) => !reviews.some((r) => r.entrant === entrant),
  );
  const byEntrant = (a: WeeklyReview, b: WeeklyReview) => a.entrant - b.entrant;
  if (!pending.length) return reviews.sort(byEntrant);
  fs.mkdirSync(logDir, { recursive: true });

  const fresh = await mapLimit(
    pending,
    options.concurrency ?? pending.length,
    options.signal,
    async (entrant, signal) => {
      signal.throwIfAborted();
      const model = state.models[entrant]!;
      const current = cloneMemory(state.memories[entrant]!);
      let parsedReview: ParsedWeeklyReview | undefined;
      if (model !== "random") {
        const seatLog = path.join(logDir, `seat-${entrant}-${fileSlug(model)}.jsonl`);
        const reference = new ShowdownReference(state.board.format, options.psDir);
        const boardSearch = createBoardSearch(state.board, options.psDir);
        const result = await runStage({
          session: `review-${state.stage}-${state.week}-${entrant}`,
          task: `review-${state.stage}-${state.week}-${entrant}`,
          model,
          reasoning: reasoningForModel(model, options),
          system: systemPrompt(state, entrant),
          prompt: userPrompt(state, entrant),
          tools: reviewReferenceTools(reference, boardSearch, reviewTools(state, entrant, options)),
          submission: submissionTool("submit_review", weeklyReviewReplySchema),
          validate: (input) => parseWeeklyReviewResult(input, current),
          runner: options.runAgent,
          logFile: seatLog,
          signal,
        });
        parsedReview = result.value;
      }
      parsedReview ??= { memory: current, reasoning: "" };
      const review: WeeklyReview = {
        entrant,
        model,
        stage: state.stage,
        week: state.week,
        roster_version: state.rosterVersion,
        memory: parsedReview.memory,
        reasoning: parsedReview.reasoning,
      };
      storeReviewCheckpoint(options.runDir, review);
      state.memories[entrant] = cloneMemory(review.memory);
      options.onReview?.(review);
      return review;
    },
  );
  reviews.push(...fresh);
  return reviews.sort(byEntrant);
}
