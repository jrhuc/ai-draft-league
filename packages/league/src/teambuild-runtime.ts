import fs from "node:fs";
import path from "node:path";

import { completeWithDexTools, type DexToolRequest } from "./dex-lookups.js";
import { MEMORY_TOOL_NOTICE, memoryPageTool, renderMemory } from "./franchise-memory.js";
import { defaultPsDir } from "./paths.js";
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
} from "./providers.js";
import { ShowdownReference } from "./reference.js";
import { loadShowdown, showdownCommit } from "./showdown.js";
import { noStageEvidence, type StageEvidence } from "./stage-evidence.js";
import { decodeTeamBuildJournalRow } from "./teambuild-artifacts.js";
import {
  canonicalTeamBuildTask,
  type ParsedTeamBuild,
  parseTeamBuildResponse,
  type RawSet,
  type TeamBuildArtifact,
  type TeamBuildCandidate,
  type TeamBuildExecutionPolicy,
  type LeagueTeamBuildResult,
  type TeamBuildObjective,
  type TeamBuildOptions,
  type TeamBuildRequest,
  type TeamBuildResult,
  type TeamBuildTask,
  validateTeamBuildTask,
} from "./teambuild-protocol.js";
import {
  TEAMBUILD_PROMPT_POLICY,
  teamBuildSystemPrompt,
  teamBuildUserPrompt,
} from "./teambuild-prompts.js";
import {
  fallbackSets,
  packCandidateTeam,
  repairSet,
  validateCandidate,
} from "./teambuild-validation.js";
import { normalizePackedTeam, validateTeam } from "./teams.js";
import type { JsonObject, ProviderMessage } from "./types.js";
import { fileSlug } from "./value.js";
import type { TeamBuildSetView, TeamBuildView } from "./views.js";

interface TeamBuildAttemptTraceHeader {
  series?: number;
  entrant?: number;
  opponent?: string;
  task_id?: string;
  objective?: TeamBuildObjective["kind"];
  constraint?: string;
  attempt: number;
  system?: string;
}

