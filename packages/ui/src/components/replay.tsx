import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import frameScript from "../frame/replay-frame.js?url&no-inline";
import { seconds, toneStyle, tokens } from "../lib/format";
import { Mark } from "./mark";

export type Team = { id: string; name: string; tone: string; model: string };

export type ReplayEvent = { turn: number; kind: string; text: string };

export type ReplayDecision = {
  team: Team;
  turn: number;
  phase: string;
  action: string;
  selection: string[];
  rationale: string;
  notebook?: string;
  fallback: boolean;
  automatic: boolean;
  latencyMs: number | null;
  reasoningTokens: number | null;
};

export type ReplayReflection = {
  team: Team;
  result: "won" | "lost" | "tied";
  summary: string;
  adjustment: string;
  notebook?: string;
  retrospective?: { didWell: string; didPoorly: string; wouldChange: string };
};

export type ReplayGameView = {
  number: number;
  turns: number;
  winner: Team | null;
  raw: string;
  events: ReplayEvent[];
  decisions: ReplayDecision[];
  reflections: ReplayReflection[];
};

function escapeLog(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/**
 * The "downloaded replay" document the official client publishes for offline
 * viewing: replay-embed.js reads .battle-log-data and renders the animated
 * battle. Only the log travels; every script and sprite stays on Showdown's
 * own server. The frame script must run first (see that file), and stays an
 * external script because the site CSP bars inline scripts, which the srcdoc
 * inherits.
 */
function replayDoc(raw: string, teams: [Team, Team], title: string): string {
  let log = raw;
  const names = [...raw.matchAll(/^\|player\|(p[12])\|([^|]+)\|/gm)];
  const collide = teams[0].name === teams[1].name;
  for (const [, pid, recorded] of names) {
    const team = teams[pid === "p1" ? 0 : 1];
    const label = collide ? `${team.name} (${pid?.toUpperCase()})` : team.name;
    log = log.replaceAll(recorded!, label);
  }
  const replayId = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<!DOCTYPE html>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
<!-- version 1 -->
<title>${escapeLog(title)}</title>
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<input type="hidden" name="replayid" value="${replayId}" />
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<script type="text/plain" class="battle-log-data">${escapeLog(log)}</script>
</div>
<script src="${frameScript}"></script>
<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>
`;
}

const heightReport = z.object({ type: z.literal("ps-height"), height: z.number().finite() });

function ShowdownPlayer({ game, teams }: { game: ReplayGameView; teams: [Team, Team] }) {
  const title = `${teams[0].name} vs ${teams[1].name} — Game ${game.number}`;
  const doc = useMemo(() => replayDoc(game.raw, teams, title), [game.raw, teams, title]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  /* The sandbox denies same-origin access, so the frame posts its rendered
     height; until the first report the CSS estimate holds. */
  useEffect(() => {
    function onHeight(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      const report = heightReport.safeParse(event.data);
      if (!report.success) return;
      setHeight(Math.min(Math.max(Math.ceil(report.data.height), 240), 960));
    }
    window.addEventListener("message", onHeight);
    return () => window.removeEventListener("message", onHeight);
  }, []);
  return (
    <div className="player-loaded">
      <iframe
        ref={frameRef}
        className="ps-frame"
        srcDoc={doc}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={height ? { height } : undefined}
      />
      <p className="player-note">
        If the animation is unavailable, the turn reasoning and full text log remain below.
      </p>
    </div>
  );
}

function narrate(text: string, teams: [Team, Team]): string {
  return text
    .replace(/\bP([12])\b/g, (_, n: string) => teams[Number(n) - 1]!.name)
    .replace(
      /\b([A-Z][a-z]+(?:-[A-Za-z]+)*)-Mega(?:-([XY]))?\b/g,
      (_, base: string, form?: string) => `Mega ${base}${form ? ` ${form}` : ""}`,
    );
}

function describeSelection(decision: ReplayDecision): string {
  const picks = decision.selection;
  if (!picks.length) return decision.action || decision.phase;
  if (picks.every((pick) => pick.startsWith("Pick ")))
    return `Bring ${picks.map((pick) => pick.slice("Pick ".length)).join(", ")}`;
  return picks.join(" · ").replaceAll(" -> ", " → ");
}

function DecisionRow({ decision, position }: { decision: ReplayDecision; position: number }) {
  const { team } = decision;
  const choice = describeSelection(decision);
  const context = decision.turn === 0 ? "team preview" : `turn ${decision.turn}`;
  const rationaleLabel = `${team.name} rationale for ${choice}, ${context}, decision ${position + 1}`;
  return (
    <div className="dec" style={toneStyle(team.tone)}>
      <span className="who">{team.name}</span>
      <span className="act" title={decision.action}>
        {choice}
      </span>
      <span className="meta">
        {decision.automatic ? <span className="chip chip-solid">AUTO</span> : null}
        {decision.fallback && !decision.automatic ? (
          <span className="chip chip-warn">fallback</span>
        ) : null}
        {seconds(decision.latencyMs)}
        {decision.reasoningTokens !== null
          ? ` · ${tokens(decision.reasoningTokens)} reasoning`
          : ""}
      </span>
      {decision.rationale ? (
        <details>
          <summary aria-label={rationaleLabel}>Reasoning</summary>
          <blockquote>{decision.rationale}</blockquote>
        </details>
      ) : null}
      {decision.notebook ? (
        <details className="notebook">
          <summary aria-label={`${team.name} notebook after this decision`}>Notebook</summary>
          <blockquote>{decision.notebook}</blockquote>
        </details>
      ) : null}
    </div>
  );
}

function ReflectionCard({
  reflection,
  lastGame,
}: {
  reflection: ReplayReflection;
  lastGame: boolean;
}) {
  const { team } = reflection;
  const won = reflection.result === "won";
  const lost = reflection.result === "lost";
  const eliminated = lastGame && lost;
  return (
    <article className="card reflection" style={toneStyle(team.tone)}>
      <div className="who">
        <span className="team-tag" style={toneStyle(team.tone)}>
          <Mark spec={team.model} tone />
          {team.name}
        </span>
        <span className={`chip ${won ? "chip-good" : lost ? "chip-bad" : "chip-warn"}`}>
          {reflection.result}
        </span>
      </div>
      <p>{reflection.summary}</p>
      {reflection.retrospective ? (
        <dl className="retrospective">
          <div>
            <dt>Did well</dt>
            <dd>{reflection.retrospective.didWell}</dd>
          </div>
          <div>
            <dt>Did poorly</dt>
            <dd>{reflection.retrospective.didPoorly}</dd>
          </div>
          <div>
            <dt>Would change</dt>
            <dd>{reflection.retrospective.wouldChange}</dd>
          </div>
        </dl>
      ) : null}
      {reflection.adjustment && !eliminated && !reflection.retrospective ? (
        <p className="next">
          <span className="label">{lastGame ? "Looking ahead" : "For the next game"}</span>
          {reflection.adjustment}
        </p>
      ) : null}
      {reflection.notebook && !eliminated && !reflection.retrospective ? (
        <details className="notebook">
          <summary>{lastGame ? "Notebook after this match" : "Notebook"}</summary>
          <blockquote>{reflection.notebook}</blockquote>
        </details>
      ) : null}
    </article>
  );
}

function Game({
  game,
  teams,
  lastGame,
  sheets,
}: {
  game: ReplayGameView;
  teams: [Team, Team];
  lastGame: boolean;
  sheets?: ReactNode;
}) {
  const turns = useMemo(() => {
    const rows: Array<{ turn: number; decisions: Array<[ReplayDecision, number]> }> = [];
    for (const [position, decision] of game.decisions.entries()) {
      const last = rows[rows.length - 1];
      if (!last || last.turn !== decision.turn)
        rows.push({ turn: decision.turn, decisions: [[decision, position]] });
      else last.decisions.push([decision, position]);
    }
    return rows;
  }, [game.decisions]);
  const logTurns = useMemo(() => {
    const rows: Array<{ turn: number; events: ReplayEvent[] }> = [];
    for (const event of game.events) {
      if (event.kind === "turn" || event.kind === "preview") continue;
      const last = rows[rows.length - 1];
      if (!last || last.turn !== event.turn) rows.push({ turn: event.turn, events: [event] });
      else last.events.push(event);
    }
    return rows;
  }, [game.events]);

  return (
    <div className="replay">
      <ShowdownPlayer game={game} teams={teams} />
      {sheets}

      <div className="turns">
        {turns.map(({ turn, decisions }) => (
          <section key={turn} className="turn">
            <div className="turn-head">{turn === 0 ? "Team preview" : `Turn ${turn}`}</div>
            {decisions.map(([decision, position]) => (
              <DecisionRow
                key={`${turn}-${decision.team.id}-${position}`}
                decision={decision}
                position={position}
              />
            ))}
          </section>
        ))}
      </div>

      <details className="full-log">
        <summary>Show full log</summary>
        <div className="log-body">
          {logTurns.map(({ turn, events }) => (
            <section key={turn} className="turn">
              <div className="turn-head">{turn === 0 ? "Start" : `Turn ${turn}`}</div>
              <div className="log">
                {events.map((event, i) => (
                  <div key={i} className={event.kind}>
                    {narrate(event.text, teams)}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </details>

      {game.reflections.length > 0 ? (
        <div className="reflections">
          {game.reflections.map((reflection) => (
            <ReflectionCard key={reflection.team.id} reflection={reflection} lastGame={lastGame} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ReplayViewer({
  games,
  teams,
  sheets,
}: {
  games: ReplayGameView[];
  teams: [Team, Team];
  sheets?: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const game = games[index] ?? games[0];
  if (!game) return null;
  return (
    <div>
      <div className="game-tabs" role="group" aria-label="Games">
        {games.map((entry, i) => (
          <button
            key={entry.number}
            type="button"
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
          >
            Game {entry.number}{" "}
            <small>
              {entry.turns} turns
              {entry.winner ? ` · ${entry.winner.name} won` : ""}
            </small>
          </button>
        ))}
      </div>
      <Game
        key={game.number}
        game={game}
        teams={teams}
        lastGame={index === games.length - 1}
        sheets={sheets}
      />
    </div>
  );
}
