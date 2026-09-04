import { publicSeasonBundleSchema } from "league/protocol";
import { createBundle } from "ui/lib/bundle";
import { liveRunId, stopWatching } from "./live";
import type { SeasonBundle } from "./season";

async function fetchParsed(url: string): Promise<SeasonBundle> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const value: unknown = await response.json();
  return publicSeasonBundleSchema.parse(value);
}

async function fetchBundle(): Promise<SeasonBundle> {
  if (import.meta.env.DEV) {
    const live = liveRunId();
    if (live) {
      try {
        return await fetchParsed(`/api/watch/runs/${live}/bundle`);
      } catch {
        stopWatching();
      }
    }
  }
  return fetchParsed("/season-bundle.json");
}

const bundle = createBundle(
  fetchBundle,
  (season) => season.season.title,
  "Could not load the season",
  () => (import.meta.env.DEV && liveRunId() ? 10_000 : null),
);

export const SeasonProvider = bundle.Provider;
export const useSeason = bundle.useBundle;
export const useTitle = bundle.useTitle;
