import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { writeAtomicJson } from "./atomic-json.js";
import { isRejection } from "./draft.js";
import { canonicalJson } from "./serialization.js";
import {
  applyFreeAgency,
  applyTradeOffer,
  commitRosterState,
  parseTradeDecision,
  rationaleOf,
  rosterStateCopy,
  TRADE_OFFER_PROMPT_POLICY,
  type TradeOffer,
  type TradeWindowArtifact,
  type TradeWindowDecision,
  type TradeWindowRoster,
  type TradeWindowState,
  validateLeagueRosterState,
  validateTradesAllowed,
} from "./trade-window-protocol.js";
import type { JsonValue } from "./types.js";
import { clip, isErrnoCode, text } from "./value.js";

export interface TradeOfferLogRow extends TradeOffer {
  kind: "offer";
  model: string;
}

export interface WindowReplay {
  offers: TradeOffer[];
  offerRows: TradeOfferLogRow[];
  decisions: TradeWindowDecision[];
  offersComplete: boolean;
}

export interface TransactionEpochArtifacts {
  afterWeek: number;
  epochDir: string;
  artifact: TradeWindowArtifact | undefined;
  inProgress: boolean;
}

const jsonValueSchema = z.json();
const physicalWindowValueSchema = z.record(z.string(), jsonValueSchema);
type PhysicalWindowValue = z.output<typeof physicalWindowValueSchema>;

interface PhysicalWindowRow {
  line: number;
  value: PhysicalWindowValue;
}

const noOfferEvidenceSchema = z.object({
  proposerFallback: z.boolean(),
  responderFallback: z.null(),
});
const completeOfferEvidenceSchema = z.object({
  proposerFallback: z.boolean(),
  responderFallback: z.boolean(),
});
const completeOfferFieldsSchema = z.object({
  to: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  give: z.string(),
  get: z.string(),
  message: z.string().min(1),
  accepted: z.boolean(),
  responseReasoning: z.string(),
});
const freeAgencyFieldsSchema = z.object({
  swaps: z.array(jsonValueSchema),
  reasoning: z.string(),
  fallback: z.boolean(),
});
const physicalSwapSchema = z
  .object({
    drop: jsonValueSchema.optional(),
    add: jsonValueSchema.optional(),
  })
  .catchall(jsonValueSchema);
const completeSwapSchema = z.object({ drop: z.string(), add: z.string() });

const TRANSACTION_PATH_ENTRIES = ["window.json", "window.jsonl", "window"] as const;
const OFFER_ROW_KEYS = [
  "kind",
  "model",
  "from",
  "to",
  "give",
  "get",
  "message",
  "accepted",
  "proposerFallback",
  "responderFallback",
  "offerReasoning",
  "responseReasoning",
  "timestamp",
] as const;

export function transactionEpochDir(runDir: string, afterWeek: number): string {
  return path.join(runDir, "transactions", `after-week-${afterWeek}`);
}

function requireRegularEntry(file: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return false;
    throw cause;
  }
  if (stats.isSymbolicLink()) throw new Error(`${file} must not be a symbolic link`);
  return true;
}

export function epochArtifactPaths(epochDir: string): string[] {
  return TRANSACTION_PATH_ENTRIES.filter((entry) =>
    requireRegularEntry(path.join(epochDir, entry)),
  );
}

export function transactionArtifactPaths(runDir: string): string[] {
  const present = epochArtifactPaths(runDir);
  const root = path.join(runDir, "transactions");
  if (!requireRegularEntry(root)) return present;
  for (const entry of fs.readdirSync(root).sort()) {
    for (const file of epochArtifactPaths(path.join(root, entry)))
      present.push(path.join("transactions", entry, file));
  }
  return present;
}

