import { publicSeasonBundleSchema } from "league/protocol";
import { createBundle } from "ui/lib/bundle";
import { liveRunId, stopWatching } from "./live";
import type { Season, SeasonBundle } from "./season";
import { loadTraceManifest } from "./traces";

async function fetchParsed(url: string): Promise<SeasonBundle> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const value: unknown = await response.json();
  return publicSeasonBundleSchema.parse(value);
}

async function fetchBundle(): Promise<Season> {
  if (import.meta.env.DEV) {
    const live = liveRunId();
    if (live) {
      try {
        const [bundle, traces] = await Promise.all([
          fetchParsed(`/api/watch/runs/${live}/bundle`),
          loadTraceManifest(),
        ]);
        return { ...bundle, traces };
      } catch {
        stopWatching();
      }
    }
  }
  const [bundle, traces] = await Promise.all([
    fetchParsed("/season-bundle.json"),
    loadTraceManifest(),
  ]);
  return { ...bundle, traces };
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
