import { useMemo, useState } from "react";
import { Mark } from "@/components/mark";
import { seconds, toneStyle, tokens } from "@/lib/format";
import type { Decision, Reflection, Replay, ReplayEvent, ReplayGame } from "@/lib/tournament";

type Team = { id: string; name: string; tone: string; model: string };

function escapeLog(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/**
 * The "downloaded replay" document the official client publishes for offline
 * viewing: replay-embed.js reads .battle-log-data and renders the animated
 * battle. Only the log travels; every script and sprite stays on Showdown's
 * own server.
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
  return `<!DOCTYPE html>
<meta charset="utf-8" />
<!-- version 1 -->
<title>${escapeLog(title)}</title>
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<input type="hidden" name="replayid" value="ai-pokemon-worlds-2026" />
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<script type="text/plain" class="battle-log-data">${escapeLog(log)}</script>
</div>
<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>
`;
}

function ShowdownPlayer({ game, teams }: { game: ReplayGame; teams: [Team, Team] }) {
  const title = `${teams[0].name} vs ${teams[1].name} — Game ${game.number}`;
  const doc = useMemo(() => replayDoc(game.raw, teams, title), [game.raw, teams, title]);
  return <iframe className="ps-frame" srcDoc={doc} title={title} sandbox="allow-scripts" />;
}

function narrate(text: string, teams: [Team, Team]): string {
  return text
    .replace(/\bP([12])\b/g, (_, n: string) => teams[Number(n) - 1]!.name)
    .replace(
      /\b([A-Z][a-z]+(?:-[A-Za-z]+)*)-Mega(?:-([XY]))?\b/g,
      (_, base: string, form?: string) => `Mega ${base}${form ? ` ${form}` : ""}`,
    );
}

function describeSelection(decision: Decision): string {
  const picks = decision.selection;
  if (!picks.length) return decision.action || decision.phase;
  if (picks.every((pick) => pick.startsWith("Pick ")))
    return `Bring ${picks.map((pick) => pick.slice("Pick ".length)).join(", ")}`;
  return picks.join(" · ").replaceAll(" -> ", " → ");
}

function DecisionRow({
  decision,
  team,
  position,
}: {
  decision: Decision;
  team: Team;
  position: number;
}) {
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
  team,
  lastGame,
  carriesForward,
}: {
  reflection: Reflection;
  team: Team;
  lastGame: boolean;
  carriesForward: boolean;
}) {
  const won = reflection.result === "won";
  const eliminated = lastGame && !won;
  const carried = lastGame && won && carriesForward;
  return (
    <article className="card reflection" style={toneStyle(team.tone)}>
      <div className="who">
        <span className="team-tag" style={toneStyle(team.tone)}>
          <Mark spec={team.model} tone />
          {team.name}
        </span>
        <span className={`chip ${won ? "chip-good" : "chip-bad"}`}>{reflection.result}</span>
      </div>
      <p>{reflection.summary}</p>
      {reflection.adjustment && !eliminated ? (
        <p className="next">
          <span className="label">{lastGame ? "Looking ahead" : "For the next game"}</span>
          {reflection.adjustment}
        </p>
      ) : null}
      {reflection.notebook && !eliminated ? (
        <details className="notebook">
          <summary>{carried ? "Notes carried into the next match" : "Notebook"}</summary>
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
  carriesForward,
}: {
  game: ReplayGame;
  teams: [Team, Team];
  lastGame: boolean;
  carriesForward: boolean;
}) {
  const teamFor = (id: string) => (teams[0].id === id ? teams[0] : teams[1]);
  const turns = useMemo(() => {
    const rows: Array<{ turn: number; decisions: Array<[Decision, number]> }> = [];
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

      <div className="turns">
        {turns.map(({ turn, decisions }) => (
          <section key={turn} className="turn">
            <div className="turn-head">{turn === 0 ? "Team preview" : `Turn ${turn}`}</div>
            {decisions.map(([decision, position]) => (
              <DecisionRow
                key={`${turn}-${decision.entrantId}-${position}`}
                decision={decision}
                team={teamFor(decision.entrantId)}
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
            <ReflectionCard
              key={reflection.entrantId}
              reflection={reflection}
              team={teamFor(reflection.entrantId)}
              lastGame={lastGame}
              carriesForward={carriesForward}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ReplayViewer({
  replay,
  teams,
  carriesForward,
}: {
  replay: Replay;
  teams: [Team, Team];
  carriesForward: boolean;
}) {
  const [index, setIndex] = useState(0);
  const game = replay.games[index] ?? replay.games[0];
  if (!game) return null;
  return (
    <div>
      <div className="game-tabs" role="group" aria-label="Games">
        {replay.games.map((entry, i) => {
          const winner =
            entry.winnerId === teams[0].id
              ? teams[0]
              : entry.winnerId === teams[1].id
                ? teams[1]
                : null;
          return (
            <button
              key={entry.number}
              type="button"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
            >
              Game {entry.number}{" "}
              <small>
                {entry.turns} turns
                {winner ? ` · ${winner.name} won` : ""}
              </small>
            </button>
          );
        })}
      </div>
      <Game
        key={game.number}
        game={game}
        teams={teams}
        lastGame={index === replay.games.length - 1}
        carriesForward={carriesForward}
      />
    </div>
  );
}