function transactionEpochDirs(runDir: string): string[] {
  const root = path.join(runDir, "transactions");
  if (!requireRegularEntry(root)) return epochArtifactPaths(runDir).length ? [runDir] : [];
  return fs
    .readdirSync(root)
    .filter((entry) => /^after-week-\d+$/u.test(entry))
    .sort((a, b) => Number(a.slice("after-week-".length)) - Number(b.slice("after-week-".length)))
    .map((entry) => path.join(root, entry));
}

function windowLineError(file: string, line: number, message: string): Error {
  return new Error(`${file} line ${line} ${message}`);
}

function requireExactKeys(
  file: string,
  line: number,
  value: PhysicalWindowValue,
  keys: readonly string[],
  context: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !expected.has(key));
  if (missing.length || extra.length || actual.length !== keys.length) {
    throw windowLineError(
      file,
      line,
      `${context} must have exactly the current schema keys (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
}

function requireWindowTimestamp(file: string, row: PhysicalWindowRow): void {
  const timestamp = text(row.value.timestamp);
  if (!timestamp) throw windowLineError(file, row.line, "has an invalid timestamp");
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw windowLineError(file, row.line, "has a non-canonical timestamp");
  }
}

function validateLoggedRationale(
  file: string,
  line: number,
  context: string,
  rationale: JsonValue | undefined,
  limit: number,
): string {
  const canonical = rationaleOf(rationale, limit);
  if (rationale !== canonical)
    throw windowLineError(file, line, `${context} has a non-canonical rationale`);
  return canonical;
}

export function replayWindowLog(
  file: string,
  order: readonly number[],
  state: TradeWindowState,
  tradesAllowed: number,
): WindowReplay {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) {
      return { offers: [], offerRows: [], decisions: [], offersComplete: tradesAllowed === 0 };
    }
    throw cause;
  }
  if (!raw.endsWith("\n")) throw new Error(`${file} must be nonblank and end with a newline`);
  const rows: PhysicalWindowRow[] = raw
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      if (!line.trim()) throw windowLineError(file, index + 1, "must be a nonblank JSON object");
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new Error(`${file} line ${index + 1} is not valid JSON`, { cause });
      }
      if (line !== canonicalJson(parsed)) {
        throw windowLineError(
          file,
          index + 1,
          "is not canonical JSON; duplicate keys, whitespace, and non-canonical key order are rejected",
        );
      }
      const value = physicalWindowValueSchema.safeParse(parsed);
      if (!value.success) {
        throw windowLineError(file, index + 1, "must be one JSON object");
      }
      if (value.data.kind !== "offer" && value.data.kind !== "free_agency") {
        throw windowLineError(
          file,
          index + 1,
          `has unknown transaction phase ${JSON.stringify(value.data.kind)}`,
        );
      }
      return { line: index + 1, value: value.data };
    });
  let freeAgencyStarted = false;
  for (const row of rows) {
    if (row.value.kind === "free_agency") freeAgencyStarted = true;
    else if (freeAgencyStarted) {
      throw windowLineError(file, row.line, "interleaves an offer after free agency began");
    }
  }
  const firstDecision = rows.findIndex((row) => row.value.kind === "free_agency");
  const offerValues = firstDecision === -1 ? rows : rows.slice(0, firstDecision);
  const decisionValues = firstDecision === -1 ? [] : rows.slice(firstDecision);

  const offerRows: TradeOfferLogRow[] = [];
  let cursor = 0;
  let offersComplete = true;
  offerSeats: for (const entrant of order) {
    let made = 0;
    while (made < tradesAllowed) {
      const physical = offerValues[cursor];
      if (!physical) {
        offersComplete = false;
        break offerSeats;
      }
      const record = physical.value;
      const noOffer = record.to === null;
      requireExactKeys(file, physical.line, record, OFFER_ROW_KEYS, "offer row");
      requireWindowTimestamp(file, physical);
      const model = state.models[entrant]!;
      if (record.kind !== "offer" || record.from !== entrant || record.model !== model) {
        throw windowLineError(
          file,
          physical.line,
          "does not match the trade-window order and proposer identity",
        );
      }
      let proposerFallback: boolean;
      let responderFallback: boolean | null;
      if (noOffer) {
        const evidence = noOfferEvidenceSchema.safeParse(record);
        if (!evidence.success) {
          throw windowLineError(
            file,
            physical.line,
            "has invalid proposer/responder fallback evidence",
          );
        }
        proposerFallback = evidence.data.proposerFallback;
        responderFallback = null;
      } else {
        const evidence = completeOfferEvidenceSchema.safeParse(record);
        if (!evidence.success) {
          throw windowLineError(
            file,
            physical.line,
            "has invalid proposer/responder fallback evidence",
          );
        }
        proposerFallback = evidence.data.proposerFallback;
        responderFallback = evidence.data.responderFallback;
      }
      const offerReasoning = validateLoggedRationale(
        file,
        physical.line,
        "offer",
        record.offerReasoning,
        TRADE_OFFER_PROMPT_POLICY.rationaleLimit,
      );
      if (noOffer) {
        if (
          record.to !== null ||
          record.give !== null ||
          record.get !== null ||
          record.message !== null ||
          record.accepted !== null ||
          record.responseReasoning !== ""
        ) {
          throw windowLineError(
            file,
            physical.line,
            "has an inconsistent no-offer/no-response record",
          );
        }
        const offer: TradeOffer = {
          from: entrant,
          to: null,
          give: null,
          get: null,
          message: null,
          accepted: null,
          proposerFallback,
          responderFallback,
          offerReasoning,
          responseReasoning: "",
        };
        offerRows.push({ kind: "offer", model, ...offer });
        cursor += 1;
        continue offerSeats;
      }
      const fields = completeOfferFieldsSchema.safeParse(record);
      if (!fields.success) {
        throw windowLineError(file, physical.line, "has invalid offer/response field types");
      }
      const { to, give, get, message, accepted } = fields.data;
      if (
        message !==
        clip(message.trim().replace(/\s+/g, " "), TRADE_OFFER_PROMPT_POLICY.messageLimit)
      ) {
        throw windowLineError(file, physical.line, "has a non-canonical public message");
      }
      const responseReasoning = validateLoggedRationale(
        file,
        physical.line,
        "offer response",
        fields.data.responseReasoning,
        TRADE_OFFER_PROMPT_POLICY.rationaleLimit,
      );
      const offer: TradeOffer = {
        from: entrant,
        to,
        give,
        get,
        message,
        accepted,
        proposerFallback,
        responderFallback,
        offerReasoning,
        responseReasoning,
      };
      let nextState: TradeWindowState;
      try {
        nextState = applyTradeOffer(state, { from: entrant, to, give, get, accepted });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw windowLineError(file, physical.line, reason);
      }
      validateLeagueRosterState(
        nextState,
        `roster after replayed offer at ${file} line ${physical.line}`,
      );
      commitRosterState(state, nextState);
      offerRows.push({ kind: "offer", model, ...offer });
      cursor += 1;
      made += 1;
    }
  }
  if (cursor !== offerValues.length) {
    const extra = offerValues[cursor]!;
    throw windowLineError(file, extra.line, "does not match the trade-window offer order");
  }
  if (decisionValues.length && !offersComplete) {
    throw windowLineError(
      file,
      decisionValues[0]!.line,
      "begins free agency before every coach completed the offer phase",
    );
  }

  const decisions: TradeWindowDecision[] = [];
  for (const [index, physical] of decisionValues.entries()) {
    const record = physical.value;
    requireExactKeys(
      file,
      physical.line,
      record,
      ["kind", "entrant", "model", "swaps", "reasoning", "fallback", "timestamp"],
      "free-agency row",
    );
    requireWindowTimestamp(file, physical);
    const entrant = order[index];
    if (
      entrant === undefined ||
      record.kind !== "free_agency" ||
      record.entrant !== entrant ||
      record.model !== state.models[entrant]
    ) {
      throw windowLineError(
        file,
        physical.line,
        "does not match the trade-window free-agency order and identity",
      );
    }
    const fields = freeAgencyFieldsSchema.safeParse(record);
    if (!fields.success) {
      throw windowLineError(file, physical.line, "has invalid free-agency field types");
    }
    for (const [swapIndex, value] of fields.data.swaps.entries()) {
      const rawSwap = physicalSwapSchema.safeParse(value);
      if (!rawSwap.success) {
        throw windowLineError(file, physical.line, `has a non-object swap ${swapIndex + 1}`);
      }
      requireExactKeys(
        file,
        physical.line,
        rawSwap.data,
        ["drop", "add"],
        `free-agency swap ${swapIndex + 1}`,
      );
      if (!completeSwapSchema.safeParse(rawSwap.data).success) {
        throw windowLineError(file, physical.line, `has invalid swap ${swapIndex + 1} field types`);
      }
    }
    const parsed = parseTradeDecision(
      JSON.stringify({ swaps: fields.data.swaps, reasoning: fields.data.reasoning }),
      state,
      entrant,
    );
    if (isRejection(parsed)) {
      throw windowLineError(file, physical.line, `has an invalid free-agency decision: ${parsed}`);
    }
    if (
      !isDeepStrictEqual(parsed.swaps, fields.data.swaps) ||
      parsed.reasoning !== fields.data.reasoning
    ) {
      throw windowLineError(file, physical.line, "is not in canonical transaction form");
    }
    const nextState = applyFreeAgency(state, entrant, parsed.swaps);
    validateLeagueRosterState(
      nextState,
      `roster after replayed free-agency decision at ${file} line ${physical.line}`,
    );
    commitRosterState(state, nextState);
    decisions.push({
      entrant,
      model: state.models[entrant]!,
      swaps: parsed.swaps,
      reasoning: parsed.reasoning,
      fallback: fields.data.fallback,
    });
  }
  return {
    offers: offerRows.map(({ kind: _kind, model: _model, ...offer }) => offer),
    offerRows,
    decisions,
    offersComplete,
  };
}

const safeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const tradeOfferArtifactSchema = z
  .object({
    from: safeIntegerSchema,
    to: safeIntegerSchema.nullable(),
    give: z.string().nullable(),
    get: z.string().nullable(),
    message: z.string().nullable(),
    accepted: z.boolean().nullable(),
    proposerFallback: z.boolean(),
    responderFallback: z.boolean().nullable(),
    offerReasoning: z.string(),
    responseReasoning: z.string(),
  })
  .catchall(jsonValueSchema);
const tradeDecisionArtifactSchema = z
  .object({
    entrant: safeIntegerSchema,
    model: z.string(),
    swaps: z.array(z.object({ drop: z.string(), add: z.string() }).catchall(jsonValueSchema)),
    reasoning: z.string(),
    fallback: z.boolean(),
  })
  .catchall(jsonValueSchema);
const tradeWindowRosterSchema = z
  .object({
    entrant: safeIntegerSchema,
    model: z.string(),
    team_name: z.string(),
    budget_left: z.number(),
    spent: z.number(),
    roster: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          cost: z.number(),
        })
        .catchall(jsonValueSchema),
    ),
  })
  .catchall(jsonValueSchema);
export const storedRosterSchema = tradeWindowRosterSchema.extend({
  entrant: safeIntegerSchema.optional(),
});
const tradeWindowArtifactSchema = z
  .object({
    after_week: safeIntegerSchema,
    order: z.array(safeIntegerSchema),
    offers: z.array(tradeOfferArtifactSchema),
    decisions: z.array(tradeDecisionArtifactSchema),
    rosters: z.array(tradeWindowRosterSchema),
    swaps_used: z.array(safeIntegerSchema).optional().catch(undefined),
  })
  .catchall(jsonValueSchema);

export function readTradeWindowFile(epochDir: string): TradeWindowArtifact | undefined {
  const file = path.join(epochDir, "window.json");
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw new Error(`${file} is not valid JSON`, { cause });
  }
  const artifact = tradeWindowArtifactSchema.safeParse(parsed);
  if (!artifact.success) {
    throw new Error(`${file} is not a complete transaction artifact`);
  }
  return artifact.data;
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

export function replayArtifact(
  afterWeek: number,
  order: readonly number[],
  replay: WindowReplay,
  state: TradeWindowState,
): TradeWindowArtifact {
  return {
    after_week: afterWeek,
    order: [...order],
    offers: replay.offers,
    decisions: replay.decisions,
    rosters: rosterArtifact(state),
    swaps_used: [...state.swapsUsed],
  };
}

export function requireCompletedReplay(
  file: string,
  artifact: TradeWindowArtifact,
  expected: TradeWindowArtifact,
  replay: WindowReplay,
): void {
  if (!replay.offersComplete || replay.decisions.length !== expected.order.length) {
    throw new Error(
      `${file} claims a completed transaction window but its ordered log is incomplete`,
    );
  }
  if (!isDeepStrictEqual(artifact, expected)) {
    throw new Error(`${file} does not equal the authoritative ordered replay of window.jsonl`);
  }
}

export function readValidatedTradeWindow(
  epochDir: string,
  initialState: TradeWindowState,
  options: { afterWeek: number; tradesAllowed: number },
): TradeWindowArtifact | undefined {
  validateTradesAllowed(options.tradesAllowed);
  epochArtifactPaths(epochDir);
  const artifact = readTradeWindowFile(epochDir);
  if (!artifact) return undefined;
  validateLeagueRosterState(initialState, "initial roster for completed transaction overlay");
  const state = rosterStateCopy(initialState);
  const order = state.standings.map((row) => row.entrant).reverse();
  const replay = replayWindowLog(
    path.join(epochDir, "window.jsonl"),
    order,
    state,
    options.tradesAllowed,
  );
  const expected = replayArtifact(options.afterWeek, order, replay, state);
  requireCompletedReplay(path.join(epochDir, "window.json"), artifact, expected, replay);
  return artifact;
}

export function writeTradeWindowArtifact(epochDir: string, artifact: TradeWindowArtifact): string {
  const artifactFile = path.join(epochDir, "window.json");
  writeAtomicJson(artifactFile, artifact, 2);
  return artifactFile;
}

export function readTradeWindow(epochDir: string): TradeWindowArtifact | undefined {
  epochArtifactPaths(epochDir);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(epochDir, "window.json"), "utf8"));
  } catch {
    return undefined;
  }
  const artifact = tradeWindowArtifactSchema.safeParse(parsed);
  return artifact.success ? artifact.data : undefined;
}

export function readTransactionEpochs(runDir: string): TransactionEpochArtifacts[] {
  return transactionEpochDirs(runDir).map((epochDir) => {
    const artifact = readTradeWindow(epochDir);
    const afterWeek =
      artifact?.after_week ?? (Number(path.basename(epochDir).slice("after-week-".length)) || 0);
    return {
      afterWeek,
      epochDir,
      artifact,
      inProgress: !artifact && requireRegularEntry(path.join(epochDir, "window.jsonl")),
    };
  });
}

export function readCurrentRosterArtifact(runDir: string): TradeWindowRoster[] | undefined {
  const windows = readTransactionEpochs(runDir).flatMap(({ artifact }) =>
    artifact ? [artifact] : [],
  );
  const latest = windows.at(-1);
  if (latest) return latest.rosters;
  try {
    const rosters = z
      .array(storedRosterSchema)
      .safeParse(JSON.parse(fs.readFileSync(path.join(runDir, "rosters.json"), "utf8")));
    return rosters.success
      ? rosters.data.map((roster, entrant) => ({ ...roster, entrant: roster.entrant ?? entrant }))
      : undefined;
  } catch {
    return undefined;
  }
}
