import { RunBrowser } from "@/components/run-browser";
import { Link } from "react-router-dom";
import { Frame } from "ui/components/frame";
import { useExternalRuns } from "@/lib/runs";
import "@/styles/watch.css";

export default function LivePage() {
  const { runs, failed } = useExternalRuns(5000);
  const running = runs?.filter((run) => run.state === "running") ?? null;
  return (
    <Frame
      wordmark={
        <>
          AI <em>Draft</em> League
        </>
      }
      nav={
        <nav aria-label="Sections">
          <Link to="/">Season pages</Link>
          <Link to="/archive">Archive</Link>
        </nav>
      }
      release="Local live watch"
      repo="https://github.com/jrhuc/ai-draft-league"
      footer={<span>Local live watch · Pokémon Showdown</span>}
    >
      <section className="watch">
        <span className="label">Local live watch</span>
        <h1>Live now</h1>
        <p className="sub">
          Watch agent activity and battles as they happen. Each run opens a live Showdown player.
        </p>
        <RunBrowser
          runs={running}
          failed={failed}
          verb="watch"
          empty="Nothing is running right now."
        />
      </section>
    </Frame>
  );
}
