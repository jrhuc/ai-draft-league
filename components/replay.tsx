"use client";

import { useEffect, useMemo, useState } from "react";
import { Sprite } from "@/components/sprite";
import { displaySpecies, seconds, spriteKey, statusLabel, toneStyle, tokens } from "@/lib/format";
import type { Decision, Replay, ReplayEvent, ReplayGame } from "@/lib/season";

type Team = { id: string; name: string; tone: string };
type FieldSlot = { species: string; hp: number; status: string | null; fainted: boolean } | null;
type SideState = { preview: string[]; slots: FieldSlot[]; seen: Map<string, { hp: number; fainted: boolean }> };

function reduce(events: ReplayEvent[], upTo: number): [SideState, SideState] {
  const sides: [SideState, SideState] = [
    { preview: [], slots: [null, null], seen: new Map() },
    { preview: [], slots: [null, null], seen: new Map() },
  ];
  for (const event of events.slice(0, upTo)) {
    if (!event.actor) continue;
    const side = sides[event.actor.side];
    if (event.kind === "preview" && event.species) {
      side.preview.push(event.species);
      continue;
    }
    const slot = side.slots[event.actor.slot] ?? null;
    if (event.kind === "switch" && event.species) {
      const prior = side.seen.get(event.species);
      const next = { species: event.species, hp: event.hp ?? prior?.hp ?? 100, status: event.status ?? null, fainted: false };
      side.slots[event.actor.slot] = next;
      side.seen.set(event.species, { hp: next.hp, fainted: false });
      continue;
    }
    if (!slot) continue;
    if (event.species && event.kind === "detail") slot.species = event.species;
    if (event.hp !== undefined) slot.hp = event.hp;
    if (event.status !== undefined) slot.status = event.status;
    if (event.kind === "faint") {
      slot.fainted = true;
      slot.hp = 0;
    }
    side.seen.set(slot.species, { hp: slot.hp, fainted: slot.fainted });
  }
  return sides;
}

function hpClass(hp: number): string {
  return hp <= 25 ? "low" : hp <= 50 ? "mid" : "";
}

function Slot({ slot, sprite }: { slot: FieldSlot; sprite: (species: string) => string | null }) {
  if (!slot) {
    return (
      <div className="slot empty">
        <span className="sprite-fallback" style={{ width: 48, height: 48 }} aria-hidden="true" />
        <span>empty</span>
      </div>
    );
  }
  return (
    <div className={`slot${slot.fainted ? " fainted" : ""}`}>
      <Sprite id={sprite(slot.species)} name={slot.species} size={48} />
      <div>
        <b>{displaySpecies(slot.species)}</b>
        <span>
          {slot.fainted ? "fainted" : `${slot.hp}%`}
          {slot.status && !slot.fainted ? ` · ${statusLabel(slot.status)}` : ""}
        </span>
        <div className="hp">
          <i className={hpClass(slot.hp)} style={{ width: `${slot.hp}%` }} />
        </div>
      </div>
    </div>
  );
}

function narrate(text: string, teams: [Team, Team]): string {
  return text.replace(/\bP([12])\b/g, (_, n: string) => teams[Number(n) - 1]!.name).replace(/\b([A-Z][a-z]+(?:-[A-Za-z]+)*)-Mega(?:-([XY]))?\b/g, (_, base: string, form?: string) => `Mega ${base}${form ? ` ${form}` : ""}`);
}

function DecisionRow({ decision, team, position }: { decision: Decision; team: Team; position: number }) {
  const choice = decision.action && decision.phase ? `${decision.phase}: ${decision.action}` : decision.action || decision.phase;
  const context = decision.turn === 0 ? "team preview" : `turn ${decision.turn}`;
  const rationaleLabel = `${team.name} rationale for ${choice}, ${context}, decision ${position + 1}`;
  return (
    <div className="dec" style={toneStyle(team.tone)}>
      <span className="who">{team.name}</span>
      <span className="act">{decision.action || decision.phase}</span>
      <span className="meta">
        {decision.automatic ? <span className="chip chip-solid">AUTO</span> : null}
        {decision.fallback && !decision.automatic ? <span className="chip chip-warn">fallback</span> : null}
        {seconds(decision.latencyMs)}
        {decision.reasoningTokens !== null ? `· ${tokens(decision.reasoningTokens)} reasoning tok` : ""}
      </span>
      {decision.rationale ? (
        <details>
          <summary aria-label={rationaleLabel}>why</summary>
          <p>{decision.rationale}</p>
        </details>
      ) : null}
    </div>
  );
}

