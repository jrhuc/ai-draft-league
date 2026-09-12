import { z } from "zod";

export const agentActivitySchema = z.enum([
  "starting",
  "generating",
  "reasoning",
  "tool",
  "retry",
  "compacting",
  "ended",
]);

export type AgentActivity = z.infer<typeof agentActivitySchema>;

export const agentProgressSchema = z.object({
  session: z.string(),
  task: z.string(),
  model: z.string(),
  activity: agentActivitySchema,
  tool: z.string().optional(),
  usage: z
    .object({ cost: z.number(), inputTokens: z.number(), outputTokens: z.number() })
    .optional(),
});

export type AgentProgress = z.infer<typeof agentProgressSchema>;

const sides = <T extends z.ZodType>(value: T) => z.object({ p1: value, p2: value });

export const liveGameSchema = z.object({
  seriesId: z.string(),
  game: z.number().int().positive(),
  attempt: z.string(),
  players: sides(z.string()),
  score: sides(z.number()),
  raw: z.string(),
  turn: z.number(),
  winner: z.string().nullable(),
  state: z.enum(["playing", "ended"]),
});

export type LiveGame = z.infer<typeof liveGameSchema>;

export const liveRunSchema = z.object({
  runId: z.string(),
  generation: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  state: z.enum(["running", "done", "failed", "stopped"]),
  agents: z.array(agentProgressSchema),
  games: z.array(liveGameSchema),
});

export type LiveRunSnapshot = z.infer<typeof liveRunSchema>;
