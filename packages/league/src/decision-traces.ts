import path from "node:path";
import { z } from "zod";

import { readJsonlObjects } from "./jsonl.js";
import type { PublicDecisionTrace } from "./public/season-protocol.js";
import type { Pid } from "./types.js";
import type { LeagueGameDecisionView } from "./views.js";
import { text } from "./value.js";

const traceRowSchema = z.object({
  kind: z.literal("decision_trace"),
  pid: z.enum(["p1", "p2"]),
  turn: z.number().int(),
  phase: z.enum(["team_preview", "turn", "forced_switch"]),
  submission_id: z.string(),
  game_number: z.number().int(),
  prompt: z.string(),
  raw_response: z.string(),
  reasoning: z.string().nullable(),
  usage: z.record(z.string(), z.number()),
  latency_ms: z.number().nonnegative(),
  tool_calls: z.array(
    z.object({ name: z.string(), arguments: z.record(z.string(), z.json()), result: z.string() }),
  ),
});
type TraceRow = z.infer<typeof traceRowSchema>;

export function readSubmissionTraces(
  seriesDir: string,
  pid: Pid,
  submissions: ReadonlySet<string>,
): Map<string, TraceRow> {
  const traced = new Map<string, TraceRow>();
  for (const row of readJsonlObjects(path.join(seriesDir, `${pid}-trace.jsonl`))) {
    if (row.kind !== "decision_trace" || !submissions.has(text(row.submission_id))) continue;
    const parsed = traceRowSchema.safeParse(row);
    if (!parsed.success)
      throw new Error(`${path.basename(seriesDir)} ${pid} has an invalid decision trace`);
    if (traced.has(parsed.data.submission_id))
      throw new Error(
        `${path.basename(seriesDir)} ${pid} traced submission ${parsed.data.submission_id} twice`,
      );
    traced.set(parsed.data.submission_id, parsed.data);
  }
  return traced;
}

export function readGameDecisionTraces(
  seriesDir: string,
  game: number,
  franchises: [string, string],
  decisions: readonly LeagueGameDecisionView[],
): Array<PublicDecisionTrace | null> {
  const seriesId = path.basename(seriesDir);
  const submissions = (side: number) =>
    new Set(
      decisions.flatMap((decision) =>
        decision.side === side && !decision.automatic && decision.submissionId !== null
          ? [decision.submissionId]
          : [],
      ),
    );
  const traced = {
    p1: readSubmissionTraces(seriesDir, "p1", submissions(0)),
    p2: readSubmissionTraces(seriesDir, "p2", submissions(1)),
  };
  return decisions.map((decision) => {
    if (decision.automatic) return null;
    const pid: Pid = decision.side === 0 ? "p1" : "p2";
    if (decision.submissionId === null)
      throw new Error(
        `${seriesId} ${pid} game ${game} turn ${decision.turn} predates submission ids`,
      );
    const row = traced[pid].get(decision.submissionId);
    if (!row)
      throw new Error(
        `${seriesId} ${pid} game ${game} turn ${decision.turn} has no trace for submission ${decision.submissionId}`,
      );
    return {
      franchiseId: franchises[decision.side],
      turn: decision.turn,
      phase: decision.phase,
      selection: [...decision.selection],
      prompt: row.prompt,
      toolCalls: row.tool_calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
        result: call.result,
      })),
      reasoning: row.reasoning ?? "",
      response: row.raw_response,
      usage: row.usage,
      latencyMs: row.latency_ms,
    };
  });
}
