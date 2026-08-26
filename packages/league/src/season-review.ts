import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { completeWithDexTools } from "./dex-lookups.js";
import type { DraftBoard, DraftBoardMon } from "./draft.js";
import type { DraftPickView, DraftTableRow } from "./views.js";
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
import { mapLimit } from "./series.js";
import type { TradeWindowArtifact } from "./trade-window.js";
import type { JsonObject, Provider, ProviderMessage } from "./types.js";
import { clip, fileSlug, replyJsonObject } from "./value.js";

const SEASON_REVIEW_PROMPT_POLICY = {
  systemTemplate: [
    "You are {{model}}, manager of a franchise in a Pokémon VGC draft league played in the format {{format}}.",
    MANAGER_CHARGE,
    "Your season is over.",
    FORMAT_AUTHORITY_NOTICE,
    "",
    "This is a retrospective, not a decision. Nothing you write changes a result; it is published on your team page.",
    "- Judge the whole season: the roster you drafted, what you did with coach trades and free agency, the six you registered for each series, and how you piloted them.",
    "- Say which of those three a result belongs to. A series lost to a hole no registration could cover is a draft or window result, not a piloting one, and the reverse also holds.",
    "- Name the specific picks, trades, swaps, and games that decided your season. General principles about VGC are not an answer.",
    "- Credit what you got right as plainly as what you got wrong. A season that went well still had weak spots, and a season that went badly still had sound calls.",
    "- Keeping a roster unchanged at the window was a decision like any other; judge it as one.",
    "",
    "You have the same Showdown dex tools as during the draft. Use them only to check a fact you intend to state.",
  ],
  outcomeHeading: "HOW YOUR SEASON ENDED:",
  standingsHeading: "FINAL LEAGUE STANDINGS (rank | coach | W-L | games):",
  draftHeading: "YOUR DRAFT (pick | name | cost | your reasoning at the time):",
  windowHeading: "YOUR TRANSACTION WINDOWS:",
  rosterHeading: "YOUR FINAL ROSTER:",
  seasonHeading: "YOUR SERIES, IN ORDER:",
  wordsHeading: "YOUR PRIVATE WORDS:",
  replyTemplate: [
    'Reply with one JSON object {"summary":"<1-2 sentences on how the season went>","did_well":"<2-4 sentences>","did_poorly":"<2-4 sentences>","would_change":"<2-4 sentences, each one concrete>"}.',
  ],
  rejectionTemplate: "That review was rejected: {{error}} Reply again with only the JSON object.",
  truncatedTemplate:
    "Your previous reply used the whole {{budget}}-token budget before completing the JSON object. Reply now with only the JSON object.",
  fieldLimit: 2_000,
  maxTokens: 32_768,
  attempts: 3,
  toolRounds: 6,
  maxCallsPerRound: 6,
} as const;

export interface SeasonReview {
  entrant: number;
  model: string;
  outcome: string;
  summary: string;
  did_well: string;
  did_poorly: string;
  would_change: string;
  fallback: boolean;
}

export interface SeasonReviewState {
  board: DraftBoard;
  models: string[];
  picks: DraftPickView[];
  rosters: DraftBoardMon[][];
  windows: TradeWindowArtifact[];
  standings: DraftTableRow[];
  series: string[][];
  notebooks: string[];
}

export interface RunSeasonReviewOptions extends ModelReasoningConfig {
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
  onReview?: (review: SeasonReview) => void;
}

interface ParsedSeasonReview {
  summary: string;
  did_well: string;
  did_poorly: string;
  would_change: string;
}

type ParsedSeasonReviewResult = { value: ParsedSeasonReview } | { error: string };

interface SeasonSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

const reviewField = z
  .string()
  .trim()
  .min(1)
  .transform((value) => clip(value, SEASON_REVIEW_PROMPT_POLICY.fieldLimit));
const seasonReviewReplySchema = z.looseObject({
  summary: reviewField,
  did_well: reviewField,
  did_poorly: reviewField,
  would_change: reviewField,
});

function parseSeasonReviewResult(response: string): ParsedSeasonReviewResult {
  const json = replyJsonObject(response);
  if (typeof json === "string") return { error: json };
  const parsed = seasonReviewReplySchema.safeParse(json);
  if (!parsed.success)
    return { error: `"${String(parsed.error.issues[0]?.path[0])}" must be a non-empty string` };
  return { value: parsed.data };
}

export function parseSeasonReview(response: string): ParsedSeasonReview | string {
  const result = parseSeasonReviewResult(response);
  return "error" in result ? result.error : result.value;
}

