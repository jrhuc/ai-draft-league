import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { createBoardSearch } from "./board-search.js";
import { completeWithDexTools, type ExtraTool } from "./dex-lookups.js";
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
import type { DraftTableRow, TeambuildView } from "./views.js";
import { BattleLog } from "./battlelog.js";
import { appendJsonlObject, readJsonlObjects } from "./jsonl.js";
import { FORMAT_AUTHORITY_NOTICE, MANAGER_CHARGE, renderPromptTemplate } from "./prompts.js";
import type { ModelReasoningConfig, ReasoningLevel } from "./providers.js";
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
} from "./providers.js";
import { ShowdownReference } from "./reference.js";
import {
  mapLimit,
  readCompletedSeriesDecisionRows,
  readCompletedSeriesGameLogs,
} from "./series.js";
import type { JsonObject, JsonValue, Provider, ProviderMessage } from "./types.js";
import { fileSlug } from "./value.js";
import { clip, count, isRecord, isText, text } from "./value.js";

const MEMORY_NOTICE = `- Your memory is yours to organise: a notebook page that every later prompt of yours shows in full, plus up to ${MEMORY_LIMITS.pages - 1} named pages that later prompts list by name and that you or your later selves fetch with read_memory_page. Each page holds at most ${MEMORY_LIMITS.pageChars} characters, ${MEMORY_LIMITS.totalChars} in all. It is the only state that carries from week to week; nothing else you write here is kept.`;

const LEAGUE_TOOLS_NOTICE =
  "You have the Showdown dex tools and five league tools: read_public_series returns the spectator log of any completed series, read_own_series returns your own turn-by-turn choices with their stated reasons and your end-of-game notes, read_own_build returns the six you registered for a series, your plan, and what you brought and Mega Evolved in each game, read_memory_page returns one of your pages in full, and read_memory_history returns your memory as it stood after an earlier review or reconciliation.";

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
    `${LEAGUE_TOOLS_NOTICE} Use them to check anything you intend to write down.`,
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
    'Reply with one JSON object {"notebook":"<complete replacement notebook>","set_pages":{"<name>":"<complete page text>",...},"delete_pages":["<name>",...]}. Every field is optional and every omission keeps what exists: "set_pages" writes only the pages it names and leaves the rest as they are; only "delete_pages" removes a page. An optional "reasoning":"<concise note on what changed and why>" field is recorded as evidence.',
    "An empty object {} keeps the current memory unchanged and is a complete answer.",
  ],
  rejectionTemplate: "That review was rejected: {{error}} Reply again with only the JSON object.",
  truncatedTemplate:
    "Your previous reply used the whole {{budget}}-token budget before completing the JSON object. Reply now with only the JSON object.",
  rationaleLimit: 2_000,
  toolOutputLimit: 24_000,
  maxTokens: 32_768,
  attempts: 3,
  toolRounds: 8,
  maxCallsPerRound: 6,
} as const;

export interface WeeklyReviewSeries {
  index: number;
  week: number;
  seriesId: string;
  entrants: [number, number];
  score: [number, number];
  winner: number | null;
  context: Record<number, string>;
  builds: Record<number, TeambuildView | undefined>;
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
  apiKeys?: Readonly<Record<string, string>>;
  makeReviewProvider?: (
    spec: string,
    apiKey: string | undefined,
    reasoning: ReasoningLevel | undefined,
  ) => Provider;
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
  fallback: boolean;
}

interface ReviewSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

export function reviewArtifactPaths(runDir: string, week: number, stage: ReviewStage = "week") {
  const name = stage === "week" ? `week-${week}` : `week-${week}-transactions`;
  return {
    transcript: path.join(runDir, "reviews", `${name}.jsonl`),
    logDir: path.join(runDir, "reviews", name),
  };
}

export interface ParsedWeeklyReview {
  memory: FranchiseMemory;
  reasoning: string;
}

type ParsedWeeklyReviewResult = { value: ParsedWeeklyReview } | { error: string };

function parseWeeklyReviewResult(
  response: string,
  current: FranchiseMemory,
): ParsedWeeklyReviewResult {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return { error: "the reply contained no JSON object" };
  let object: JsonValue;
  try {
    object = JSON.parse(match[0]);
  } catch {
    return { error: "the JSON object did not parse" };
  }
  if (!isRecord(object)) return { error: "the reply must be one JSON object" };
  const reasoning = object.reasoning;
  if (reasoning !== undefined && !isText(reasoning))
    return { error: '"reasoning" must be a string' };
  const reply = parseMemoryReply(object, current);
  if (!(reply instanceof Object)) return { error: reply };
  return {
    value: {
      memory: reply.memory,
      reasoning: clip((reasoning ?? "").trim(), WEEKLY_REVIEW_PROMPT_POLICY.rationaleLimit),
    },
  };
}

export function parseWeeklyReview(
  response: string,
  current: FranchiseMemory,
): ParsedWeeklyReview | string {
  const result = parseWeeklyReviewResult(response, current);
  return "error" in result ? result.error : result.value;
}

