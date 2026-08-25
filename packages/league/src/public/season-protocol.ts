import { z } from 'zod';

const id = z.string().min(1);
const franchiseRef = z.string().regex(/^franchise-\d+$/);

const pokemonSchema = z.strictObject({ id, name: id, spriteId: id, cost: z.number().int().nonnegative() });
const rosterSlotSchema = pokemonSchema.extend({
  acquired: z.enum(['draft', 'trade', 'free-agency']),
  overallPick: z.number().int().positive().nullable(),
  rationale: z.string(),
  fallback: z.boolean(),
});
const recordSchema = z.strictObject({
  seriesWins: z.number().int().nonnegative(),
  seriesLosses: z.number().int().nonnegative(),
  gameWins: z.number().int().nonnegative(),
  gameLosses: z.number().int().nonnegative(),
});
const setSchema = z.strictObject({
  species: id,
  spriteId: id,
  item: z.string(),
  ability: z.string(),
  nature: z.string(),
  moves: z.array(z.string()),
  evs: z.record(z.string(), z.number().int().nonnegative()),
});
const buildSchema = z.strictObject({
  franchiseId: franchiseRef,
  prepared: z.array(id),
  /** Null while the season's sheet policy keeps this build closed. */
  sets: z.array(setSchema).nullable(),
  rationale: z.string(),
  /** Zero when the seat made no provider attempt, as a random seat does. */
  attempts: z.number().int().nonnegative(),
});
const slotRefSchema = z.strictObject({
  side: z.union([z.literal(0), z.literal(1)]),
  slot: z.number().int().nonnegative(),
});
const eventSchema = z.strictObject({
  turn: z.number().int().nonnegative(),
  kind: z.enum(['turn', 'move', 'switch', 'faint', 'status', 'field', 'win', 'timer', 'detail', 'preview']),
  text: z.string(),
  actor: slotRefSchema.optional(),
  target: slotRefSchema.optional(),
  species: z.string().optional(),
  hp: z.number().int().min(0).max(100).optional(),
  status: z.string().nullable().optional(),
});
const decisionSchema = z.strictObject({
  franchiseId: franchiseRef,
  turn: z.number().int().nonnegative(),
  phase: z.string(),
  action: z.string(),
  rationale: z.string(),
  fallback: z.boolean(),
  automatic: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});
const reflectionSchema = z.strictObject({
  franchiseId: franchiseRef,
  result: z.enum(['won', 'lost']),
  summary: z.string(),
  adjustment: z.string(),
  fallback: z.boolean(),
});
const gameSummarySchema = z.strictObject({
  number: z.number().int().positive(),
  winnerId: franchiseRef.nullable(),
  turns: z.number().int().nonnegative(),
  brought: z.tuple([z.array(z.string()), z.array(z.string())]),
  megaEvolved: z.tuple([z.string().nullable(), z.string().nullable()]),
  faints: z.tuple([
    z.record(z.string(), z.number().int().nonnegative()),
    z.record(z.string(), z.number().int().nonnegative()),
  ]),
});
const matchSchema = z.strictObject({
  id,
  seriesIndex: z.number().int().nonnegative(),
  seriesId: id.nullable(),
  franchises: z.tuple([franchiseRef, franchiseRef]),
  status: z.enum(['scheduled', 'complete']),
  score: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable(),
  winnerId: franchiseRef.nullable(),
  games: z.array(gameSummarySchema),
  builds: z.array(buildSchema),
});
const weeklyReviewSchema = z.strictObject({
  week: z.number().int().positive(),
  stage: z.enum(['week', 'transactions']),
  franchiseId: franchiseRef,
  rosterVersion: z.number().int().nonnegative(),
  reasoning: z.string(),
  /** Size of the memory the review left behind; the pages themselves stay private. */
  memoryPages: z.number().int().nonnegative(),
  memoryCharacters: z.number().int().nonnegative(),
  fallback: z.boolean(),
});

