import type { SeasonBundle } from "./season";

export const SEASON_BUNDLE_ROOT_KEYS = {
  protocolVersion: true,
  generatedAt: true,
  season: true,
  provenance: true,
  franchises: true,
  board: true,
  draft: true,
  standings: true,
  weeks: true,
  transactions: true,
  weeklyReviews: true,
  playoffs: true,
  replays: true,
  reviews: true,
} as const satisfies Record<keyof SeasonBundle, true>;

export function assertSeasonBundleSchemaRoot(schema: unknown): void {
  if (typeof schema !== "object" || schema === null || !("properties" in schema) || !("required" in schema)) {
    throw new Error("season-bundle-v2 schema has no root properties or required fields");
  }
  const properties = schema.properties;
  const required = schema.required;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties) || !Array.isArray(required)) {
    throw new Error("season-bundle-v2 schema root properties or required fields are invalid");
  }
  const expected = Object.keys(SEASON_BUNDLE_ROOT_KEYS).sort();
  const actualProperties = Object.keys(properties).sort();
  const actualRequired = required.filter((value): value is string => typeof value === "string").sort();
  if (actualProperties.join("\n") !== expected.join("\n") || actualRequired.join("\n") !== expected.join("\n")) {
    throw new Error(
      `season-bundle-v2 TypeScript contract is out of sync: expected=${expected.join(",")} properties=${actualProperties.join(",")} required=${actualRequired.join(",")}`,
    );
  }
}
