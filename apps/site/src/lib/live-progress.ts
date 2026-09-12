import { useEffect, useState } from "react";
import { liveRunSchema, type LiveRunSnapshot } from "league/protocol";

export function useLiveProgress(runId: string) {
  const [snapshot, setSnapshot] = useState<LiveRunSnapshot | null>(null);
  const [connection, setConnection] = useState("Connecting…");
  useEffect(() => {
    const events = new EventSource(`/api/watch/runs/${encodeURIComponent(runId)}/events`);
    events.onopen = () => setConnection("Connected");
    events.onerror = () => setConnection("Connection lost · reconnecting…");
    events.addEventListener("watch-error", () => setConnection("Live update unavailable"));
    events.addEventListener("snapshot", (event) => {
      try {
        const value = liveRunSchema.nullable().parse(JSON.parse(event.data));
        if (value && value.runId !== runId) throw new Error("Wrong run");
        setSnapshot(value);
        setConnection("Connected");
      } catch {
        setConnection("Invalid live update");
      }
    });
    return () => events.close();
  }, [runId]);
  return { snapshot, connection };
}
