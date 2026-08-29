import { useState } from "react";
import { liveRunId, startWatching, stopWatching } from "@/lib/live";
import type { ExternalRunSummary } from "@/lib/runs";

export function RunBrowser({
  runs,
  failed,
  verb,
  empty,
}: {
  runs: ExternalRunSummary[] | null;
  failed: boolean;
  verb: string;
  empty: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const live = liveRunId();

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
    <>
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
      {failed ? (
        <p className="watch-notice mono">Run listing unavailable — is this the dev server?</p>
      ) : null}
      {notice ? <p className="watch-notice mono">{notice}</p> : null}
      {runs === null ? (
        <p className="sub">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="sub">{empty}</p>
      ) : (
        <div className="card watch-table">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Mode</th>
                <th>Started</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td className="mono">{run.runId}</td>
                  <td>{run.mode}</td>
                  <td className="mono">{run.startTime ?? "—"}</td>
                  <td>
                    <button type="button" className="chip" onClick={() => open(run.runId)}>
                      {verb}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