interface TeamBuildAttemptTrace extends TeamBuildAttemptTraceHeader {
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

function attemptLogFile(task: TeamBuildTask, logDir: string): string {
  if (task.provenance.seriesIndex !== undefined && task.provenance.entrant !== undefined) {
    return path.join(
      logDir,
      `series-${task.provenance.seriesIndex + 1}-e${task.provenance.entrant}-${fileSlug(task.model)}.jsonl`,
    );
  }
  return path.join(logDir, `${fileSlug(task.id)}-${fileSlug(task.model)}.jsonl`);
}

function fallbackEvidence(rationale: string, notebook: string): StageEvidence {
  return { ...noStageEvidence(notebook), rationale };
}

async function runLeagueTeamBuild(
  task: TeamBuildTask,
  options: TeamBuildOptions,
): Promise<LeagueTeamBuildResult> {
  validateTeamBuildTask(task);
  if (task.executionPolicy !== "league-resilient") {
    throw new Error("provider orchestration is reserved for league-resilient team building");
  }
  const executionPolicy: TeamBuildExecutionPolicy = "league-resilient";
  const normalizedTask = canonicalTeamBuildTask(task, executionPolicy);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(task.format);
  const dex = Dex.mod(format.mod || "base");
  const ruleTable = Dex.formats.getRuleTable(format);
  const evLimit = ruleTable.evLimit ?? 508;
  const evMax = 32;
  const reference = new ShowdownReference(task.format, psDir);
  fs.mkdirSync(options.logDir, { recursive: true });
  const logFile = attemptLogFile(task, options.logDir);

  const system = teamBuildSystemPrompt(normalizedTask, dex, evLimit, evMax);
  const messages: ProviderMessage[] = [
    { role: "user", content: teamBuildUserPrompt(normalizedTask, dex) },
  ];
  const reasoning = reasoningForModel(task.model, options);
  const apiKey = options.apiKeys?.[task.model];
  const provider =
    task.model === "random"
      ? undefined
      : (options.makeTeambuildProvider?.(task.model, apiKey, reasoning) ??
        makeProvider(parseSpec(task.model), { apiKey, reasoning }));

  const owned = new Map(task.constraint.candidates.map((mon) => [mon.id, mon]));
  const runCreatedAt = options.createdAt ?? new Date().toISOString();
  let accepted: ParsedTeamBuild | undefined;
  let lastParsed: ParsedTeamBuild | undefined;
  let attemptsUsed = 0;
  let lastError = "";

  for (
    let attempt = 1;
    provider && attempt <= TEAMBUILD_PROMPT_POLICY.attempts && !accepted;
    attempt += 1
  ) {
    options.signal?.throwIfAborted();
    attemptsUsed = attempt;
    const promptForAttempt = messages[messages.length - 1]!.content ?? "";
    let response = "";
    let usage: Record<string, number> | undefined;
    let error: string | undefined;
    let terminalError: Error | undefined;
    const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
    try {
      const completionRequest: DexToolRequest = {
        provider,
        system,
        messages,
        spec: task.model,
        reference,
        policy: TEAMBUILD_PROMPT_POLICY,
        onLookup: (call) => lookups.push(call),
      };
      const memory = options.memory;
      if (memory) completionRequest.extraTools = [memoryPageTool(() => memory)];
      if (options.signal !== undefined) completionRequest.signal = options.signal;
      const completion = await completeWithDexTools(completionRequest);
      response = completion.text;
      usage = completion.usage;
      const truncated = completion.finishReason === "length";
      if (!response.trim() && !truncated && completion.reasoning) {
        const salvaged = parseTeamBuildResponse(completion.reasoning, task);
        if (salvaged.status === "accepted") response = completion.reasoning;
      }
      const parsed = parseTeamBuildResponse(response, normalizedTask);
      if (parsed.status === "rejected") {
        error = truncated
          ? "the reply used its whole token budget before finishing the team"
          : parsed.error;
        lastError = error;
      } else {
        const submission = parsed.data;
        const problems = validateCandidate(
          dex,
          normalizedTask.format,
          submission.sets,
          owned,
          psDir,
        );
        if (problems.length) {
          error = problems.join("\n");
          lastError = error;
          lastParsed = submission;
        } else {
          accepted = submission;
        }
      }
      if (error) {
        messages.push({
          role: "assistant",
          content: truncated
            ? "[reply cut off before the team was finished]"
            : response || "[the reply contained no visible text]",
        });
        messages.push({
          role: "user",
          content: truncated
            ? TEAMBUILD_PROMPT_POLICY.truncatedTemplate.replace(
                "{{budget}}",
                String(TEAMBUILD_PROMPT_POLICY.maxTokens),
              )
            : TEAMBUILD_PROMPT_POLICY.rejectionTemplate.replace("{{error}}", error),
        });
      }
    } catch (cause) {
      const failure = classifyProviderFailure(cause, task.model);
      error = failure.summary;
      lastError = error;
      terminalError = new Error(`${failure.summary} The teambuild cannot continue.`, { cause });
    }
    const traceContext =
      task.objective.kind === "matchup" &&
      task.provenance.seriesIndex !== undefined &&
      task.provenance.entrant !== undefined
        ? {
            series: task.provenance.seriesIndex + 1,
            entrant: task.provenance.entrant,
            opponent: task.objective.opponent.model,
          }
        : { task_id: task.id, objective: task.objective.kind, constraint: task.constraint.id };
    const traceHeader: TeamBuildAttemptTraceHeader = { ...traceContext, attempt };
    if (attempt === 1) traceHeader.system = system;
    const trace: TeamBuildAttemptTrace = { ...traceHeader, user: promptForAttempt, response };
    if (usage) trace.usage = usage;
    if (lookups.length) trace.tool_lookups = lookups;
    if (error) trace.error = error;
    fs.appendFileSync(logFile, `${JSON.stringify(trace)}\n`, "utf8");
    if (terminalError) throw terminalError;
  }

  const noParseRationale = provider
    ? `no parseable team after ${TEAMBUILD_PROMPT_POLICY.attempts} attempts (${lastError})`
    : task.objective.kind === "matchup" && task.constraint.teamSize === 6
      ? "random baseline: six of the roster with repaired legal sets"
      : `random baseline: ${task.constraint.teamSize} candidates with repaired legal sets`;
  const chosen =
    accepted ??
    lastParsed ??
    ({
      sets: fallbackSets(
        task.constraint.candidates,
        task.constraint.teamSize,
        options.rng,
        evLimit,
        evMax,
      ),
      evidence: fallbackEvidence(noParseRationale, task.notebook),
    } satisfies ParsedTeamBuild);
  const taken = new Set<string>();
  const views: TeamBuildSetView[] = [];
  let repaired: Array<{ mon: TeamBuildCandidate; set: RawSet; repairs: string[] }> =
    chosen.sets.map((raw) => {
      const mon = owned.get(raw.id)!;
      return accepted
        ? { mon, set: raw, repairs: [] }
        : { mon, ...repairSet(dex, mon, raw, evLimit, evMax, taken, options.rng) };
    });

  const problems = validateCandidate(
    dex,
    task.format,
    repaired.map((entry) => entry.set),
    owned,
    psDir,
  );
  if (problems.length) {
    const fallbackTaken = new Set<string>();
    repaired = fallbackSets(
      task.constraint.candidates,
      task.constraint.teamSize,
      options.rng,
      evLimit,
      evMax,
    ).map((raw) => {
      const mon = owned.get(raw.id)!;
      const rebuilt = repairSet(dex, mon, raw, evLimit, evMax, fallbackTaken, options.rng);
      return {
        mon,
        set: rebuilt.set,
        repairs: [`rebuilt from scratch: ${problems.join("; ")}`, ...rebuilt.repairs],
      };
    });
    const fallbackProblems = validateCandidate(
      dex,
      task.format,
      repaired.map((entry) => entry.set),
      owned,
      psDir,
    );
    if (fallbackProblems.length) {
      throw new Error(`could not create a legal fallback team: ${fallbackProblems.join("; ")}`);
    }
  }

  for (const { mon, set, repairs } of repaired) {
    views.push({
      species: mon.name,
      spriteId: dex.species.get(mon.forme ?? mon.species).spriteid,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: set.moves,
      evs: set.evs,
      note: set.note,
      repaired: repairs.length > 0,
      repairs,
    });
  }

  const packed = normalizePackedTeam(packCandidateTeam(dex, repaired, psDir), psDir, task.format);
  validateTeam(packed, task.format, psDir);
  const allRepairs = repaired.flatMap((entry) =>
    entry.repairs.map((repair) => `${entry.mon.id}: ${repair}`),
  );
  const artifact: TeamBuildArtifact = {
    schemaVersion: 1,
    status: "valid",
    task: normalizedTask,
    executionPolicy,
    showdownCommit: showdownCommit(psDir),
    action: {
      selected: repaired.map((entry) => entry.mon.id),
      packed,
      sets: views,
    },
    evidence: chosen.evidence,
    validation: {
      showdown: true,
      repaired: allRepairs.length > 0,
      repairs: allRepairs,
      problems: [],
    },
    attempts: attemptsUsed,
    fallback: accepted === undefined,
    createdAt: runCreatedAt,
  };
  return { packed, artifact };
}

export async function runTeambuild(
  request: TeamBuildRequest,
  options: TeamBuildOptions,
): Promise<TeamBuildResult> {
  const task: TeamBuildTask = {
    id: `draft-series-${request.seriesIndex + 1}-entrant-${request.entrant}`,
    model: request.model,
    format: request.format,
    sheetPolicy: request.sheetPolicy ?? "open",
    executionPolicy: "league-resilient",
    constraint: {
      kind: "draft-picks",
      id: `series-${request.seriesIndex + 1}-entrant-${request.entrant}-roster`,
      teamSize: 6,
      candidates: request.roster,
    },
    objective: {
      kind: "matchup",
      stage: request.stage,
      opponent: { model: request.opponentModel, candidates: request.opponentRoster },
      priorContext: request.playoffContext,
    },
    notebook: [...renderMemory(request.memory), "", MEMORY_TOOL_NOTICE].join("\n"),
    provenance: {
      source: "draft-league",
      seriesIndex: request.seriesIndex,
      entrant: request.entrant,
      opponent: request.opponent,
    },
  };
  const result = await runLeagueTeamBuild(task, { ...options, memory: request.memory });
  const action = result.artifact.action;
  if (!result.packed || !action) {
    throw new Error("league-resilient team building ended without a valid team");
  }
  const view: TeamBuildView = {
    seriesIndex: request.seriesIndex,
    entrant: request.entrant,
    opponent: request.opponent,
    brought: action.selected,
    sets: action.sets,
    rationale: result.artifact.evidence.rationale,
    attempts: result.artifact.attempts,
  };
  const journalRow = JSON.stringify({ artifact: result.artifact });
  decodeTeamBuildJournalRow(JSON.parse(journalRow));
  fs.appendFileSync(path.join(options.logDir, "teambuild.jsonl"), `${journalRow}\n`, "utf8");
  return { packed: result.packed, artifact: result.artifact, view };
}
