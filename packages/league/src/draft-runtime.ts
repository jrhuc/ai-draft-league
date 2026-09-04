import fs from "node:fs";
import path from "node:path";

import { createBoardSearch } from "./board-search.js";
import { completeWithDexTools, type DexToolRequest } from "./dex-lookups.js";
import {
  applyDraftPick,
  type DraftBoard,
  type DraftBoardMon,
  DRAFT_PROMPT_POLICY,
  type DraftState,
  type DraftTranscriptRow,
  draftSystemPrompt,
  draftTranscriptRowSchema,
  draftUserPrompt,
  FRANCHISE_NAME_PROMPT_POLICY,
  franchiseNameSystemPrompt,
  franchiseNameTranscriptRowSchema,
  franchiseNameUserPrompt,
  isRejection,
  legalPicks,
  parseFranchiseName,
  parsePick,
  snakeOrder,
} from "./draft-protocol.js";
import { appendJsonlObject, readJsonlObjects } from "./jsonl.js";
import { defaultPsDir } from "./paths.js";
import type { ModelReasoningConfig, ReasoningLevel } from "./providers.js";
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
} from "./providers.js";
import type { Rng } from "./random.js";
import { ShowdownReference } from "./reference.js";
import type { StageEvidence } from "./stage-evidence.js";
import type { JsonObject, Provider, ProviderMessage } from "./types.js";
import { clip, fileSlug } from "./value.js";
import type { DraftPickView } from "./views.js";

const PROVIDER_RETRY_BASE_MS = 5_000;

type RetryDelayOptions = Pick<RunDraftOptions, "providerRetryBaseMs" | "signal">;

function providerRetryDelay(
  attempt: number,
  { providerRetryBaseMs = PROVIDER_RETRY_BASE_MS, signal }: RetryDelayOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, providerRetryBaseMs * attempt);
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface DraftSeatLog {
  pick: number;
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  finish_reason?: string;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

interface FranchiseNameSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  error?: string;
}

export interface RunDraftOptions extends ModelReasoningConfig {
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  logDir: string;
  rng: Rng;
  signal?: AbortSignal;
  providerRetryBaseMs?: number;
  rosterPolicy?: string;
  onPick?: (view: DraftPickView, state: DraftState) => void;
  onName?: (entrant: number, teamName: string, state: DraftState) => void;
  makeDraftProvider?: (
    spec: string,
    apiKey: string | undefined,
    reasoning: ReasoningLevel | undefined,
  ) => Provider;
}

interface ReplayTranscriptContext {
  models: string[];
  order: number[];
  picks: DraftPickView[];
  notebooks: string[];
  onPick?: (view: DraftPickView, state: DraftState) => void;
}

interface ReplayTranscriptResult {
  count: number;
  state: DraftState;
}

