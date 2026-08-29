import { z } from "zod";

const id = z.string().min(1);
const entrantRef = z.string().regex(/^entrant-\d+$/);

const slotRefSchema = z.strictObject({
  side: z.union([z.literal(0), z.literal(1)]),
  slot: z.number().int().nonnegative(),
});
const eventSchema = z.strictObject({
  turn: z.number().int().nonnegative(),
  kind: z.enum([
    "turn",
    "move",
    "switch",
    "faint",
    "status",
    "field",
    "win",
    "timer",
    "detail",
    "preview",
  ]),
  text: z.string(),
  actor: slotRefSchema.optional(),
  target: slotRefSchema.optional(),
  species: z.string().optional(),
  hp: z.number().int().min(0).max(100).optional(),
  status: z.string().nullable().optional(),
});
const decisionSchema = z.strictObject({
  entrantId: entrantRef,
  turn: z.number().int().nonnegative(),
  phase: z.string(),
  action: z.string(),
  /** The chosen options as the menu presented them, one per acting slot. */
  selection: z.array(z.string()),
  rationale: z.string(),
  /** The model's full scratchpad as rewritten at this decision; empty when untouched. */
  notebook: z.string(),
  fallback: z.boolean(),
  automatic: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});
const reflectionSchema = z.strictObject({
  entrantId: entrantRef,
  result: z.enum(["won", "lost"]),
  summary: z.string(),
  adjustment: z.string(),
  /** The scratchpad as it stood after the review — what a winner carries forward. */
  notebook: z.string(),
  fallback: z.boolean(),
});
const setSchema = z.strictObject({
  id,
  species: id,
  spriteId: id,
  item: z.string(),
  ability: z.string(),
  nature: z.string(),
  moves: z.array(z.string()),
  evs: z.record(z.string(), z.number().int().nonnegative()),
  /** The forme this set reaches in battle when its item Mega Evolves or reverts it. */
  mega: z.strictObject({ species: id, spriteId: id }).nullable(),
});
const gameSummarySchema = z.strictObject({
  number: z.number().int().positive(),
  winnerId: entrantRef.nullable(),
  turns: z.number().int().nonnegative(),
  /** The four each side picked at team preview, lead pair first, as set ids. */
  brought: z.tuple([z.array(id), z.array(id)]),
  megaEvolved: z.tuple([z.string().nullable(), z.string().nullable()]),
  faints: z.tuple([
    z.record(z.string(), z.number().int().nonnegative()),
    z.record(z.string(), z.number().int().nonnegative()),
  ]),
});
const matchSchema = z.strictObject({
  seriesIndex: z.number().int().nonnegative(),
  seriesId: id,
  entrants: z.tuple([entrantRef, entrantRef]),
  score: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  winnerId: entrantRef,
  games: z.array(gameSummarySchema),
});

export const publicTournamentBundleSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  tournament: z.strictObject({
    id,
    title: id,
    format: id,
    provenance: z.enum(["disclosed", "blind"]),
    showdownCommit: z.string().nullable(),
    startedAt: z.iso.datetime(),
    championId: entrantRef.nullable(),
  }),
  event: z
    .strictObject({
      name: id,
      game: id,
      regulation: id,
      location: z.string(),
      dates: z.string(),
      players: z.number().int().positive().nullable(),
      structure: z.string(),
      url: z.string(),
      cut: z.number().int().positive().nullable(),
      reconstructedSpreads: z.boolean(),
    })
    .nullable(),
  /** Exactly what both seats were told before playing; null when provenance was blind. */
  briefing: z.string().nullable(),
  /** Index is the bracket seed position; the team each entrant piloted, sheets always open. */
  entrants: z.array(
    z.strictObject({
      id: entrantRef,
      model: id,
      team: z.strictObject({
        id,
        seed: z.number().int().positive().nullable(),
        placement: z.number().int().positive().nullable(),
        player: z.string(),
        handle: z.string(),
        swiss: z.string(),
        paste: z.string(),
        sets: z.array(setSchema),
      }),
    }),
  ),
  bracket: z.strictObject({
    rounds: z.array(
      z.array(
        z.strictObject({
          seriesIndex: z.number().int().nonnegative().nullable(),
          slots: z.tuple([entrantRef.nullable(), entrantRef.nullable()]),
          match: matchSchema.nullable(),
        }),
      ),
    ),
  }),
  replays: z.record(
    id,
    z.strictObject({
      seriesId: id,
      entrants: z.tuple([entrantRef, entrantRef]),
      games: z.array(
        gameSummarySchema.extend({
          /** The verbatim Showdown protocol log, exactly as the sim emitted it. */
          raw: z.string(),
          events: z.array(eventSchema),
          decisions: z.array(decisionSchema),
          reflections: z.array(reflectionSchema),
        }),
      ),
    }),
  ),
});

export type PublicTournamentBundle = z.infer<typeof publicTournamentBundleSchema>;
export type PublicTournamentMatch = z.infer<typeof matchSchema>;
