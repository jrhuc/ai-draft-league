import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { AgentRunner } from "./agent-runtime.js";
import { referenceTools, runStage, submissionTool } from "./stage-agent.js";
import type { DraftBoard, DraftBoardMon } from "./draft.js";
import type { DraftPickView, DraftTableRow } from "./views.js";
import { commitRunArtifact, readRunArtifacts } from "./run-artifact-store.js";
import { FORMAT_AUTHORITY_NOTICE, MANAGER_CHARGE, renderPromptTemplate } from "./prompts.js";
import { reasoningForModel, type ModelReasoningConfig } from "./providers.js";
import { ShowdownReference } from "./reference.js";
import { mapLimit } from "./series.js";
import type { TradeWindowArtifact } from "./trade-window.js";
import type { JsonObject } from "./types.js";
import { fileSlug } from "./value.js";

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
    'Call submit_review with {"summary":"<1-2 sentences on how the season went>","did_well":"<2-4 sentences>","did_poorly":"<2-4 sentences>","would_change":"<2-4 sentences, each one concrete>"}.',
  ],
  fieldLimit: 2_000,
} as const;

export interface SeasonReview {
  entrant: number;
  model: string;
  outcome: string;
  summary: string;
  did_well: string;
  did_poorly: string;
  would_change: string;
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
  runAgent: AgentRunner;
  onReview?: (review: SeasonReview) => void;
}

const reviewField = (description: string) =>
  z
    .string()
    .trim()
    .min(1, "every review field must be non-empty")
    .max(
      SEASON_REVIEW_PROMPT_POLICY.fieldLimit,
      `a review field exceeds ${SEASON_REVIEW_PROMPT_POLICY.fieldLimit} characters`,
    )
    .describe(description);

export const seasonReviewReplySchema = z.object({
  summary: reviewField("One or two sentences on how the season went."),
  did_well: reviewField(
    "Two to four sentences on what you got right, naming specific picks, moves, and games.",
  ),
  did_poorly: reviewField(
    "Two to four sentences on what went wrong, naming specific picks, moves, and games.",
  ),
  would_change: reviewField("Two to four sentences, each a concrete change you would make."),
});

type ParsedSeasonReview = z.infer<typeof seasonReviewReplySchema>;

export function parseSeasonReview(input: JsonObject): ParsedSeasonReview {
  const reply = seasonReviewReplySchema.safeParse(input);
  if (!reply.success) throw new Error(z.prettifyError(reply.error));
  return reply.data;
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
      `- Pick ${pick.pick}: ${mon?.name ?? pick.mon} (${mon?.cost ?? "?"} pts) — ${pick.rationale || "(no stored reasoning)"}`,
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

const seasonReviewRowSchema = z.strictObject({
  timestamp: z.string(),
  entrant: z.number().int().nonnegative(),
  model: z.string(),
  outcome: z.string(),
  summary: z.string(),
  did_well: z.string(),
  did_poorly: z.string(),
  would_change: z.string(),
});

/** Reviews already written are replayed rather than re-bought, so a resumed league never pays twice for a
 * retrospective whose season is already closed. Seasons close in waves, so a stored row may belong to an
 * entrant outside this wave; a row for an entrant in it must record the same outcome. */
function replayReviews(
  runDir: string,
  finished: ReadonlyArray<{ entrant: number; outcome: string }>,
  models: readonly string[],
): SeasonReview[] {
  return readRunArtifacts(runDir, "season-review").map(({ key, value }) => {
    const parsed = seasonReviewRowSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(`invalid season review artifact ${key}: ${z.prettifyError(parsed.error)}`);
    const { timestamp: _timestamp, ...review } = parsed.data;
    const model = models[review.entrant];
    if (model === undefined) {
      throw new Error(
        `season review artifact ${key} names entrant ${review.entrant}, who is not in this league`,
      );
    }
    const expected = finished.find((entry) => entry.entrant === review.entrant)?.outcome;
    if (review.model !== model || (expected !== undefined && review.outcome !== expected)) {
      throw new Error(
        `season review artifact ${key} records ${review.model} (${review.outcome}), expected ${model} (${expected ?? review.outcome})`,
      );
    }
    return review;
  });
}

export async function runSeasonReview(
  finished: ReadonlyArray<{ entrant: number; outcome: string }>,
  state: SeasonReviewState,
  options: RunSeasonReviewOptions,
): Promise<SeasonReview[]> {
  const logDir = path.join(options.runDir, "season");
  const reviews = replayReviews(options.runDir, finished, state.models);
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
      let parsed: ParsedSeasonReview | undefined;
      const system = systemPrompt(state, entrant);
      if (model !== "random") {
        const seatLog = path.join(logDir, `seat-${entrant}-${fileSlug(model)}.jsonl`);
        const result = await runStage({
          session: `season-review-${entrant}`,
          task: `season-review-${entrant}`,
          model,
          reasoning: reasoningForModel(model, options),
          system,
          prompt: userPrompt(state, entrant, outcome),
          tools: referenceTools(reference),
          submission: submissionTool("submit_review", seasonReviewReplySchema),
          validate: parseSeasonReview,
          runner: options.runAgent,
          logFile: seatLog,
          signal,
        });
        parsed = result.value;
      }
      if (!parsed) {
        const reason = "the random baseline files no review";
        parsed = { summary: reason, did_well: reason, did_poorly: reason, would_change: reason };
      }
      const review: SeasonReview = { entrant, model, outcome, ...parsed };
      const row = { ...review, timestamp: new Date().toISOString() };
      commitRunArtifact(options.runDir, "season-review", String(entrant).padStart(6, "0"), row);
      options.onReview?.(review);
      return review;
    },
  );
  reviews.push(...fresh);
  return reviews;
}
