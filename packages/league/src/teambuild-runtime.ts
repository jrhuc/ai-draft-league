import fs from "node:fs";
import path from "node:path";

import { referenceTools, runStage, submissionTool } from "./stage-agent.js";
import { memoryPageTool, renderMemory } from "./franchise-memory.js";
import { defaultPsDir } from "./paths.js";
import { reasoningForModel } from "./providers.js";
import { ShowdownReference } from "./reference.js";
import { loadShowdown } from "./showdown.js";
import { commitRunArtifact } from "./run-artifact-store.js";
import {
  teamBuildReplySchema,
  type TeamBuildOptions,
  type TeamBuildRequest,
  type TeamBuildResult,
  type TeamBuildTask,
} from "./teambuild-protocol.js";
import { validateTeamBuildSubmission } from "./teambuild-referee.js";
import { teamBuildSystemPrompt, teamBuildUserPrompt } from "./teambuild-prompts.js";
import { randomTeamSets } from "./teambuild-validation.js";
import type { JsonObject } from "./types.js";
import { fileSlug } from "./value.js";

export async function runTeambuild(
  request: TeamBuildRequest,
  options: TeamBuildOptions,
): Promise<TeamBuildResult> {
  const task: TeamBuildTask = {
    id: `draft-series-${request.seriesIndex + 1}-entrant-${request.entrant}`,
    model: request.model,
    format: request.format,
    sheetPolicy: request.sheetPolicy ?? "open",
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
    notebook: renderMemory(request.memory, "full").join("\n"),
    provenance: {
      source: "draft-league",
      seriesIndex: request.seriesIndex,
      entrant: request.entrant,
      opponent: request.opponent,
    },
  };
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.forFormat(task.format);
  const evLimit = Dex.formats.getRuleTable(Dex.formats.get(task.format)).evLimit ?? 508;
  const evMax = 32;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const validate = (input: JsonObject) =>
    validateTeamBuildSubmission(task, input, { psDir, createdAt });
  fs.mkdirSync(options.logDir, { recursive: true });
  const artifact =
    task.model === "random"
      ? validate({
          sets: randomTeamSets(dex, task.constraint, options.rng, evLimit, evMax),
          team_plan: `Random baseline: ${task.constraint.teamSize} candidates with legal sets.`,
        })
      : await runStage({
          session: `build-${task.id}`,
          task: task.id,
          model: task.model,
          reasoning: reasoningForModel(task.model, options),
          system: teamBuildSystemPrompt(task, dex, evLimit, evMax),
          prompt: teamBuildUserPrompt(task, dex),
          tools: referenceTools(new ShowdownReference(task.format, psDir), undefined, [
            memoryPageTool(() => request.memory),
          ]),
          submission: submissionTool("submit_team", teamBuildReplySchema),
          validate,
          runner: options.runAgent,
          signal: options.signal,
          logFile: path.join(
            options.logDir,
            `series-${request.seriesIndex + 1}-e${request.entrant}-${fileSlug(task.model)}.jsonl`,
          ),
        }).then((result) => ({ ...result.value, attempts: result.attempts }));
  const journalRow: JsonObject = JSON.parse(JSON.stringify({ artifact }));
  commitRunArtifact(
    options.runDir,
    "teambuild",
    `${request.seriesIndex}:${request.entrant}`,
    journalRow,
  );
  const { action, evidence, attempts } = artifact;
  return {
    packed: action.packed,
    artifact,
    view: {
      seriesIndex: request.seriesIndex,
      entrant: request.entrant,
      opponent: request.opponent,
      brought: action.selected,
      sets: action.sets,
      rationale: evidence.rationale,
      attempts,
    },
  };
}
