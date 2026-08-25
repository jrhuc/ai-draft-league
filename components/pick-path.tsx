"use client";

import Link from "next/link";
import { useState } from "react";
import { Sprite } from "@/components/sprite";
import { tone, toneStyle } from "@/lib/format";
import type { DraftPick } from "@/lib/season";

export type TeamRef = { id: string; name: string };

export function PickPath({ picks, franchises }: { picks: DraftPick[]; franchises: TeamRef[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<number>(picks[0]?.overall ?? 0);
  const index = new Map(franchises.map((team, i) => [team.id, i]));
  const byId = new Map(franchises.map((team) => [team.id, team]));
  const current = picks.find((pick) => pick.overall === picked) ?? null;
  const focus = hover ?? current?.franchiseId ?? null;
  const team = current ? byId.get(current.franchiseId) : null;
  const seats = franchises.length;
  const rounds = Math.max(...picks.map((pick) => pick.round));
  const column = (pick: DraftPick): number => {
    const slot = (pick.overall - 1) % seats;
    return pick.round % 2 === 1 ? slot + 2 : seats - slot + 1;
  };

  return (
    <div className="section">
      <div className="path-wrap">
        <ol
          className="path"
          data-focus={hover ? "" : undefined}
          onMouseLeave={() => setHover(null)}
          style={{ listStyle: "none", margin: 0, padding: 0, gridTemplateColumns: `auto repeat(${seats}, minmax(7.5rem, 1fr))` }}
        >
          {Array.from({ length: rounds }, (_, i) => (
            <li key={`round-${i + 1}`} className="round" style={{ gridRow: i + 1, gridColumn: 1 }} role="presentation" aria-hidden="true">
              R{i + 1}
              <i>{i % 2 === 0 ? "→" : "←"}</i>
            </li>
          ))}
          {picks.map((pick) => {
            const style = toneStyle(tone(index.get(pick.franchiseId) ?? 0));
            const on = focus === pick.franchiseId && hover !== null;
            return (
              <li key={pick.overall} style={{ gridRow: pick.round, gridColumn: column(pick) }}>
                <button
                  type="button"
                  className={`node${on ? " on" : ""}${picked === pick.overall ? " picked" : ""}`}
                  style={style}
                  onMouseEnter={() => setHover(pick.franchiseId)}
                  onFocus={() => setHover(pick.franchiseId)}
                  onBlur={() => setHover(null)}
                  onClick={() => setPicked(pick.overall)}
                  aria-pressed={picked === pick.overall}
                >
                  <span className="n">
                    #{pick.overall}
                    <i>{pick.pokemon.cost} pts</i>
                  </span>
                  <Sprite id={pick.pokemon.spriteId} name={pick.pokemon.name} size={40} />
                  <b>{pick.pokemon.name}</b>
                  <small>{byId.get(pick.franchiseId)?.name ?? pick.franchiseId}</small>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      {current && team ? (
        <article className="card pick-detail" style={toneStyle(tone(index.get(team.id) ?? 0))}>
          <Sprite id={current.pokemon.spriteId} name={current.pokemon.name} size={96} />
          <div>
            <div className="meta">
              <span className="label">
                Pick {current.overall} · Round {current.round} · {current.pokemon.cost} pts
              </span>
              <Link className="team-tag" href={`/teams/${team.id}/`} style={toneStyle(tone(index.get(team.id) ?? 0))}>
                <span className="swatch" aria-hidden="true" />
                {team.name}
              </Link>
              {current.fallback ? (
                <span className="chip chip-warn" title="The model's response failed validation and the harness picked for it">
                  AUTO
                </span>
              ) : null}
            </div>
            <h3>{current.pokemon.name}</h3>
            {current.rationale ? <p className="prose">{current.rationale}</p> : <p className="hint">No reasoning recorded.</p>}
          </div>
        </article>
      ) : null}
    </div>
  );
}