function windowNotice(state: WeeklyReviewState): string {
  if (state.nextWindowWeek === null) return "Rosters are now locked for the rest of the season.";
  if (state.nextWindowWeek === state.week && state.stage === "week") {
    return "A transaction window opens as soon as this review closes; your notebook is what you take into it.";
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

function boundedToolOutput(text: string): string {
  const limit = WEEKLY_REVIEW_PROMPT_POLICY.toolOutputLimit;
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated at ${limit} characters]` : text;
}

export function narratePublicSeries(
  runDir: string,
  series: WeeklyReviewSeries,
  models: readonly string[],
): string {
  const [a, b] = series.entrants;
  const names = { P1: models[a]!, P2: models[b]! } satisfies Record<"P1" | "P2", string>;
  const lines: string[] = [
    `Series ${series.index}, week ${series.week}: ${resultLine(series, models)}.`,
  ];
  for (const [gameIndex, gameLines] of readCompletedSeriesGameLogs(
    path.join(runDir, "series", series.seriesId),
    series.seriesId,
  ).entries()) {
    const log = new BattleLog(1_000);
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
  return boundedToolOutput(lines.join("\n"));
}

export function narrateOwnSeries(
  runDir: string,
  series: WeeklyReviewSeries,
  entrant: number,
): string {
  const pid = series.entrants[0] === entrant ? "p1" : "p2";
  const seriesDir = path.join(runDir, "series", series.seriesId);
  const rows = readCompletedSeriesDecisionRows(seriesDir, series.seriesId, pid);
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
  return boundedToolOutput(lines.join("\n"));
}

export function describeOwnBuild(
  series: WeeklyReviewSeries,
  entrant: number,
  usage: readonly GameSummary[] = [],
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
  for (const [index, game] of usage.entries()) {
    const brought =
      game.brought[side].map((id) => displayName.get(id) ?? id).join(", ") || "(none)";
    const megaId = game.megaEvolved[side];
    const mega = megaId ? (displayName.get(megaId) ?? megaId) : "none";
    lines.push(`Game ${index + 1}: brought ${brought}; Mega Evolved ${mega}`);
  }
  return boundedToolOutput(lines.join("\n"));
}

function reviewTools(
  state: WeeklyReviewState,
  entrant: number,
  options: RunWeeklyReviewOptions,
): ExtraTool[] {
  const completed = new Map(state.series.map((series) => [series.index, series] as const));
  const seriesIndex = z.object({ series_index: z.number().int().nonnegative() });
  const seriesParameters: JsonObject = {
    type: "object",
    properties: { series_index: { type: "integer", minimum: 0 } },
    required: ["series_index"],
    additionalProperties: false,
  };
  const seriesTool = (
    name: string,
    description: string,
    run: (seriesIndex: number) => string,
  ): ExtraTool => ({
    definition: { name, description, parameters: seriesParameters },
    run: (args) => run(seriesIndex.parse(args).series_index),
  });
  return [
    seriesTool(
      "read_public_series",
      "The spectator log of one completed series this season: registrations, leads, every turn, and the result.",
      (index) => {
        const series = completed.get(index);
        return series
          ? narratePublicSeries(options.runDir, series, state.models)
          : `Series ${index} has not been completed yet or does not exist.`;
      },
    ),
    seriesTool(
      "read_own_series",
      "Your own choices in one of your completed series, with the reasons you gave at the time and your end-of-game notes.",
      (index) => {
        const series = completed.get(index);
        return series?.entrants.includes(entrant)
          ? narrateOwnSeries(options.runDir, series, entrant)
          : `Series ${index} is not one of your completed series.`;
      },
    ),
    seriesTool(
      "read_own_build",
      "The six you registered for one of your completed series and the plan you wrote for it.",
      (index) => {
        const series = completed.get(index);
        if (!series?.entrants.includes(entrant)) {
          return `Series ${index} is not one of your completed series.`;
        }
        const first = series.builds[series.entrants[0]];
        const second = series.builds[series.entrants[1]];
        return describeOwnBuild(
          series,
          entrant,
          seriesGameSummaries(
            path.join(options.runDir, "series", series.seriesId),
            series.seriesId,
            state.board.mons,
            [first, second],
          ),
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
          ? readWeeklyReviews(options.runDir, week, stage).find(
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
  for (let week = 1; week <= state.week; week += 1) {
    for (const stage of ["week", "transactions"] as const) {
      if (week === state.week && (stage === "transactions" || state.stage === "week")) continue;
      if (readWeeklyReviews(runDir, week, stage).some((row) => row.entrant === entrant)) {
        barriers.push(`week ${week} ${stage}`);
      }
    }
  }
  return barriers;
}

const weeklyReviewRowSchema = z
  .object({
    timestamp: z.string().optional(),
    entrant: z.number().int().nonnegative(),
    model: z.string(),
    stage: z.enum(["week", "transactions"]),
    week: z.number().int(),
    roster_version: z.number().int(),
    memory: z.record(z.string(), z.string()),
    reasoning: z.string(),
    fallback: z.boolean(),
  })
  .passthrough();

function replayReviews(file: string): WeeklyReview[] {
  const seen = new Set<number>();
  return readJsonlObjects(file).map((row, index) => {
    const parsed = weeklyReviewRowSchema.safeParse(row);
    if (!parsed.success) throw new Error(`invalid weekly review row ${index + 1} in ${file}`);
    const { timestamp: _timestamp, ...review } = parsed.data;
    if (seen.has(review.entrant)) {
      throw new Error(`${file} holds a second review for entrant ${String(review.entrant)}`);
    }
    seen.add(review.entrant);
    return review;
  });
}

export function readWeeklyReviews(
  runDir: string,
  week: number,
  stage: ReviewStage = "week",
): WeeklyReview[] {
  const { transcript } = reviewArtifactPaths(runDir, week, stage);
  const reviews = replayReviews(transcript);
  const misplaced = reviews.find((review) => review.week !== week || review.stage !== stage);
  if (misplaced)
    throw new Error(`${transcript} holds a review for week ${misplaced.week} ${misplaced.stage}`);
  return reviews;
}

export async function runWeeklyReview(
  state: WeeklyReviewState,
  options: RunWeeklyReviewOptions,
): Promise<WeeklyReview[]> {
  const { transcript, logDir } = reviewArtifactPaths(options.runDir, state.week, state.stage);
  const reviews = replayReviews(transcript);
  for (const review of reviews) {
    if (
      review.stage !== state.stage ||
      review.week !== state.week ||
      review.roster_version !== state.rosterVersion ||
      review.entrant >= state.models.length ||
      review.model !== state.models[review.entrant]
    ) {
      throw new Error(
        `${transcript} holds a review for week ${review.week}, roster version ${review.roster_version}, entrant ${review.entrant}`,
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
      const make =
        options.makeReviewProvider ??
        ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) =>
          makeProvider(parseSpec(spec), { apiKey, reasoning }));
      const provider =
        model === "random"
          ? undefined
          : make(model, options.apiKeys?.[model], reasoningForModel(model, options));
      let parsedReview: ParsedWeeklyReview | undefined;
      let fallback = false;
      if (provider) {
        const system = systemPrompt(state, entrant);
        const messages: ProviderMessage[] = [{ role: "user", content: userPrompt(state, entrant) }];
        const seatLog = path.join(logDir, `seat-${entrant}-${fileSlug(model)}.jsonl`);
        const reference = new ShowdownReference(state.board.format, options.psDir);
        const boardSearch = createBoardSearch(state.board, options.psDir);
        const extraTools = reviewTools(state, entrant, options);
        for (
          let attempt = 1;
          attempt <= WEEKLY_REVIEW_PROMPT_POLICY.attempts && !parsedReview;
          attempt += 1
        ) {
          const promptForAttempt = messages[messages.length - 1]!.content ?? "";
          let response = "";
          let usage: Record<string, number> | undefined;
          let error: string | undefined;
          let terminalError: Error | undefined;
          const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
          try {
            const completion = await completeWithDexTools({
              provider,
              system,
              messages,
              spec: model,
              reference,
              boardSearch,
              extraTools,
              policy: WEEKLY_REVIEW_PROMPT_POLICY,
              signal,
              onLookup: (call) => lookups.push(call),
            });
            response = completion.text;
            usage = completion.usage;
            const truncated = completion.outputLimitReached || completion.finishReason === "length";
            const candidate = truncated
              ? { error: "the reply was cut off before completing the JSON object" }
              : parseWeeklyReviewResult(response, current);
            if ("error" in candidate) {
              error = candidate.error;
              messages.push({
                role: "assistant",
                content: response || "[the reply contained no visible text]",
              });
              messages.push({
                role: "user",
                content: truncated
                  ? WEEKLY_REVIEW_PROMPT_POLICY.truncatedTemplate.replace(
                      "{{budget}}",
                      String(WEEKLY_REVIEW_PROMPT_POLICY.maxTokens),
                    )
                  : WEEKLY_REVIEW_PROMPT_POLICY.rejectionTemplate.replace(
                      "{{error}}",
                      candidate.error,
                    ),
              });
            } else {
              parsedReview = candidate.value;
            }
          } catch (cause) {
            const failure = classifyProviderFailure(cause, model);
            error = failure.summary;
            terminalError = new Error(`${failure.summary} The weekly review cannot continue.`, {
              cause,
            });
          }
          const completeLogRow = {
            attempt,
            system: attempt === 1 ? system : undefined,
            user: promptForAttempt,
            response,
            usage,
            tool_lookups: lookups.length ? lookups : undefined,
            error: error || undefined,
          } satisfies ReviewSeatLog;
          fs.appendFileSync(seatLog, `${JSON.stringify(completeLogRow)}\n`, "utf8");
          if (terminalError) throw terminalError;
        }
        fallback = parsedReview === undefined;
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
        fallback,
      };
      appendJsonlObject(transcript, { ...review, timestamp: new Date().toISOString() });
      state.memories[entrant] = cloneMemory(review.memory);
      options.onReview?.(review);
      return review;
    },
  );
  reviews.push(...fresh);
  return reviews.sort(byEntrant);
}
