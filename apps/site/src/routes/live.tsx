import { RunBrowser } from "@/components/run-browser";
import { useExternalRuns } from "@/lib/runs";
import "@/styles/watch.css";

export default function LivePage() {
  const { runs, failed } = useExternalRuns(5000);
  const running = runs?.filter((run) => run.state === "running") ?? null;
  return (
    <section className="watch">
      <span className="label">Local live watch</span>
      <h1>Live now</h1>
      <p className="sub">
        Dev-only. Pick a run and the regular season pages render its current state, refreshed as it
        plays.
      </p>
      <RunBrowser
        runs={running}
        failed={failed}
        verb="watch"
        empty="Nothing is running right now."
      />
    </section>
  );
}
