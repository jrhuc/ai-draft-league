import { useEffect, useState } from "react";
import type { ExternalRunSummary } from "league/server";

export type { ExternalRunSummary };

export async function fetchRuns(): Promise<ExternalRunSummary[]> {
  const response = await fetch("/api/watch/runs");
  if (!response.ok) throw new Error(`watch runs responded ${response.status}`);
  // SAFETY: the dev server builds this listing from the league's own lister.
  return response.json() as Promise<ExternalRunSummary[]>;
}

export interface ExternalRunsState {
  runs: ExternalRunSummary[] | null;
  failed: boolean;
}

export function useExternalRuns(pollMs: number): ExternalRunsState {
  const [runs, setRuns] = useState<ExternalRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void fetchRuns().then(
        (rows) => {
          if (alive) {
            setRuns(rows);
            setFailed(false);
          }
        },
        () => {
          if (alive) setFailed(true);
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollMs]);
  return { runs, failed };
}
