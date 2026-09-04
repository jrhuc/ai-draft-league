import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { EntrantTag, entrantStyle, ordinal } from "@/components/entrant";
import { useTitle, useTournament } from "@/lib/context";
import { Mark } from "ui/components/mark";
import { SetCard } from "ui/components/set-card";
import { Sprite } from "ui/components/sprite";
import { formatLabel, modelLabel, modelProvider, seconds, tokens } from "ui/lib/format";
import { entrant, entrantStats, roundLabel, tapeStats } from "@/lib/load";
import type { Entrant } from "@/lib/tournament";

function TeamCard({ entry }: { entry: Entrant }) {
  const bundle = useTournament();
  const team = entry.team;
  const provider = modelProvider(entry.model);
  const [openSetId, setOpenSetId] = useState<string | null>(null);
  const openSet = team.sets.find((set) => set.id === openSetId);
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openSetId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target))
        setOpenSetId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSetId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openSetId]);
  return (
    <article
      ref={cardRef}
      className={`card card-pad team-card${openSet ? " popped" : ""}`}
      style={entrantStyle(bundle, entry.id)}
    >
      <div className="head">
        <EntrantTag id={entry.id} />
        {team.placement === null ? null : (
          <span className="chip">{ordinal(team.placement)} at the event</span>
        )}
      </div>
      {provider ? <span className="model">via {provider}</span> : null}
      <span className="label">
        {team.player}
        {team.handle ? ` (${team.handle})` : ""}
        {team.swiss ? ` · ${team.swiss} in Swiss` : ""}
      </span>
      <div className="sprite-row">
        {team.sets.map((set) => (
          <button
            key={set.id}
            type="button"
            className={`mon-toggle${openSetId === set.id ? " open" : ""}`}
            aria-pressed={openSetId === set.id}
            onClick={() => setOpenSetId(openSetId === set.id ? null : set.id)}
          >
            <Sprite id={set.spriteId} name={set.species} size={40} />
          </button>
        ))}
        {openSet ? (
          <div key={openSet.id} className="set-pop">
            <SetCard set={openSet} />
          </div>
        ) : null}
      </div>
      {team.paste ? (
        <a href={team.paste} target="_blank" rel="noreferrer" className="chip">
          Show original sheet →
        </a>
      ) : null}
    </article>
  );
}

export function HomePage() {
  const bundle = useTournament();
  useTitle();
  const t = bundle.tournament;
  const event = bundle.event;
  const champion = t.championId ? entrant(bundle, t.championId) : null;
  const stats = tapeStats(bundle);
  const championProvider = champion ? modelProvider(champion.model) : "";
  return (
    <>
      <section className="hero">
        <span className="label">Pokémon Worlds 2026 · San Francisco</span>
        <h1>
          AI Pokémon Worlds <em>2026</em>
        </h1>
        <p className="sub">
          8 models replay a real VGC Top 8 bracket. Watch every battle with turn-by-turn reasoning
          and between-game notes.
        </p>
        {event ? <p className="sub mono">Source bracket: {event.name}.</p> : null}
        <dl className="facts">
          <div>
            <dt>Format</dt>
            <dd>{formatLabel(t.format)}</dd>
          </div>
          {event?.players ? (
            <div>
              <dt>Field</dt>
              <dd>{event.players} players</dd>
            </div>
          ) : null}
          <div>
            <dt>Games</dt>
            <dd>{stats.games}</dd>
          </div>
          <div>
            <dt>Decisions</dt>
            <dd>{stats.decisions.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{tokens(stats.reasoningTokens)}</dd>
          </div>
        </dl>
      </section>

      {champion ? (
        <div className="champion" style={entrantStyle(bundle, champion.id)}>
          <span className="label">Champion</span>
          <h2>
            <span className="title-tag">
              <Mark spec={champion.model} size="0.72em" tone />
              {modelLabel(champion.model)}
            </span>
          </h2>
          {championProvider ? <span className="model">via {championProvider}</span> : null}
          <span className="label">
            piloting {champion.team.player}’s
            {champion.team.placement === null
              ? ""
              : ` ${ordinal(champion.team.placement)}-place`}{" "}
            team
          </span>
          <span className="sprite-row">
            {champion.team.sets.map((set) => (
              <Sprite key={set.id} id={set.spriteId} name={set.species} size={40} />
            ))}
          </span>
        </div>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Bracket</h2>
          <p>Original pairings. Best of 3.</p>
        </div>
        <div className="bracket">
          {bundle.bracket.rounds.map((round, i) => (
            <div key={i} className="bracket-round">
              <span className="label">{roundLabel(bundle, i)}</span>
              {round.map((slot, j) => {
                const href = slot.match ? `/matches/${slot.match.seriesId}` : null;
                const body = slot.slots.map((id, side) => {
                  const lost = slot.match && id ? slot.match.winnerId !== id : false;
                  return (
                    <span
                      key={side}
                      className={`bracket-slot${lost ? " lost" : ""}`}
                      style={id ? entrantStyle(bundle, id) : undefined}
                    >
                      {id ? (
                        <EntrantTag id={id} muted={Boolean(lost)} />
                      ) : (
                        <span style={{ color: "var(--t5)" }}>TBD</span>
                      )}
                      <span className="num">{slot.match?.score[side] ?? ""}</span>
                    </span>
                  );
                });
                return (
                  <div key={slot.seriesIndex ?? `bye-${j}`} className="card bracket-match">
                    {href ? (
                      <Link to={href}>
                        {body}
                        <span className="go">
                          Watch <span className="arrow">→</span>
                        </span>
                      </Link>
                    ) : (
                      <div>{body}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>The teams</h2>
          <p>
            {event
              ? `Each model pilots one of ${event.name}’s top ${event.cut ?? bundle.entrants.length} teams${event.seeding ? `, ${event.seeding}` : ""}.`
              : "Each model pilots a real top-cut team."}
            {event?.reconstructedSpreads
              ? " Published lists omitted stat spreads; these use public sets for the same Pokémon."
              : ""}
          </p>
        </div>
        <div className="grid grid-2">
          {bundle.entrants.map((entry) => (
            <TeamCard key={entry.id} entry={entry} />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Decision stats</h2>
          <p>Reasoning and time are per decision; Protect and switch rates are per turn.</p>
        </div>
        <div className="card stat-table">
          <div className="stat-row stat-head">
            <span />
            <span>reasoning</span>
            <span>time</span>
            <span>protect</span>
            <span>switch</span>
          </div>
          {entrantStats(bundle).map((row) => (
            <div
              key={row.entrantId}
              className="stat-row"
              style={entrantStyle(bundle, row.entrantId)}
            >
              <EntrantTag id={row.entrantId} />
              <span className="num">
                {row.reasoningTokens === null ? "—" : tokens(Math.round(row.reasoningTokens))}
              </span>
              <span className="num">{row.latencyMs === null ? "—" : seconds(row.latencyMs)}</span>
              <span className="num">{Math.round(row.protectRate * 100)}%</span>
              <span className="num">{Math.round(row.switchRate * 100)}%</span>
            </div>
          ))}
        </div>
      </section>

      {bundle.briefing ? (
        <section className="section">
          <div className="section-head">
            <h2>Event briefing</h2>
            <p>Shared event context.</p>
          </div>
          <div className="card card-pad">
            {bundle.briefing.split("\n").map((line, i) => (
              <p key={i} className="rationale">
                {line}
              </p>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
