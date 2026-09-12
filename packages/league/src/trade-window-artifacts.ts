import { z } from "zod";

import type { DraftBoard, DraftBoardMon } from "./draft.js";
import { commitRunArtifact, readRunArtifacts } from "./run-artifact-store.js";
import {
  applyFreeAgency,
  applyTradeOffer,
  commitRosterState,
  rosterStateCopy,
  type TradeOffer,
  type TradeWindowArtifact,
  type TradeWindowDecision,
  type TradeWindowRoster,
  type TradeWindowState,
  validateLeagueRosterState,
  validateRosterAssets,
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
    const next = applyFreeAgency(state, entrant, row.swaps);
    commitRosterState(state, next);
    decisions.push({ entrant, model: row.model, swaps: row.swaps, reasoning: row.reasoning });
  }
  return { offers, decisions };
}

export interface WindowRoster {
  entrant: number;
  roster: DraftBoardMon[];
  budget: number;
}

export function windowRosters(
  artifact: TradeWindowArtifact,
  board: DraftBoard,
  models: readonly string[],
): WindowRoster[] {
  const context = `transaction artifact after week ${artifact.after_week}`;
  const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
  const rows = models.map((model, entrant) => {
    const stored = artifact.rosters.filter((row) => row.entrant === entrant);
    if (stored.length !== 1)
      throw new Error(`${context} has ${stored.length} roster rows for entrant ${entrant}`);
    const row = stored[0]!;
    if (row.model !== model)
      throw new Error(`${context} stores entrant ${entrant} as ${row.model}, not ${model}`);
    if (row.spent !== board.budget - row.budget_left)
      throw new Error(`${context} entrant ${entrant} spent and budget_left disagree`);
    const roster = row.roster.map(({ id, name, cost }) => {
      const mon = monById.get(id);
      if (!mon || mon.name !== name || mon.cost !== cost)
        throw new Error(`${context} entrant ${entrant} names unknown board asset ${id}`);
      return mon;
    });
    return { entrant, roster, budget: row.budget_left };
  });
  if (artifact.rosters.length !== rows.length)
    throw new Error(`${context} stores rosters for unknown entrants`);
  validateRosterAssets(
    board,
    rows.map((row) => row.roster),
    rows.map((row) => row.budget),
    context,
  );
  return rows;
}

/** Puts a completed window's rosters, budgets, and swap counts onto `state`. */
export function adoptWindowArtifact(state: TradeWindowState, artifact: TradeWindowArtifact): void {
  const next = rosterStateCopy(state);
  for (const { entrant, roster, budget } of windowRosters(artifact, state.board, state.models)) {
    next.rosters[entrant] = roster;
    next.budgets[entrant] = budget;
  }
  next.swapsUsed.splice(0, next.swapsUsed.length, ...artifact.swaps_used);
  validateLeagueRosterState(next, `adopted transaction artifact after week ${artifact.after_week}`);
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