function replayTranscript(
  file: string,
  state: DraftState,
  context: ReplayTranscriptContext,
): ReplayTranscriptResult {
  const rows = readJsonlObjects(file).map((row) => draftTranscriptRowSchema.parse(row));
  let replayedState = state;
  for (const [index, row] of rows.entries()) {
    const drafter = context.order[index];
    if (drafter === undefined) throw new Error(`${file} holds more picks than the draft has slots`);
    if (row.model !== context.models[drafter]) {
      throw new Error(
        `${file} pick ${index + 1} belongs to ${row.model}, expected ${context.models[drafter]}`,
      );
    }
    try {
      replayedState = applyDraftPick(replayedState, {
        pick: row.pick,
        entrant: drafter,
        mon: row.mon,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${file} pick ${index + 1} is invalid: ${reason}`, { cause });
    }
    const mon = replayedState.rosters[drafter]!.at(-1)!;
    if (row.budget_left !== undefined && row.budget_left !== replayedState.budgets[drafter]) {
      throw new Error(
        `${file} pick ${index + 1} leaves ${replayedState.budgets[drafter]} points, but the transcript recorded ${row.budget_left}`,
      );
    }
    if (row.team_name && !replayedState.teamNames[drafter])
      replayedState.teamNames[drafter] = row.team_name;
    if (row.notebook !== undefined) context.notebooks[drafter] = row.notebook;
    const view: DraftPickView = {
      pick: index + 1,
      entrant: drafter,
      mon: mon.id,
      rationale: clip(row.rationale ?? "", DRAFT_PROMPT_POLICY.rationaleLimit),
      fallback: row.fallback === true,
    };
    context.picks.push(view);
    context.onPick?.(view, replayedState);
  }
  return { count: rows.length, state: replayedState };
}

function replayFranchiseNames(file: string, models: readonly string[], state: DraftState): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = franchiseNameTranscriptRowSchema.parse(JSON.parse(line));
    const entrant = row.entrant;
    if (entrant < 0 || entrant >= models.length) {
      throw new Error(`${file} holds an invalid franchise-name entrant`);
    }
    if (row.model !== models[entrant]) {
      throw new Error(
        `${file} names ${row.model} for entrant ${entrant}, expected ${models[entrant]}`,
      );
    }
    const parsed = parseFranchiseName(JSON.stringify({ team_name: row.team_name }));
    if (isRejection(parsed))
      throw new Error(`${file} holds an invalid franchise name for entrant ${entrant}`);
    if (state.teamNames[entrant] && state.teamNames[entrant] !== parsed.teamName) {
      throw new Error(`${file} conflicts with the draft transcript for entrant ${entrant}`);
    }
    state.teamNames[entrant] = parsed.teamName;
  }
}

async function nameFranchises(
  models: string[],
  providers: Array<Provider | undefined>,
  state: DraftState,
  options: RunDraftOptions,
): Promise<void> {
  const transcript = path.join(options.logDir, "franchise-names.jsonl");
  replayFranchiseNames(transcript, models, state);
  await Promise.all(
    models.map(async (model, entrant) => {
      if (state.teamNames[entrant]) {
        options.onName?.(entrant, state.teamNames[entrant]!, state);
        return;
      }
      const provider = providers[entrant];
      const fallbackName =
        model === "random" ? `Random Coach ${entrant + 1}` : `Coach ${entrant + 1}`;
      let teamName = "";
      let fallback = false;
      if (provider) {
        const system = franchiseNameSystemPrompt(model);
        const messages: ProviderMessage[] = [
          { role: "user", content: franchiseNameUserPrompt(state.rosters[entrant]!) },
        ];
        const seatLog = path.join(options.logDir, `namer-${entrant}-${fileSlug(model)}.jsonl`);
        for (
          let attempt = 1;
          attempt <= FRANCHISE_NAME_PROMPT_POLICY.attempts && !teamName;
          attempt += 1
        ) {
          options.signal?.throwIfAborted();
          const user = messages[messages.length - 1]!.content ?? "";
          let response = "";
          let usage: Record<string, number> | undefined;
          let error: string | undefined;
          try {
            const completion = await provider.complete(system, messages, {
              maxTokens: FRANCHISE_NAME_PROMPT_POLICY.maxTokens,
              signal: options.signal,
            });
            response = completion.text;
            usage = completion.usage;
            const parsed = parseFranchiseName(response);
            if (isRejection(parsed)) {
              error = parsed;
              messages.push({
                role: "assistant",
                content: response || "[the reply contained no visible text]",
              });
              messages.push({
                role: "user",
                content: FRANCHISE_NAME_PROMPT_POLICY.rejectionTemplate.replace(
                  "{{error}}",
                  parsed,
                ),
              });
            } else teamName = parsed.teamName;
          } catch (cause) {
            const failure = classifyProviderFailure(cause, model);
            error = failure.summary;
            if (attempt < FRANCHISE_NAME_PROMPT_POLICY.attempts)
              await providerRetryDelay(attempt, options);
          }
          const logEntry: FranchiseNameSeatLog = { attempt, user, response };
          if (attempt === 1) logEntry.system = system;
          if (usage) logEntry.usage = usage;
          if (error) logEntry.error = error;
          fs.appendFileSync(seatLog, `${JSON.stringify(logEntry)}\n`, "utf8");
        }
      }
      if (!teamName) {
        teamName = fallbackName;
        fallback = true;
      }
      state.teamNames[entrant] = teamName;
      appendJsonlObject(transcript, {
        entrant,
        model,
        team_name: teamName,
        fallback,
        timestamp: new Date().toISOString(),
      });
      options.onName?.(entrant, teamName, state);
    }),
  );
}

interface DraftOutcome {
  rosters: DraftBoardMon[][];
  picks: DraftPickView[];
  budgets: number[];
  teamNames: string[];
  notebooks: string[];
}

export async function runDraft(
  models: string[],
  board: DraftBoard,
  options: RunDraftOptions,
): Promise<DraftOutcome> {
  const psDir = options.psDir ?? defaultPsDir();
  fs.mkdirSync(options.logDir, { recursive: true });
  let state: DraftState = {
    board,
    taken: new Map(),
    rosters: models.map(() => []),
    budgets: models.map(() => board.budget),
    teamNames: models.map(() => ""),
  };
  const providers = models.map((model) => {
    if (model === "random") return undefined;
    const make =
      options.makeDraftProvider ??
      ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) =>
        makeProvider(parseSpec(spec), { apiKey, reasoning }));
    return make(model, options.apiKeys?.[model], reasoningForModel(model, options));
  });
  const reference = new ShowdownReference(board.format, psDir);
  const boardSearch = createBoardSearch(board, psDir);
  const rosterPolicy =
    options.rosterPolicy ??
    "- After the draft this roster is locked for the whole season: a round robin of best-of-three matches, then playoffs.";
  const systemPrompts = models.map((_, drafter) =>
    draftSystemPrompt(board, models, drafter, psDir, rosterPolicy),
  );
  const seatLogs = models.map((model, index) =>
    path.join(options.logDir, `drafter-${index}-${fileSlug(model)}.jsonl`),
  );
  const transcript = path.join(options.logDir, "draft.jsonl");
  const picks: DraftPickView[] = [];
  const notebooks = models.map(() => "");

  const order = snakeOrder(models.length, board.picks);
  const replayed = replayTranscript(transcript, state, {
    models,
    order,
    picks,
    notebooks,
    onPick: options.onPick,
  });
  state = replayed.state;
  for (const [pickNumber, drafter] of order.entries()) {
    if (pickNumber < replayed.count) continue;
    options.signal?.throwIfAborted();
    const legal = legalPicks(state, drafter);
    if (legal.length === 0) {
      throw new Error(
        `coach ${models[drafter]} has no legal pick left (budget ${state.budgets[drafter]}, board exhausted)`,
      );
    }
    let chosen: DraftBoardMon | undefined;
    let reasoning = "";
    let evidence: StageEvidence = {
      rationale: "",
      notebook: notebooks[drafter]!,
      supplied: { rationale: false, notebookUpdate: false },
    };
    let fallback = false;
    const provider = providers[drafter];
    if (provider) {
      const system = systemPrompts[drafter]!;
      const messages: ProviderMessage[] = [
        {
          role: "user",
          content: draftUserPrompt(state, drafter, models, pickNumber, notebooks[drafter]!),
        },
      ];
      let lastError = "";
      for (let attempt = 1; attempt <= DRAFT_PROMPT_POLICY.attempts && !chosen; attempt += 1) {
        options.signal?.throwIfAborted();
        const promptForAttempt = messages[messages.length - 1]!.content ?? "";
        let response = "";
        let usage: Record<string, number> | undefined;
        let finishReason: string | undefined;
        let error: string | undefined;
        let terminalError: Error | undefined;
        const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
        try {
          const request: DexToolRequest = {
            provider,
            system,
            messages,
            spec: models[drafter]!,
            reference,
            boardSearch,
            policy: DRAFT_PROMPT_POLICY,
            onLookup: (call) => lookups.push(call),
            signal: options.signal,
          };
          const completion = await completeWithDexTools(request);
          response = completion.text;
          usage = completion.usage;
          finishReason = completion.finishReason;
          const dropped = (usage.output_tokens ?? 0) === 0 && (usage.input_tokens ?? 0) === 0;
          const truncated = completion.outputLimitReached;
          const stoppedEarly = completion.finishReason === "length" && !truncated;
          if (!response.trim() && !truncated && !stoppedEarly && completion.reasoning) {
            const salvaged = parsePick(
              completion.reasoning,
              legal,
              state,
              drafter,
              models,
              notebooks[drafter]!,
            );
            if (!isRejection(salvaged)) response = completion.reasoning;
          }
          const parsed = parsePick(response, legal, state, drafter, models, notebooks[drafter]!);
          if (isRejection(parsed)) {
            error = truncated
              ? `the reply used its whole ${DRAFT_PROMPT_POLICY.maxTokens}-token budget before naming a pick`
              : stoppedEarly
                ? `the provider stopped the reply for length before reaching the requested ${DRAFT_PROMPT_POLICY.maxTokens}-token cap`
                : dropped
                  ? `the provider stream ended without usage or a finish event (finish=${finishReason ?? "unknown"}); ${parsed}`
                  : parsed;
            lastError = error;
            if (dropped) {
              if (attempt < DRAFT_PROMPT_POLICY.attempts)
                await providerRetryDelay(attempt, options);
            } else {
              messages.push({
                role: "assistant",
                content:
                  truncated || stoppedEarly
                    ? "[reply cut off before a pick]"
                    : response || "[the reply contained no visible text]",
              });
              messages.push({
                role: "user",
                content: truncated
                  ? DRAFT_PROMPT_POLICY.truncatedTemplate.replace(
                      "{{budget}}",
                      String(DRAFT_PROMPT_POLICY.maxTokens),
                    )
                  : DRAFT_PROMPT_POLICY.rejectionTemplate.replace("{{error}}", error),
              });
            }
          } else {
            chosen = parsed.mon;
            reasoning = parsed.reasoning;
            evidence = parsed.evidence;
            notebooks[drafter] = evidence.notebook;
          }
        } catch (cause) {
          const failure = classifyProviderFailure(cause, models[drafter]);
          error = failure.summary;
          lastError = error;
          if (attempt === DRAFT_PROMPT_POLICY.attempts) {
            terminalError = new Error(`${failure.summary} The draft cannot continue.`, { cause });
          } else await providerRetryDelay(attempt, options);
        }
        const logEntry: DraftSeatLog = {
          pick: pickNumber + 1,
          attempt,
          user: promptForAttempt,
          response,
        };
        if (attempt === 1) logEntry.system = system;
        if (usage) logEntry.usage = usage;
        if (finishReason) logEntry.finish_reason = finishReason;
        if (lookups.length) logEntry.tool_lookups = lookups;
        if (error) logEntry.error = error;
        fs.appendFileSync(seatLogs[drafter]!, `${JSON.stringify(logEntry)}\n`, "utf8");
        if (terminalError) throw terminalError;
      }
      if (!chosen) {
        chosen = legal[Math.floor(options.rng() * legal.length)]!;
        reasoning = `random legal pick after ${DRAFT_PROMPT_POLICY.attempts} rejected replies (${lastError})`;
        fallback = true;
        const note = DRAFT_PROMPT_POLICY.fallbackNote
          .replace("{{pick}}", String(pickNumber + 1))
          .replace("{{error}}", lastError || "no usable reply")
          .replace("{{mon}}", `${chosen.name} (${chosen.cost})`);
        const room = DRAFT_PROMPT_POLICY.notebookLimit - note.length - 1;
        notebooks[drafter] = `${clip(notebooks[drafter]!, Math.max(0, room))}\n${note}`.trim();
        evidence = {
          rationale: reasoning,
          notebook: notebooks[drafter]!,
          supplied: { rationale: false, notebookUpdate: false },
        };
      }
    } else {
      chosen = legal[Math.floor(options.rng() * legal.length)]!;
      reasoning = "random baseline pick";
      evidence = {
        rationale: reasoning,
        notebook: notebooks[drafter]!,
        supplied: { rationale: false, notebookUpdate: false },
      };
    }

    state = applyDraftPick(state, { pick: pickNumber + 1, entrant: drafter, mon: chosen.id });
    const view: DraftPickView = {
      pick: pickNumber + 1,
      entrant: drafter,
      mon: chosen.id,
      rationale: clip(reasoning, DRAFT_PROMPT_POLICY.rationaleLimit),
      fallback,
    };
    picks.push(view);
    const transcriptRow: DraftTranscriptRow = {
      pick: pickNumber + 1,
      entrant: drafter,
      model: models[drafter]!,
      mon: chosen.id,
      name: chosen.name,
      cost: chosen.cost,
      budget_left: state.budgets[drafter]!,
      action: { pick: chosen.id },
      rationale: reasoning,
      evidence_supplied: {
        rationale: evidence.supplied.rationale,
        notebook_update: evidence.supplied.notebookUpdate,
      },
      fallback,
      timestamp: new Date().toISOString(),
    };
    if (evidence.supplied.notebookUpdate || evidence.notebook)
      transcriptRow.notebook = evidence.notebook;
    appendJsonlObject(transcript, transcriptRow);
    options.onPick?.(view, state);
  }

  await nameFranchises(models, providers, state, options);

  return {
    rosters: state.rosters,
    picks,
    budgets: state.budgets,
    teamNames: state.teamNames,
    notebooks,
  };
}
