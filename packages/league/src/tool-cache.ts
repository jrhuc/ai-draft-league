import type { JsonObject, JsonValue } from "./types.js";
import { isRecord } from "./value.js";

type ToolLookup = (name: string, args: JsonObject) => string;

export function toolQueryKey(name: string, args: JsonObject): string {
  return `${name}:${JSON.stringify(args, (_key, value: JsonValue) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  )}`;
}

/** Own one cache per immutable input scope: a decision for live tools, a reference revision for dex tools. */
export function cachedToolLookup(lookup: ToolLookup): ToolLookup {
  const results = new Map<string, string>();
  return (name, args) => {
    const key = toolQueryKey(name, args);
    const result = results.get(key) ?? lookup(name, args);
    results.delete(key);
    results.set(key, result);
    if (results.size > 256) results.delete(results.keys().next().value!);
    return result;
  };
}