function systemPrompt(state: SeasonReviewState, entrant: number): string {
  return renderPromptTemplate(SEASON_REVIEW_PROMPT_POLICY.systemTemplate, [
    ["model", state.models[entrant]!],
    ["format", state.board.format],
  ]);
}

function userPrompt(state: SeasonReviewState, entrant: number, outcome: string): string {
  const byId = new Map(state.board.mons.map((mon) => [mon.id, mon] as const));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const lines: string[] = [
    SEASON_REVIEW_PROMPT_POLICY.outcomeHeading,
    outcome,
    "",
    SEASON_REVIEW_PROMPT_POLICY.standingsHeading,
  ];
  for (const [rank, row] of state.standings.entries()) {
    lines.push(
      `${rank + 1}. ${state.models[row.entrant]} | ${row.w}-${row.l} | ${row.gw}-${row.gl}`,
    );
  }

  lines.push("", SEASON_REVIEW_PROMPT_POLICY.draftHeading);
  const own = state.picks
    .filter((pick) => pick.entrant === entrant)
    .sort((a, b) => a.pick - b.pick);
  if (!own.length) lines.push("- (no stored draft)");
  for (const pick of own) {
    const mon = byId.get(pick.mon);
    lines.push(
      `- Pick ${pick.pick}: ${mon?.name ?? pick.mon} (${mon?.cost ?? "?"} pts)${pick.fallback ? " [fallback pick]" : ""} — ${pick.rationale || "(no stored reasoning)"}`,
    );
  }

  lines.push("", SEASON_REVIEW_PROMPT_POLICY.windowHeading);
  if (!state.windows.length) {
    lines.push("- This league locked rosters after the draft; there was no transaction window.");
  }
  for (const window of state.windows) {
    const decision = window.decisions.find((entry) => entry.entrant === entrant);
    lines.push(
      `- A window opened after week ${window.after_week}, with coaches choosing in inverse standings order.`,
    );
    for (const offer of window.offers) {
      if (offer.from === entrant) {
        if (offer.to === null || offer.give === null || offer.get === null) {
          lines.push(
            `- You made no coach-trade offer. Your reasoning: ${offer.offerReasoning || "(none recorded)"}`,
          );
        } else {
          const team = state.models[offer.to];
          lines.push(
            `- You offered ${name(offer.give)} for ${name(offer.get)} from ${team}; ${offer.accepted ? "accepted" : "declined"}. ` +
              `Your message: ${offer.message || "(none recorded)"}. Your reasoning: ${offer.offerReasoning || "(none recorded)"}`,
          );
        }
      } else if (offer.to === entrant && offer.give !== null && offer.get !== null) {
        const team = state.models[offer.from];
        lines.push(
          `- ${team} offered you ${name(offer.give)} for ${name(offer.get)}; you ${offer.accepted ? "accepted" : "declined"}. ` +
            `Its message: ${offer.message || "(none recorded)"}. Your response reasoning: ${offer.responseReasoning || "(none recorded)"}`,
        );
      }
    }
    if (!decision) lines.push("- (no stored decision)");
    else {
      lines.push(
        decision.swaps.length
          ? `- You made ${decision.swaps.length} swap${decision.swaps.length === 1 ? "" : "s"}: ${decision.swaps
              .map((swap) => `dropped ${name(swap.drop)} for ${name(swap.add)}`)
              .join("; ")}.`
          : "- You made no swaps and kept the roster you drafted.",
      );
      lines.push(`- Your reasoning at the time: ${decision.reasoning || "(none recorded)"}`);
    }
    for (const other of window.decisions) {
      if (other.entrant === entrant) continue;
      const team = state.models[other.entrant];
      lines.push(
        other.swaps.length
          ? `- ${team}: ${other.swaps.map((swap) => `-${name(swap.drop)} +${name(swap.add)}`).join(", ")}`
          : `- ${team}: kept its roster`,
      );
    }
  }

  lines.push(
    "",
    `${SEASON_REVIEW_PROMPT_POLICY.rosterHeading} ${state.rosters[entrant]!.map((mon) => `${mon.name} (${mon.cost})`).join(", ")}`,
  );

  lines.push("", SEASON_REVIEW_PROMPT_POLICY.seasonHeading);
  const series = state.series[entrant] ?? [];
  if (!series.length) lines.push("- (none recorded)");
  for (const entry of series) lines.push(`- ${entry}`);

  lines.push(
    "",
    SEASON_REVIEW_PROMPT_POLICY.wordsHeading,
    "- Your final memory follows.",
    "",
    state.notebooks[entrant] || "(empty)",
    "",
    ...SEASON_REVIEW_PROMPT_POLICY.replyTemplate,
  );
  return lines.join("\n");
}

