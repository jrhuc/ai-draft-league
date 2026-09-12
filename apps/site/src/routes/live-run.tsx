import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { LiveGame, LiveRunSnapshot } from "league/protocol";
import { Frame } from "ui/components/frame";
import { Model } from "ui/components/mark";
import { ShowdownPlayer, type Team } from "ui/components/replay";
import { tokens } from "ui/lib/format";
import { startWatching } from "@/lib/live";
import { useLiveProgress } from "@/lib/live-progress";
import "@/styles/watch.css";

type AgentProgress = LiveRunSnapshot["agents"][number];

const activityLabel = {
  starting: "Starting",
  generating: "Generating",
  reasoning: "Reasoning",
  tool: "Calling tool",
  retry: "Waiting to retry",
  compacting: "Compacting history",
  ended: "Finished",
} satisfies Record<AgentProgress["activity"], string>;

function activity(agent: AgentProgress): string {
  return agent.activity === "tool" && agent.tool
    ? `Calling ${agent.tool}`
    : activityLabel[agent.activity];
}

function LiveBattle({ game }: { game: LiveGame }) {
  const teams = useMemo<[Team, Team]>(
    () => [
      { id: "p1", name: game.players.p1, model: game.players.p1, tone: "blue" },
      { id: "p2", name: game.players.p2, model: game.players.p2, tone: "red" },
    ],
    [game.players.p1, game.players.p2],
  );
  return (
    <section className="section">
      <div className="section-head">
        <h2>
          Game {game.game} · {game.turn ? `Turn ${game.turn}` : "Team preview"}
        </h2>
        <p>
          {game.state === "ended" ? (game.winner ? `${game.winner} won` : "Draw") : "Playing"} ·
          Series {game.score.p1}–{game.score.p2}
        </p>
      </div>
      <ShowdownPlayer game={{ number: game.game, raw: game.raw }} teams={teams} live />
      <details className="full-log">
        <summary>Public battle log</summary>
        <pre className="live-log">{game.raw || "Waiting for Showdown…"}</pre>
      </details>
    </section>
  );
}

export default function LiveRunPage() {
  const { runId } = useParams();
  if (!runId) throw new Error("Missing run id");
  return <LiveRunBody key={runId} runId={runId} />;
}

function LiveRunBody({ runId }: { runId: string }) {
  const { snapshot, connection } = useLiveProgress(runId);
  const [selected, setSelected] = useState<string | null>(null);
  const game =
    snapshot?.games.find((entry) => entry.seriesId === selected) ??
    snapshot?.games.find((entry) => entry.state === "playing") ??
    snapshot?.games.at(-1);
  return (
    <Frame
      wordmark={
        <>
          AI <em>Draft</em> League
        </>
      }
      nav={
        <nav aria-label="Sections">
          <Link to="/live">All runs</Link>
          <a href="/" onClick={() => startWatching(runId)}>
            Season pages
          </a>
        </nav>
      }
      release={`Live watch · ${snapshot?.state ?? "waiting"}`}
      repo="https://github.com/jrhuc/ai-draft-league"
      footer={<span>Local live watch · Pokémon Showdown</span>}
    >
      <section className="watch">
        <span className="label">Local live watch</span>
        <h1>{runId}</h1>
        <p className="sub" role="status">
          {connection}
          {snapshot
            ? ` · Updated ${new Date(snapshot.updatedAt).toLocaleTimeString()}`
            : " · Waiting for the run to start"}
        </p>
      </section>
      <section className="section" aria-label="Agent activity">
        <div className="section-head">
          <h2>Agents</h2>
          <p>Live agent activity · usage totals are per session.</p>
        </div>
        {snapshot?.agents.length ? (
          <div className="live-agents">
            {snapshot.agents.map((agent) => (
              <article className="card card-pad" key={agent.session}>
                <Model spec={agent.model} />
                <h3>{activity(agent)}</h3>
                <p className="mono live-task">{agent.task}</p>
                <details>
                  <summary>Session</summary>
                  <p className="mono live-task">{agent.session}</p>
                </details>
                <p className="hint">
                  {agent.usage
                    ? `${tokens(agent.usage.inputTokens)} input · ${tokens(agent.usage.outputTokens)} output · $${agent.usage.cost.toFixed(4)}`
                    : "Awaiting usage"}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="sub">
            {snapshot?.state === "running" ? "Between agent tasks." : "No active agent tasks."}
          </p>
        )}
      </section>
      {snapshot?.games.length ? (
        <>
          <div className="game-tabs live-series" role="group" aria-label="Series">
            {snapshot.games.map((entry) => (
              <button
                type="button"
                key={entry.seriesId}
                aria-pressed={entry.seriesId === game?.seriesId}
                onClick={() => setSelected(entry.seriesId)}
              >
                <Model spec={entry.players.p1} /> vs <Model spec={entry.players.p2} />
                <small>
                  Game {entry.game} · {entry.state === "playing" ? `Turn ${entry.turn}` : "Ended"}
                </small>
              </button>
            ))}
          </div>
          {game ? (
            <LiveBattle
              key={`${snapshot.generation}:${game.seriesId}:${game.game}:${game.attempt}`}
              game={game}
            />
          ) : null}
        </>
      ) : (
        <p className="sub">Battles will appear here when team building finishes.</p>
      )}
    </Frame>
  );
}
