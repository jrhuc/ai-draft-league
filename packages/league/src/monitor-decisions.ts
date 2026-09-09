import type { JsonObject } from "./types.js";
import { asRecord, count, text } from "./value.js";

export interface Spread {
  median: number;
  p90: number;
  max: number;
}

export interface SeatDecisionStats {
  label: string;
  decisions: number;
  automatic: number;
  fallbacks: number;
  substitutions: number;
  parseFailureDecisions: number;
  notebookUpdates: number;
  toolQueries: Spread;
  latencySeconds: Spread;
  totalTokens: Spread;
  reflections: number;
  reflectionFallbacks: number;
}

export function spread(values: readonly number[]): Spread {
  if (!values.length) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
  return { median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}

function queryCount(value: JsonObject["tool_lookups"]): number {
  return Array.isArray(value) ? value.length : count(value);
}

export function seatDecisionStats(label: string, rows: readonly JsonObject[]): SeatDecisionStats {
  const decisions = rows.filter((row) => row.kind === "decision");
  const modelDecisions = decisions.filter((row) => row.automatic !== true);
  const reflections = rows.filter((row) => row.kind === "game_reflection");
  return {
    label,
    decisions: decisions.length,
    automatic: decisions.length - modelDecisions.length,
    fallbacks: modelDecisions.filter((row) => row.fallback === true).length,
    substitutions: modelDecisions.filter(
      (row) => row.fallback !== true && text(row.submission_source) === "model-default",
    ).length,
    parseFailureDecisions: modelDecisions.filter((row) => count(row.parse_failures) > 0).length,
    notebookUpdates: modelDecisions.filter(
      (row) => asRecord(row.evidence_supplied).notebook_update === true,
    ).length,
    toolQueries: spread(modelDecisions.map((row) => queryCount(row.tool_lookups))),
    latencySeconds: spread(modelDecisions.map((row) => Math.round(count(row.latency_ms) / 1000))),
    totalTokens: spread(modelDecisions.map((row) => count(row.total_tokens))),
    reflections: reflections.length,
    reflectionFallbacks: reflections.filter((row) => row.fallback === true).length,
  };
}
