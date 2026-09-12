import fs from "node:fs";
import path from "node:path";

import { createBoardSearch } from "./board-search.js";
import type { AgentRunner } from "./agent-runtime.js";
import { referenceTools, runStage, submissionTool } from "./stage-agent.js";
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
  franchiseNameReplySchema,
  franchiseNameSystemPrompt,
  franchiseNameTranscriptRowSchema,
  franchiseNameUserPrompt,
  legalPicks,
  parseFranchiseName,
  parsePick,
  pickReplySchema,
  snakeOrder,
} from "./draft-protocol.js";
import { defaultPsDir } from "./paths.js";
import { commitRunArtifact, readRunArtifacts } from "./run-artifact-store.js";
import { reasoningForModel, type ModelReasoningConfig } from "./providers.js";
import type { Rng } from "./random.js";
import { ShowdownReference } from "./reference.js";
import type { StageEvidence } from "./stage-evidence.js";
import type { JsonValue } from "./types.js";
import { clip, fileSlug } from "./value.js";
import type { DraftPickView } from "./views.js";

export interface RunDraftOptions extends ModelReasoningConfig {
  runDir: string;
  psDir?: string;
  logDir: string;
  rng: Rng;
  signal?: AbortSignal;
  rosterPolicy?: string;
  onPick?: (view: DraftPickView, state: DraftState) => void;
  onName?: (entrant: number, teamName: string, state: DraftState) => void;
  runAgent: AgentRunner;
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
  rows: readonly JsonValue[],
  label: string,
  state: DraftState,
  context: ReplayTranscriptContext,
): ReplayTranscriptResult {
  const parsedRows = rows.map((row) => draftTranscriptRowSchema.parse(row));
  let replayedState = state;
  for (const [index, row] of parsedRows.entries()) {
    const drafter = context.order[index];
    if (drafter === undefined)
      throw new Error(`${label} holds more picks than the draft has slots`);
    if (row.entrant !== drafter || row.model !== context.models[drafter]) {
      throw new Error(
        `${label} pick ${index + 1} belongs to entrant ${row.entrant} (${row.model}), expected entrant ${drafter} (${context.models[drafter]})`,
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
      throw new Error(`${label} pick ${index + 1} is invalid: ${reason}`, { cause });
    }
    const mon = replayedState.rosters[drafter]!.at(-1)!;
    if (row.budget_left !== replayedState.budgets[drafter]) {
      throw new Error(
        `${label} pick ${index + 1} leaves ${replayedState.budgets[drafter]} points, but the transcript recorded ${row.budget_left}`,
      );
    }
    if (row.notebook !== undefined) context.notebooks[drafter] = row.notebook;
    const view: DraftPickView = {
      pick: index + 1,
      entrant: drafter,
      mon: mon.id,
      rationale: clip(row.rationale, DRAFT_PROMPT_POLICY.rationaleLimit),
    };
    context.picks.push(view);
    context.onPick?.(view, replayedState);
  }
  return { count: parsedRows.length, state: replayedState };
}

function replayFranchiseNames(
  rows: readonly JsonValue[],
  models: readonly string[],
  state: DraftState,
): void {
  for (const value of rows) {
    const row = franchiseNameTranscriptRowSchema.parse(value);
    const entrant = row.entrant;
    if (entrant < 0 || entrant >= models.length) {
      throw new Error("stored franchise name has an invalid entrant");
    }
    if (row.model !== models[entrant]) {
      throw new Error(
        `stored franchise name names ${row.model} for entrant ${entrant}, expected ${models[entrant]}`,
      );
    }
    const { teamName } = parseFranchiseName(row);
    if (state.teamNames[entrant] && state.teamNames[entrant] !== teamName) {
      throw new Error(`stored franchise name conflicts with the draft for entrant ${entrant}`);
    }
    state.teamNames[entrant] = teamName;
  }
}

async function nameFranchises(
  models: string[],
  state: DraftState,
  options: RunDraftOptions,
): Promise<void> {
  const { runDir } = options;
  replayFranchiseNames(
    readRunArtifacts(runDir, "draft-franchise-name").map((row) => row.value),
    models,
    state,
  );
  await Promise.all(
    models.map(async (model, entrant) => {
      if (state.teamNames[entrant]) {
        options.onName?.(entrant, state.teamNames[entrant]!, state);
        return;
      }
      let teamName = `Random Coach ${entrant + 1}`;
      if (model !== "random") {
        const seatLog = path.join(options.logDir, `namer-${entrant}-${fileSlug(model)}.jsonl`);
        const result = await runStage({
          session: `name-${entrant}`,
          task: `name-${entrant}`,
          model,
          reasoning: reasoningForModel(model, options),
          system: franchiseNameSystemPrompt(model),
          prompt: franchiseNameUserPrompt(state.rosters[entrant]!),
          submission: submissionTool("submit_name", franchiseNameReplySchema),
          validate: (input) => parseFranchiseName(input).teamName,
          runner: options.runAgent,
          signal: options.signal,
          logFile: seatLog,
        });
        teamName = result.value;
      }
      state.teamNames[entrant] = teamName;
      const row = {
        entrant,
        model,
        team_name: teamName,
        timestamp: new Date().toISOString(),
      };
      commitRunArtifact(runDir, "draft-franchise-name", String(entrant).padStart(6, "0"), row);
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
  const reference = new ShowdownReference(board.format, psDir);
  const rosterPolicy =
    options.rosterPolicy ??
    "- After the draft this roster is locked for the whole season: a round robin of best-of-three matches, then playoffs.";
  const systemPrompts = models.map((_, drafter) =>
    draftSystemPrompt(board, models, drafter, psDir, rosterPolicy),
  );
  const seatLogs = models.map((model, index) =>
    path.join(options.logDir, `drafter-${index}-${fileSlug(model)}.jsonl`),
  );
  const { runDir } = options;
  const picks: DraftPickView[] = [];
  const notebooks = models.map(() => "");

  const order = snakeOrder(models.length, board.picks);
  const replayed = replayTranscript(
    readRunArtifacts(runDir, "draft-pick").map((row) => row.value),
    "stored draft",
    state,
    {
      models,
      order,
      picks,
      notebooks,
      onPick: options.onPick,
    },
  );
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
    const model = models[drafter]!;
    if (model !== "random") {
      const result = await runStage({
        session: `draft-${drafter}`,
        task: `pick-${pickNumber + 1}`,
        model,
        reasoning: reasoningForModel(model, options),
        system: systemPrompts[drafter]!,
        prompt: draftUserPrompt(state, drafter, models, pickNumber, notebooks[drafter]!),
        tools: referenceTools(reference, createBoardSearch(board, psDir, legal)),
        submission: submissionTool("submit_pick", pickReplySchema),
        validate: (input) => parsePick(input, legal, state, drafter, models, notebooks[drafter]!),
        runner: options.runAgent,
        signal: options.signal,
        logFile: seatLogs[drafter]!,
      });
      chosen = result.value.mon;
      reasoning = result.value.reasoning;
      evidence = result.value.evidence;
      notebooks[drafter] = evidence.notebook;
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
      rationale: reasoning,
      evidence_supplied: {
        rationale: evidence.supplied.rationale,
        notebook_update: evidence.supplied.notebookUpdate,
      },
      timestamp: new Date().toISOString(),
    };
    if (evidence.supplied.notebookUpdate || evidence.notebook)
      transcriptRow.notebook = evidence.notebook;
    commitRunArtifact(runDir, "draft-pick", String(pickNumber + 1).padStart(6, "0"), transcriptRow);
    options.onPick?.(view, state);
  }

  await nameFranchises(models, state, options);

  return {
    rosters: state.rosters,
    picks,
    budgets: state.budgets,
    teamNames: state.teamNames,
    notebooks,
  };
}
