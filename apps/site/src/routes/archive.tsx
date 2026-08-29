import { RunBrowser } from "@/components/run-browser";
import { useExternalRuns } from "@/lib/runs";
import "@/styles/watch.css";

export default function ArchivePage() {
  const { runs, failed } = useExternalRuns(30_000);
  const finished = runs?.filter((run) => run.state === "done") ?? null;
  return (
    <section className="watch">
      <span className="label">Local live watch</span>
      <h1>Archive</h1>
      <p className="sub">
        Dev-only. Finished runs on disk; open one and the season pages render it in place of the
        published bundle.
      </p>
      <RunBrowser runs={finished} failed={failed} verb="open" empty="No finished runs on disk." />
    </section>
  );
}
