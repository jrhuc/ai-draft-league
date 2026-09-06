import { z } from "zod";

import { isRejection } from "./draft.js";
import { commitRunArtifact, readRunArtifacts } from "./run-artifact-store.js";
import {
  applyFreeAgency,
  applyTradeOffer,
  commitRosterState,
  parseTradeDecision,
  rosterStateCopy,
  type TradeOffer,
  type TradeWindowArtifact,
  type TradeWindowDecision,
  type TradeWindowRoster,
  type TradeWindowState,
  validateLeagueRosterState,
} from "./trade-window-protocol.js";
import type { JsonValue } from "./types.js";

const WINDOW_NAMESPACE = "transaction-window";

export function transactionEventNamespace(afterWeek: number): string {
  return `transaction-event:${afterWeek}`;
}

const seatSchema = z.number().int().nonnegative();
const offerEventSchema = z.strictObject({
  kind: z.literal("offer"),
  model: z.string(),
  from: seatSchema,
  to: seatSchema.nullable(),
  give: z.string().nullable(),
  get: z.string().nullable(),
  message: z.string().nullable(),
  accepted: z.boolean().nullable(),
  proposerFallback: z.boolean(),
  responderFallback: z.boolean().nullable(),
  offerReasoning: z.string(),
  responseReasoning: z.string(),
  timestamp: z.string(),
});
const freeAgencyEventSchema = z.strictObject({
  kind: z.literal("free_agency"),
  entrant: seatSchema,
  model: z.string(),
  swaps: z.array(z.strictObject({ drop: z.string(), add: z.string() })),
  reasoning: z.string(),
  fallback: z.boolean(),
  timestamp: z.string(),
});
const eventSchema = z.discriminatedUnion("kind", [offerEventSchema, freeAgencyEventSchema]);

const tradeWindowArtifactSchema = z.object({
  after_week: seatSchema,
  order: z.array(seatSchema),
  offers: z.array(
    z.object({
      from: seatSchema,
      to: seatSchema.nullable(),
      give: z.string().nullable(),
      get: z.string().nullable(),
      message: z.string().nullable(),
      accepted: z.boolean().nullable(),
      proposerFallback: z.boolean(),
      responderFallback: z.boolean().nullable(),
      offerReasoning: z.string(),
      responseReasoning: z.string(),
    }),
  ),
  decisions: z.array(
    z.object({
      entrant: seatSchema,
      model: z.string(),
      swaps: z.array(z.object({ drop: z.string(), add: z.string() })),
      reasoning: z.string(),
      fallback: z.boolean(),
    }),
  ),
  rosters: z.array(
    z.object({
      entrant: seatSchema,
      model: z.string(),
      team_name: z.string(),
      budget_left: z.number(),
      spent: z.number(),
      roster: z.array(z.object({ id: z.string(), name: z.string(), cost: z.number() })),
    }),
  ),
  swaps_used: z.array(seatSchema),
});

interface WindowReplay {
  offers: TradeOffer[];
  decisions: TradeWindowDecision[];
}

