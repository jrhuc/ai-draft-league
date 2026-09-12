import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Mark, Model } from "ui/components/mark";
import { describeSelection } from "ui/components/replay";
import { seconds, tokens } from "ui/lib/format";
import { replayPositionPath } from "ui/lib/replay-position";
import { TeamTag, teamStyle } from "@/components/team";
import { franchise, matchBySeries } from "@/lib/load";
import type { Replay } from "@/lib/season";
import { useSeason, useTitle } from "@/lib/season-context";
import {
  decisionTracePath,
  type DecisionTrace,
  deployedTraces,
  gameTracesUrl,
  traceArchiveUrl,
  useGameTraces,
} from "@/lib/traces";
import { NotFoundPage } from "@/routes/not-found";

function usageLine(trace: DecisionTrace): string {
  const parts: string[] = [];
  const output = trace.usage.output_tokens;
  const reasoning = trace.usage.reasoning_tokens;
  if (trace.usage.input_tokens !== undefined)
    parts.push(`${tokens(trace.usage.input_tokens)} input tokens`);
  if (trace.usage.cached_input_tokens !== undefined)
    parts.push(`${tokens(trace.usage.cached_input_tokens)} cached input`);
  if (output !== undefined) parts.push(`${tokens(output)} output tokens`);
  if (reasoning !== undefined) parts.push(`${tokens(reasoning)} reasoning`);
  if (trace.usage.cost !== undefined) parts.push(`$${trace.usage.cost.toFixed(4)}`);
  else parts.push("Cost unknown");
  parts.push(seconds(trace.latencyMs));
  return parts.join(" · ");
}

export function DecisionTracePage() {
  const season = useSeason();
  const params = useParams();
  const seriesId = params.seriesId ?? "";
  const game = Number(params.game);
  const index = Number(params.decision) - 1;
  const row = matchBySeries(season, seriesId);
  const replay = season.replays[seriesId];
  const gameView = replay?.games[game - 1];
  const decision = gameView?.decisions[index];
  if (!row || !replay || !gameView || !decision) return <NotFoundPage />;
  return (
    <DecisionTraceBody
      key={`${seriesId}-${game}-${index}`}
      seriesId={seriesId}
      game={game}
      index={index}
      label={row.label}
      decisions={gameView.decisions}
    />
  );
}