/** Reviews already written are replayed rather than re-bought, so a resumed league never pays twice for a
 * retrospective whose season is already closed. */
const seasonReviewRowSchema = z
  .object({
    timestamp: z.string().optional(),
    entrant: z.number().int().nonnegative(),
    model: z.string(),
    outcome: z.string(),
    summary: z.string(),
    did_well: z.string(),
    did_poorly: z.string(),
    would_change: z.string(),
    fallback: z.boolean(),
  })
  .passthrough();

function replayReviews(file: string): SeasonReview[] {
  return readJsonlObjects(file).map((row, index) => {
    const parsed = seasonReviewRowSchema.safeParse(row);
    if (!parsed.success) throw new Error(`invalid season review row ${index + 1} in ${file}`);
    const { timestamp: _timestamp, ...review } = parsed.data;
    return review;
  });
}

export async function runSeasonReview(
  finished: ReadonlyArray<{ entrant: number; outcome: string }>,
  state: SeasonReviewState,
  options: RunSeasonReviewOptions,
): Promise<SeasonReview[]> {
  const transcript = path.join(options.runDir, "season.jsonl");
  const logDir = path.join(options.runDir, "season");
  const reviews = replayReviews(transcript);
  const pending = finished.filter(
    (entry) => !reviews.some((review) => review.entrant === entry.entrant),
  );
  if (!pending.length) return reviews;
  fs.mkdirSync(logDir, { recursive: true });
  const reference = new ShowdownReference(state.board.format, options.psDir);

  const fresh = await mapLimit(
    pending,
    options.concurrency ?? pending.length,
    options.signal,
    async (entry, signal) => {
      const { entrant, outcome } = entry;
      signal.throwIfAborted();
      const model = state.models[entrant]!;
      const make =
        options.makeReviewProvider ??
        ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) =>
          makeProvider(parseSpec(spec), { apiKey, reasoning }));
      const provider =
        model === "random"
          ? undefined
          : make(model, options.apiKeys?.[model], reasoningForModel(model, options));
      let parsed: ParsedSeasonReview | undefined;
      let fallback = false;
      let lastError = "";
      const system = systemPrompt(state, entrant);
      if (provider) {
        const messages: ProviderMessage[] = [
          { role: "user", content: userPrompt(state, entrant, outcome) },
        ];
        const seatLog = path.join(logDir, `seat-${entrant}-${fileSlug(model)}.jsonl`);
        for (
          let attempt = 1;
          attempt <= SEASON_REVIEW_PROMPT_POLICY.attempts && !parsed;
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
              policy: SEASON_REVIEW_PROMPT_POLICY,
              signal,
              onLookup: (call) => lookups.push(call),
            });
            response = completion.text;
            usage = completion.usage;
            const candidate = parseSeasonReviewResult(response || completion.reasoning || "");
            if ("error" in candidate) {
              error =
                completion.finishReason === "length"
                  ? "the reply was cut off before completing the review"
                  : candidate.error;
              lastError = error;
              messages.push({
                role: "assistant",
                content: response || "[the reply contained no visible text]",
              });
              messages.push({
                role: "user",
                content:
                  completion.finishReason === "length"
                    ? SEASON_REVIEW_PROMPT_POLICY.truncatedTemplate.replace(
                        "{{budget}}",
                        String(SEASON_REVIEW_PROMPT_POLICY.maxTokens),
                      )
                    : SEASON_REVIEW_PROMPT_POLICY.rejectionTemplate.replace(
                        "{{error}}",
                        candidate.error,
                      ),
              });
            } else {
              parsed = candidate.value;
            }
          } catch (cause) {
            const failure = classifyProviderFailure(cause, model);
            error = failure.summary;
            lastError = error;
            terminalError = new Error(`${failure.summary} The season review cannot continue.`, {
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
          } satisfies SeasonSeatLog;
          fs.appendFileSync(seatLog, `${JSON.stringify(completeLogRow)}\n`, "utf8");
          if (terminalError) throw terminalError;
        }
      }
      if (!parsed) {
        const reason = provider
          ? `no review was recorded after ${SEASON_REVIEW_PROMPT_POLICY.attempts} rejected replies (${lastError})`
          : "the random baseline files no review";
        parsed = { summary: reason, did_well: reason, did_poorly: reason, would_change: reason };
        fallback = Boolean(provider);
      }
      const review: SeasonReview = { entrant, model, outcome, ...parsed, fallback };
      appendJsonlObject(transcript, { ...review, timestamp: new Date().toISOString() });
      options.onReview?.(review);
      return review;
    },
  );
  reviews.push(...fresh);
  return reviews;
}
