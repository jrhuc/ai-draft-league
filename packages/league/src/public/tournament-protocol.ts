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
  /** The four picks for each side, lead pair first, as set ids. */
  brought: z.tuple([z.array(id).length(4), z.array(id).length(4)]),
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

export const publicTournamentBundleSchema = z
  .strictObject({
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
  })
  .superRefine((bundle, context) => {
    const entrantIds = new Set<string>();
    const setIds = new Map<string, Set<string>>();
    for (const [entrantIndex, entrant] of bundle.entrants.entries()) {
      if (entrantIds.has(entrant.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate entrant ${entrant.id}`,
          path: ["entrants", entrantIndex, "id"],
        });
      }
      entrantIds.add(entrant.id);
      const sets = new Set<string>();
      for (const [setIndex, set] of entrant.team.sets.entries()) {
        if (sets.has(set.id)) {
          context.addIssue({
            code: "custom",
            message: `duplicate set ${set.id}`,
            path: ["entrants", entrantIndex, "team", "sets", setIndex, "id"],
          });
        }
        sets.add(set.id);
      }
      setIds.set(entrant.id, sets);
    }
    if (bundle.tournament.championId && !entrantIds.has(bundle.tournament.championId)) {
      context.addIssue({
        code: "custom",
        message: `unknown champion ${bundle.tournament.championId}`,
        path: ["tournament", "championId"],
      });
    }

    const matches = new Map<string, (typeof bundle.bracket.rounds)[number][number]["match"]>();
    for (const [roundIndex, round] of bundle.bracket.rounds.entries()) {
      for (const [slotIndex, slot] of round.entries()) {
        const slotPath = ["bracket", "rounds", roundIndex, slotIndex] as const;
        for (const [side, entrantId] of slot.slots.entries()) {
          if (entrantId && !entrantIds.has(entrantId)) {
            context.addIssue({
              code: "custom",
              message: `unknown entrant ${entrantId}`,
              path: [...slotPath, "slots", side],
            });
          }
        }
        const match = slot.match;
        if (!match) continue;
        if (matches.has(match.seriesId)) {
          context.addIssue({
            code: "custom",
            message: `duplicate series ${match.seriesId}`,
            path: [...slotPath, "match", "seriesId"],
          });
        }
        matches.set(match.seriesId, match);
        if (slot.seriesIndex !== match.seriesIndex) {
          context.addIssue({
            code: "custom",
            message: `series index does not match its bracket slot`,
            path: [...slotPath, "match", "seriesIndex"],
          });
        }
        if (match.entrants.some((entrantId, side) => entrantId !== slot.slots[side])) {
          context.addIssue({
            code: "custom",
            message: `match entrants do not match their bracket slot`,
            path: [...slotPath, "match", "entrants"],
          });
        }
        const winnerSide = match.entrants.indexOf(match.winnerId);
        if (winnerSide < 0) {
          context.addIssue({
            code: "custom",
            message: `match winner is not an entrant`,
            path: [...slotPath, "match", "winnerId"],
          });
        }
        const wins: [number, number] = [0, 0];
        for (const [gameIndex, game] of match.games.entries()) {
          const gamePath = [...slotPath, "match", "games", gameIndex];
          const gameWinnerSide = game.winnerId ? match.entrants.indexOf(game.winnerId) : -1;
          if (game.winnerId && gameWinnerSide < 0) {
            context.addIssue({
              code: "custom",
              message: `game winner is not a match entrant`,
              path: [...gamePath, "winnerId"],
            });
          } else if (gameWinnerSide === 0) {
            wins[0] += 1;
          } else if (gameWinnerSide === 1) {
            wins[1] += 1;
          }
          for (const side of [0, 1] as const) {
            const knownSets = setIds.get(match.entrants[side]) ?? new Set<string>();
            const brought = game.brought[side];
            if (new Set(brought).size !== brought.length) {
              context.addIssue({
                code: "custom",
                message: `team selections must contain 4 unique sets`,
                path: [...gamePath, "brought", side],
              });
            }
            for (const [setIndex, setId] of brought.entries()) {
              if (!knownSets.has(setId)) {
                context.addIssue({
                  code: "custom",
                  message: `selection ${setId} is not registered to this entrant`,
                  path: [...gamePath, "brought", side, setIndex],
                });
              }
            }
            const mega = game.megaEvolved[side];
            if (mega && !knownSets.has(mega)) {
              context.addIssue({
                code: "custom",
                message: `Mega Evolution ${mega} is not registered to this entrant`,
                path: [...gamePath, "megaEvolved", side],
              });
            }
            for (const fainted of Object.keys(game.faints[side])) {
              if (!knownSets.has(fainted)) {
                context.addIssue({
                  code: "custom",
                  message: `fainted set ${fainted} is not registered to this entrant`,
                  path: [...gamePath, "faints", side, fainted],
                });
              }
            }
          }
        }
        if (match.score[0] !== wins[0] || match.score[1] !== wins[1]) {
          context.addIssue({
            code: "custom",
            message: `match score does not equal its game wins`,
            path: [...slotPath, "match", "score"],
          });
        }
        if (
          (winnerSide === 0 && match.score[0] <= match.score[1]) ||
          (winnerSide === 1 && match.score[1] <= match.score[0])
        ) {
          context.addIssue({
            code: "custom",
            message: `match winner does not lead the score`,
            path: [...slotPath, "match", "winnerId"],
          });
        }
      }
    }

    for (const [seriesId, replay] of Object.entries(bundle.replays)) {
      const match = matches.get(seriesId);
      if (replay.seriesId !== seriesId) {
        context.addIssue({
          code: "custom",
          message: `replay key does not match its series id`,
          path: ["replays", seriesId, "seriesId"],
        });
      }
      if (!match) {
        context.addIssue({
          code: "custom",
          message: `replay has no released match`,
          path: ["replays", seriesId],
        });
        continue;
      }
      if (replay.entrants[0] !== match.entrants[0] || replay.entrants[1] !== match.entrants[1]) {
        context.addIssue({
          code: "custom",
          message: `replay entrants do not match the released match`,
          path: ["replays", seriesId, "entrants"],
        });
      }
      if (replay.games.length !== match.games.length) {
        context.addIssue({
          code: "custom",
          message: `replay game count does not match the released match`,
          path: ["replays", seriesId, "games"],
        });
        continue;
      }
      for (const [gameIndex, replayGame] of replay.games.entries()) {
        const { raw, events, decisions, reflections, ...replaySummary } = replayGame;
        void raw;
        void events;
        void decisions;
        void reflections;
        if (JSON.stringify(replaySummary) !== JSON.stringify(match.games[gameIndex])) {
          context.addIssue({
            code: "custom",
            message: `replay summary does not match the released match`,
            path: ["replays", seriesId, "games", gameIndex],
          });
        }
      }
    }
    for (const seriesId of matches.keys()) {
      if (!(seriesId in bundle.replays)) {
        context.addIssue({
          code: "custom",
          message: `released match has no replay`,
          path: ["replays", seriesId],
        });
      }
    }
  });

export type PublicTournamentBundle = z.infer<typeof publicTournamentBundleSchema>;
export type PublicTournamentMatch = z.infer<typeof matchSchema>;