function Game({ game, teams, sprite }: { game: ReplayGame; teams: [Team, Team]; sprite: (species: string) => string | null }) {
  const [cursor, setCursor] = useState(game.events.length);
  const [playing, setPlaying] = useState(false);
  const total = game.events.length;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCursor((value) => {
        const next = Math.min(total, value + 1);
        if (next >= total) setPlaying(false);
        return next;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [playing, total]);

  const sides = useMemo(() => reduce(game.events, cursor), [game.events, cursor]);
  const shown = game.events.slice(0, cursor);
  const currentTurn = shown.length ? shown[shown.length - 1]!.turn : 0;
  const decisionsByTurn = useMemo(() => {
    const map = new Map<number, Array<{ decision: Decision; position: number }>>();
    for (const [position, decision] of game.decisions.entries()) {
      const list = map.get(decision.turn) ?? [];
      list.push({ decision, position });
      map.set(decision.turn, list);
    }
    return map;
  }, [game.decisions]);
  const turns: Array<{ turn: number; events: ReplayEvent[] }> = [];
  for (const event of shown) {
    const last = turns[turns.length - 1];
    if (!last || last.turn !== event.turn) turns.push({ turn: event.turn, events: [event] });
    else last.events.push(event);
  }
  const teamFor = (id: string) => (teams[0].id === id ? teams[0] : teams[1]);
  const finished = cursor >= total;

  return (
    <div className="replay">
      <div className="field">
        {sides.map((side, index) => {
          const team = teams[index]!;
          return (
            <section key={team.id} className="card field-side" style={toneStyle(team.tone)} aria-label={`${team.name} field`}>
              <div className="who">
                <span className="team-tag" style={toneStyle(team.tone)}>
                  <span className="swatch" aria-hidden="true" />
                  {team.name}
                </span>
                <span className="bench" role="group" aria-label="Registered">
                  {side.preview.map((species) => {
                    const seen = side.seen.get(species);
                    return <Sprite key={species} id={sprite(species)} name={species} size={24} className={seen?.fainted ? "out" : ""} />;
                  })}
                </span>
              </div>
              <div className="slots">
                <Slot slot={side.slots[0] ?? null} sprite={sprite} />
                <Slot slot={side.slots[1] ?? null} sprite={sprite} />
              </div>
            </section>
          );
        })}
      </div>

      <div className="transport">
        <button type="button" onClick={() => setCursor(0)} disabled={cursor === 0} aria-label="Back to start">
          ⏮
        </button>
        <button
          type="button"
          onClick={() => {
            if (finished) setCursor(0);
            setPlaying((value) => !value);
          }}
        >
          {playing ? "Pause" : finished ? "Replay" : "Play"}
        </button>
        <button type="button" onClick={() => setCursor((value) => Math.min(total, value + 1))} disabled={finished}>
          Step
        </button>
        <input type="range" min={0} max={total} value={cursor} onChange={(event) => setCursor(Number(event.target.value))} aria-label="Position in game" />
        <span className="pos">
          {finished ? "Final" : currentTurn === 0 ? "Team preview" : `Turn ${currentTurn}`} · {cursor}/{total}
        </span>
      </div>

      <div className="turns">
        {turns.map(({ turn, events }) => (
          <section key={turn} className="turn">
            <div className="turn-head">{turn === 0 ? "Team preview" : `Turn ${turn}`}</div>
            {(decisionsByTurn.get(turn) ?? []).map(({ decision, position }) => (
              <DecisionRow key={`${turn}-${decision.franchiseId}-${position}`} decision={decision} team={teamFor(decision.franchiseId)} position={position} />
            ))}
            <div className="log">
              {events
                .filter((event) => event.kind !== "turn")
                .map((event, i) => (
                  <div key={i} className={event.kind}>
                    {narrate(event.text, teams)}
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>

      {finished && game.reflections.length > 0 ? (
        <div className="reflections">
          {game.reflections.map((reflection) => {
            const team = teamFor(reflection.franchiseId);
            return (
              <article key={reflection.franchiseId} className="card reflection" style={toneStyle(team.tone)}>
                <div className="who" style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                  <span className="team-tag" style={toneStyle(team.tone)}>
                    <span className="swatch" aria-hidden="true" />
                    {team.name}
                  </span>
                  <span className={`chip ${reflection.result === "won" ? "chip-good" : "chip-bad"}`}>{reflection.result}</span>
                </div>
                <p>{reflection.summary}</p>
                {reflection.adjustment ? <p className="next">{reflection.adjustment}</p> : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ReplayViewer({ replay, teams, sprites }: { replay: Replay; teams: [Team, Team]; sprites: Array<[string, string]> }) {
  const [index, setIndex] = useState(0);
  const lookup = useMemo(() => new Map(sprites), [sprites]);
  const sprite = (species: string): string | null => lookup.get(spriteKey(species)) ?? null;
  const game = replay.games[index] ?? replay.games[0];
  if (!game) return null;
  return (
    <div className="section">
      <div className="game-tabs" role="group" aria-label="Games">
        {replay.games.map((entry, i) => (
          <button key={entry.number} type="button" aria-pressed={i === index} onClick={() => setIndex(i)}>
            Game {entry.number}
            <small>{entry.turns} turns</small>
          </button>
        ))}
      </div>
      <Game key={game.number} game={game} teams={teams} sprite={sprite} />
    </div>
  );
}
