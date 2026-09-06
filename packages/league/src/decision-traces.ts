import path from "node:path";
import { z } from "zod";

import { readJsonlObjects } from "./jsonl.js";
import type { PublicDecisionTrace } from "./public/season-protocol.js";
import type { Pid } from "./types.js";
import type { LeagueGameDecisionView } from "./views.js";

const traceRowSchema = z.looseObject({
  kind: z.literal("decision_trace"),
  submission_id: z.string(),
  game_number: z.number().int(),
  prompt: z.string(),
  raw_response: z.string(),
  reasoning: z.string().nullable(),
  usage: z.record(z.string(), z.number()),
  latency_ms: z.number().nonnegative(),
  max_tokens: z.number().int().positive().nullable(),
  timer: z
    .object({ turn_seconds: z.number().nullable(), bank_seconds: z.number().nullable() })
    .nullable(),
  tool_calls: z.array(
    z.object({ name: z.string(), arguments: z.record(z.string(), z.json()), result: z.string() }),
  ),
  fallback: z.boolean(),
  error: z.string().nullable(),
  failed_attempts: z.array(z.object({ response: z.string(), error: z.string() })).optional(),
});
type TraceRow = z.infer<typeof traceRowSchema>;

function tracedSubmissions(seriesDir: string, pid: Pid, game: number): Map<string, TraceRow> {
  const traced = new Map<string, TraceRow>();
  for (const row of readJsonlObjects(path.join(seriesDir, `${pid}-trace.jsonl`))) {
    if (row.kind !== "decision_trace" || row.submission_id === undefined) continue;
    const parsed = traceRowSchema.safeParse(row);
    if (!parsed.success)
      throw new Error(`${path.basename(seriesDir)} ${pid} has an invalid decision trace`);
    if (parsed.data.game_number !== game) continue;
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
  const traced = {
    p1: tracedSubmissions(seriesDir, "p1", game),
    p2: tracedSubmissions(seriesDir, "p2", game),
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
      maxTokens: row.max_tokens,
      timer: row.timer
        ? { turnSeconds: row.timer.turn_seconds, bankSeconds: row.timer.bank_seconds }
        : null,
      fallback: row.fallback,
      error: row.error,
      failedAttempts: (row.failed_attempts ?? []).map((attempt) => ({
        response: attempt.response,
        error: attempt.error,
      })),
    };
  });
}