export const publicSeasonBundleSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  season: z.strictObject({
    id,
    title: id,
    format: id,
    board: z.strictObject({
      id,
      budget: z.number().int().nonnegative(),
      picksPerFranchise: z.number().int().nonnegative(),
    }),
    startedAt: z.iso.datetime(),
    status: z.enum(['draft', 'regular-season', 'playoffs', 'complete']),
    releasedThroughWeek: z.number().int().nonnegative(),
    releasedPlayoffRounds: z.number().int().nonnegative(),
    totalWeeks: z.number().int().nonnegative(),
    playoffRounds: z.number().int().nonnegative(),
    sheets: z.enum(['open', 'closed']),
    /** Free-agent swaps each franchise may spend across the season's windows; null when unknown. */
    swapsAllowed: z.number().int().nonnegative().nullable(),
    championId: franchiseRef.nullable(),
  }),
  provenance: z.strictObject({
    showdownCommit: z.string().nullable(),
    models: z.array(z.strictObject({ franchiseId: franchiseRef, spec: z.string() })),
  }),
  franchises: z.array(
    z.strictObject({
      id: franchiseRef,
      name: id,
      model: z.string(),
      budget: z.strictObject({
        total: z.number().int().nonnegative(),
        spent: z.number().int().nonnegative(),
        remaining: z.number().int(),
      }),
      roster: z.array(rosterSlotSchema),
      record: recordSchema,
      /** Set only once the season is complete and released. */
      finish: z.string().nullable(),
    }),
  ),
  board: z.array(
    z.strictObject({
      id,
      name: id,
      spriteId: id,
      cost: z.number().int().nonnegative(),
      types: z.array(z.string()),
      abilities: z.array(z.string()),
      baseStats: z.record(z.string(), z.number().int()),
      megaStone: z.string().nullable(),
      draftedBy: franchiseRef.nullable(),
    }),
  ),
  draft: z.strictObject({
    picks: z.array(
      z.strictObject({
        overall: z.number().int().positive(),
        round: z.number().int().positive(),
        franchiseId: franchiseRef,
        pokemon: pokemonSchema,
        rationale: z.string(),
        fallback: z.boolean(),
      }),
    ),
  }),
  standings: z.array(
    recordSchema.extend({
      rank: z.number().int().positive(),
      franchiseId: franchiseRef,
      differential: z.number().int(),
    }),
  ),
  weeks: z.array(
    z.strictObject({
      number: z.number().int().positive(),
      status: z.enum(['released', 'scheduled']),
      matches: z.array(matchSchema),
    }),
  ),
  transactions: z.array(
    z.strictObject({
      afterWeek: z.number().int().positive(),
      order: z.array(franchiseRef),
      offers: z.array(
        z.strictObject({
          from: franchiseRef,
          to: franchiseRef.nullable(),
          give: z.string().nullable(),
          get: z.string().nullable(),
          message: z.string().nullable(),
          accepted: z.boolean().nullable(),
          offerReasoning: z.string(),
          responseReasoning: z.string(),
        }),
      ),
      moves: z.array(
        z.strictObject({
          franchiseId: franchiseRef,
          swaps: z.array(z.strictObject({ drop: z.string(), add: z.string() })),
          swapsRemaining: z.number().int().nonnegative().nullable(),
          reasoning: z.string(),
          fallback: z.boolean(),
        }),
      ),
    }),
  ),
  weeklyReviews: z.array(weeklyReviewSchema),
  playoffs: z
    .strictObject({
      rounds: z.array(
        z.array(
          z.strictObject({
            seriesIndex: z.number().int().nonnegative(),
            round: z.number().int().positive(),
            slots: z.tuple([franchiseRef.nullable(), franchiseRef.nullable()]),
            match: matchSchema.nullable(),
          }),
        ),
      ),
    })
    .nullable(),
  replays: z.record(
    id,
    z.strictObject({
      seriesId: id,
      franchises: z.tuple([franchiseRef, franchiseRef]),
      games: z.array(
        gameSummarySchema.extend({
          events: z.array(eventSchema),
          decisions: z.array(decisionSchema),
          reflections: z.array(reflectionSchema),
        }),
      ),
    }),
  ),
  reviews: z.array(
    z.strictObject({
      franchiseId: franchiseRef,
      outcome: z.string(),
      summary: z.string(),
      didWell: z.string(),
      didPoorly: z.string(),
      wouldChange: z.string(),
      fallback: z.boolean(),
    }),
  ),
});

export type PublicSeasonBundle = z.infer<typeof publicSeasonBundleSchema>;
export type PublicMatch = z.infer<typeof matchSchema>;
export type PublicBattleEvent = z.infer<typeof eventSchema>;
export type PublicBuild = z.infer<typeof buildSchema>;
export type PublicWeeklyReview = z.infer<typeof weeklyReviewSchema>;
