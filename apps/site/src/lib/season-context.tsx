import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { publicSeasonBundleSchema } from "league/protocol";
import { liveRunId, stopWatching } from "./live";
import type { SeasonBundle } from "./season";

let bundlePromise: Promise<SeasonBundle> | null = null;

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

function loadBundle(): Promise<SeasonBundle> {
  bundlePromise ??= fetchBundle();
  return bundlePromise;
}

function useBundle(): SeasonBundle | null {
  const [bundle, setBundle] = useState<SeasonBundle | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadBundle().then(
      (value) => {
        if (live) setBundle(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    if (!import.meta.env.DEV || !liveRunId()) {
      return () => {
        live = false;
      };
    }
    const timer = setInterval(() => {
      void fetchBundle().then(
        (value) => {
          if (live) setBundle(value);
        },
        () => undefined,
      );
    }, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (failed) throw new Error("The season data could not be loaded. Refresh to try again.");
  return bundle;
}

const SeasonContext = createContext<SeasonBundle | null>(null);

export function SeasonProvider({ children }: { children: ReactNode }) {
  const season = useBundle();
  if (!season) {
    return (
      <div className="boot" role="status">
        <span className="dot" aria-hidden="true" />
        Loading season…
      </div>
    );
  }
  return <SeasonContext.Provider value={season}>{children}</SeasonContext.Provider>;
}

export function useSeason(): SeasonBundle {
  const season = useContext(SeasonContext);
  if (!season) throw new Error("useSeason must be used inside <SeasonProvider>");
  return season;
}

/** Mirror of the old Next metadata template: `%s · ${season.title}` with no segment falling back to the bare title. */
export function useTitle(title?: string): void {
  const season = useSeason();
  useEffect(() => {
    document.title = title ? `${title} · ${season.season.title}` : season.season.title;
  }, [title, season]);
}