/** Applies the committed events of one window to `state`, in the seat order the window ran in. */
export function replayWindowEvents(
  events: readonly JsonValue[],
  order: readonly number[],
  state: TradeWindowState,
  tradesAllowed: number,
): WindowReplay {
  const rows = events.map((event) => eventSchema.parse(event));
  const firstDecision = rows.findIndex((row) => row.kind === "free_agency");
  const offerRows = firstDecision === -1 ? rows : rows.slice(0, firstDecision);
  const decisionRows = firstDecision === -1 ? [] : rows.slice(firstDecision);
  const offers: TradeOffer[] = [];
  let cursor = 0;
  for (const entrant of order) {
    let made = 0;
    while (made < tradesAllowed && cursor < offerRows.length) {
      const row = offerRows[cursor]!;
      if (row.kind !== "offer" || row.from !== entrant || row.model !== state.models[entrant]) {
        throw new Error(`transaction event ${cursor + 1} does not match the window order`);
      }
      const { kind: _kind, model: _model, timestamp: _timestamp, ...offer } = row;
      offers.push(offer);
      cursor += 1;
      if (offer.to === null) break;
      const next = applyTradeOffer(state, {
        from: entrant,
        to: offer.to,
        give: offer.give!,
        get: offer.get!,
        accepted: offer.accepted === true,
      });
      validateLeagueRosterState(next, `roster after replayed offer ${cursor}`);
      commitRosterState(state, next);
      made += 1;
    }
  }
  if (cursor !== offerRows.length) {
    throw new Error(`transaction event ${cursor + 1} does not match the window offer order`);
  }
  const decisions: TradeWindowDecision[] = [];
  for (const [index, row] of decisionRows.entries()) {
    const entrant = order[index];
    if (
      row.kind !== "free_agency" ||
      entrant === undefined ||
      row.entrant !== entrant ||
      row.model !== state.models[entrant]
    ) {
      throw new Error(`free-agency event ${index + 1} does not match the window order`);
    }
    const parsed = parseTradeDecision(
      JSON.stringify({ swaps: row.swaps, reasoning: row.reasoning }),
      state,
      entrant,
    );
    if (isRejection(parsed)) {
      throw new Error(`free-agency event ${index + 1} is not a legal decision: ${parsed}`);
    }
    const next = applyFreeAgency(state, entrant, parsed.swaps);
    validateLeagueRosterState(next, `roster after replayed free agency ${index + 1}`);
    commitRosterState(state, next);
    decisions.push({
      entrant,
      model: row.model,
      swaps: parsed.swaps,
      reasoning: parsed.reasoning,
      fallback: row.fallback,
    });
  }
  return { offers, decisions };
}

/** Puts a completed window's rosters, budgets, and swap counts onto `state`. */
export function adoptWindowArtifact(state: TradeWindowState, artifact: TradeWindowArtifact): void {
  const monById = new Map(state.board.mons.map((mon) => [mon.id, mon] as const));
  const next = rosterStateCopy(state);
  for (const stored of artifact.rosters) {
    next.rosters[stored.entrant] = stored.roster.map(({ id }) => {
      const mon = monById.get(id);
      if (!mon) throw new Error(`transaction artifact names unknown board id ${id}`);
      return mon;
    });
    next.budgets[stored.entrant] = stored.budget_left;
  }
  next.swapsUsed.splice(0, next.swapsUsed.length, ...artifact.swaps_used);
  commitRosterState(state, next);
}

export function rosterArtifact(state: TradeWindowState): TradeWindowRoster[] {
  return state.models.map((model, entrant) => ({
    entrant,
    model,
    team_name: state.teamNames[entrant]!,
    budget_left: state.budgets[entrant]!,
    spent: state.board.budget - state.budgets[entrant]!,
    roster: state.rosters[entrant]!.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
  }));
}

export function commitTradeWindowArtifact(runDir: string, artifact: TradeWindowArtifact): void {
  commitRunArtifact(
    runDir,
    WINDOW_NAMESPACE,
    String(artifact.after_week).padStart(6, "0"),
    artifact,
  );
}

export function readTradeWindowArtifacts(runDir: string): TradeWindowArtifact[] {
  return readRunArtifacts(runDir, WINDOW_NAMESPACE).map(({ value }) =>
    tradeWindowArtifactSchema.parse(value),
  );
}

export function readTradeWindowArtifact(
  runDir: string,
  afterWeek: number,
): TradeWindowArtifact | undefined {
  return readTradeWindowArtifacts(runDir).find((artifact) => artifact.after_week === afterWeek);
}

export function readTransactionEvents(runDir: string, afterWeek: number): JsonValue[] {
  return readRunArtifacts(runDir, transactionEventNamespace(afterWeek)).map(({ value }) => value);
}
