import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { SeasonBundle } from "./season";

/**
 * The bundle is fetched once per page load from `/season-bundle.json`, the same
 * public artifact the producer exports. It stays out of the JS bundle so the
 * file remains independently cacheable across site releases.
 */

const bundlePromise: Promise<SeasonBundle> = fetch("/season-bundle.json").then((response) => {
  if (!response.ok) throw new Error(`season-bundle.json responded ${response.status}`);
  // SAFETY: the producer validates the bundle shape before export; the site renders it verbatim.
  return response.json() as Promise<SeasonBundle>;
});

function useBundle(): SeasonBundle | null {
  const [bundle, setBundle] = useState<SeasonBundle | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    bundlePromise.then(
      (value) => {
        if (live) setBundle(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
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
