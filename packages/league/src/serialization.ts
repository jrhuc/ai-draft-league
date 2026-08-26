import type { JsonObject, JsonValue } from "./types.js";
import { isRecord } from "./value.js";

function normalize(value: JsonValue | undefined, location: string): JsonValue {
  if (value === undefined) throw new Error(`${location} is undefined`);
  if (Array.isArray(value))
    return value.map((entry, index) => normalize(entry, `${location}[${index}]`));
  if (isRecord(value)) {
    const normalized: JsonObject = {};
    for (const key of Object.keys(value).sort())
      normalized[key] = normalize(value[key], `${location}.${key}`);
    return normalized;
  }
  if (Object.is(value, -0)) return 0;
  if (
    Number.isNaN(value) ||
    value === Number.POSITIVE_INFINITY ||
    value === Number.NEGATIVE_INFINITY
  ) {
    throw new Error(`${location} contains a non-finite number`);
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value, "$"));
}
