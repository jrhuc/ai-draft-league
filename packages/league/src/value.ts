import type { JsonObject, JsonValue } from "./types.js";

export function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

export function asRecord(value: JsonValue | undefined): JsonObject {
  return isRecord(value) ? value : {};
}

export function asRecords(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function count(value: JsonValue | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asStrings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter(isText) : [];
}

export function text(value: JsonValue | undefined, fallback = ""): string {
  return isText(value) ? value : fallback;
}

export function isErrnoCode(cause: unknown, code: string): cause is Error & { code: string } {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

export function afterColon(value: string): string {
  const separator = value.indexOf(": ");
  return separator < 0 ? value : value.slice(separator + 2);
}

export function ordinal(rank: number): string {
  const suffix =
    rank % 10 === 1 && rank !== 11
      ? "st"
      : rank % 10 === 2 && rank !== 12
        ? "nd"
        : rank % 10 === 3 && rank !== 13
          ? "rd"
          : "th";
  return `${rank}${suffix}`;
}

export function fileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "model"
  );
}

/** Doom-loop backstop, not a content budget: limits should be set far above real traffic, and any
 * clipping must stay visible to the model and in traces rather than silently amputating content. */
export function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)} [clipped]`;
}
