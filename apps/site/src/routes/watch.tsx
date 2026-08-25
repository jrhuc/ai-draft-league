import { useEffect, useState } from "react";
import type { ExternalRunSummary } from "league/server";
import { liveRunId, startWatching, stopWatching } from "@/lib/live";
import "@/styles/watch.css";

async function fetchRuns(): Promise<ExternalRunSummary[]> {
  const response = await fetch("/api/watch/runs");
  if (!response.ok) throw new Error(`watch runs responded ${response.status}`);
  // SAFETY: the dev server builds this listing from the league's own lister.
  return response.json() as Promise<ExternalRunSummary[]>;
}

export default function WatchPage() {
  const [runs, setRuns] = useState<ExternalRunSummary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = liveRunId();

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void fetchRuns().then(
        (rows) => {
          if (alive) setRuns(rows);
        },
        () => {
          if (alive) setNotice("Run listing unavailable — is this the dev server?");
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const open = (runId: string): void => {
    void (async () => {
      const response = await fetch(`/api/watch/runs/${runId}/bundle`);
      if (response.ok) {
        startWatching(runId);
        location.assign("/");
        return;
      }
      setNotice(`${runId}: ${await response.text()}`);
    })();
  };

  return (
    <section className="watch">
      <span className="label">Local live watch</span>
      <h1>Runs on disk</h1>
      <p className="sub">
        Dev-only. Pick a run and the regular season pages render its current state, refreshed as it
        plays. Only exportable runs (draft archived, replays verified) can open.
      </p>
      {live ? (
        <p className="watch-live mono">
          Watching {live}{" "}
          <button
            type="button"
            className="chip"
            onClick={() => {
              stopWatching();
              location.reload();
            }}
          >
            stop
          </button>
        </p>
      ) : null}
      {notice ? <p className="watch-notice mono">{notice}</p> : null}
      {runs === null ? (
        <p className="sub">Loading…</p>
      ) : (
        <div className="card watch-table">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Mode</th>
                <th>State</th>
                <th>Started</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td className="mono">{run.runId}</td>
                  <td>{run.mode}</td>
                  <td className={run.state === "running" ? "watch-running" : undefined}>
                    {run.state}
                    {run.error ? ` · ${run.error}` : ""}
                  </td>
                  <td className="mono">{run.startTime ?? "—"}</td>
                  <td>
                    <button type="button" className="chip" onClick={() => open(run.runId)}>
                      watch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