function DecisionTraceBody({
  seriesId,
  game,
  index,
  label,
  decisions,
}: {
  seriesId: string;
  game: number;
  index: number;
  label: string;
  decisions: Replay["games"][number]["decisions"];
}) {
  const season = useSeason();
  const decision = decisions[index]!;
  const team = franchise(season, decision.franchiseId);
  const choice = describeSelection(decision);
  const context = decision.turn === 0 ? "Team preview" : `Turn ${decision.turn}`;
  useTitle(`${team.name} · Game ${game} ${context.toLowerCase()} · full trace`);
  const manifest = deployedTraces(season);
  const { traces, status, retry } = useGameTraces(manifest, seriesId, game);
  const aligned =
    !traces ||
    (traces.decisions.length === decisions.length &&
      traces.decisions.every((entry, position) => {
        const expected = decisions[position]!;
        return entry === null
          ? expected.reasoningChars === null
          : entry.franchiseId === expected.franchiseId &&
              entry.turn === expected.turn &&
              entry.phase === expected.phase &&
              JSON.stringify(entry.selection) === JSON.stringify(expected.selection);
      }));
  const trace = aligned ? (traces?.decisions[index] ?? null) : null;
  const sameTeam = decisions.flatMap((entry, position) =>
    entry.franchiseId === decision.franchiseId && entry.reasoningChars !== null ? [position] : [],
  );
  const prevIndex = sameTeam.findLast((position) => position < index);
  const nextIndex = sameTeam.find((position) => position > index);
  const prev = prevIndex === undefined ? null : decisionTracePath(seriesId, game, prevIndex);
  const next = nextIndex === undefined ? null : decisionTracePath(seriesId, game, nextIndex);
  const replayHref = replayPositionPath(seriesId, game, decision.turn, decision.franchiseId);
  const [copied, setCopied] = useState("");
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("Link copied");
    } catch {
      setCopied("Copy failed — copy the URL from your address bar.");
    }
  }
  return (
    <>
      <section className="hero trace-hero" style={teamStyle(season, team.id)}>
        <span className="label">
          <Link to={replayHref}>{label}</Link> · Game {game} · {context}
        </span>
        <h1>
          <span className="title-tag">
            <Mark spec={team.model} size="0.72em" tone />
            {team.name}
          </span>{" "}
          <span className="choice">{choice}</span>
        </h1>
        <div className="hero-row">
          <Model spec={team.model} />
          {decision.automatic ? <span className="chip chip-solid">AUTO</span> : null}
          {trace ? <span className="hint">{usageLine(trace)}</span> : null}
        </div>
        <div className="trace-actions">
          <Link to={replayHref}>Back to this turn</Link>
          <button type="button" onClick={() => void copyLink()}>
            Copy link
          </button>
          <span role="status">{copied}</span>
        </div>
        <nav className="trace-nav" aria-label={`${team.name} decisions in this game`}>
          {prev ? <Link to={prev}>Previous {team.name} decision</Link> : <span />}
          <span className="hint">
            Decision {index + 1} of {decisions.length}
          </span>
          {next ? <Link to={next}>Next {team.name} decision</Link> : <span />}
        </nav>
      </section>

      <section className="section trace-body">
        <TeamTag id={team.id} />
        <h2>Stated reason</h2>
        <blockquote className="stated">{decision.rationale || "None recorded."}</blockquote>

        {decision.reasoningChars === null ? (
          <p className="hint">
            {decision.automatic
              ? "Only one legal action existed, so the model was not consulted."
              : "No trace was released for this decision."}
          </p>
        ) : status !== "ready" || !aligned ? (
          <div className="trace-status" role={status === "loading" ? "status" : "alert"}>
            <p>
              {!aligned || status === "mismatch"
                ? "This trace does not match the released game. Refresh the season to load the current release."
                : status === "unreleased"
                  ? "No trace release is available for this game."
                  : status === "missing"
                    ? "The release lists this trace, but its file is missing."
                    : status === "failed"
                      ? "The trace could not be loaded. Check your connection and try again."
                      : "Loading trace…"}
            </p>
            {status === "missing" || status === "failed" || status === "mismatch" ? (
              <button type="button" onClick={retry}>
                Retry trace
              </button>
            ) : null}
            {status !== "loading" ? (
              <button type="button" onClick={() => window.location.reload()}>
                Refresh season
              </button>
            ) : null}
          </div>
        ) : (
          <details className="trace-panel" open>
            <summary>Reasoning</summary>
            {trace?.reasoning ? (
              <div className="trace-text">{trace.reasoning}</div>
            ) : (
              <p className="hint">The provider released no reasoning text for this decision.</p>
            )}
          </details>
        )}

        {trace ? (
          <>
            <TraceTools trace={trace} />
            <details className="trace-panel">
              <summary>Response</summary>
              <pre className="trace-code">{trace.response || "(empty)"}</pre>
            </details>
            <details className="trace-panel trace-fold">
              <summary>
                Prompt ({tokens(trace.prompt.length)} characters, including supplied memory)
              </summary>
              <div className="trace-text">{trace.prompt}</div>
            </details>
          </>
        ) : null}

        <p className="hint downloads">
          Download:{" "}
          <a href={gameTracesUrl(seriesId, game, manifest?.digests[seriesId]?.[game])}>
            this game’s traces (JSON)
          </a>{" "}
          ·{" "}
          {manifest ? (
            <a href={traceArchiveUrl(manifest)}>every trace this season (.jsonl.gz)</a>
          ) : null}
        </p>
      </section>
    </>
  );
}

function TraceTools({ trace }: { trace: DecisionTrace }) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const calls = trace.toolCalls
    .map((call, index) => ({ ...call, index }))
    .filter(
      (call) =>
        (!name || call.name === name) &&
        `${JSON.stringify(call.arguments)} ${call.result}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  return (
    <details className="trace-panel">
      <summary>Tools ({trace.toolCalls.length})</summary>
      <div className="trace-filters">
        <label>
          Tool{" "}
          <select value={name} onChange={(event) => setName(event.target.value)}>
            <option value="">All tools</option>
            {[...new Set(trace.toolCalls.map((call) => call.name))].map((tool) => (
              <option key={tool}>{tool}</option>
            ))}
          </select>
        </label>
        <label>
          Search arguments and results{" "}
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <p className="hint">
        {calls.length} of {trace.toolCalls.length} calls. Execution order; provider-round grouping
        is not recorded.
      </p>
      {calls.map((call) => (
        <details key={call.index} className="trace-fold">
          <summary>
            #{call.index + 1} · {call.name}({JSON.stringify(call.arguments)})
          </summary>
          <pre className="trace-code">{call.result}</pre>
        </details>
      ))}
    </details>
  );
}
