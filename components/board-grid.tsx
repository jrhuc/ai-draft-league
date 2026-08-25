"use client";

import { useMemo, useState } from "react";
import { Sprite } from "@/components/sprite";
import { tone, toneStyle } from "@/lib/format";
import type { TeamRef } from "@/components/pick-path";
import type { BoardMon } from "@/lib/season";

const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const TYPES = ["Bug", "Dark", "Dragon", "Electric", "Fairy", "Fighting", "Fire", "Flying", "Ghost", "Grass", "Ground", "Ice", "Normal", "Poison", "Psychic", "Rock", "Steel", "Water"];

type Filter = { team: string | null; type: string | null; undrafted: boolean };

export function BoardGrid({ board, franchises }: { board: BoardMon[]; franchises: TeamRef[] }) {
  const [filter, setFilter] = useState<Filter>({ team: null, type: null, undrafted: false });
  const index = new Map(franchises.map((team, i) => [team.id, i]));
  const names = new Map(franchises.map((team) => [team.id, team.name]));
  const rows = useMemo(
    () =>
      board.filter(
        (mon) =>
          (filter.team === null || mon.draftedBy === filter.team) &&
          (filter.type === null || mon.types.includes(filter.type)) &&
          (!filter.undrafted || mon.draftedBy === null),
      ),
    [board, filter],
  );
  const drafted = board.filter((mon) => mon.draftedBy !== null).length;

  return (
    <div className="section">
      <div className="filters" role="group" aria-label="Filter the board">
        <button type="button" className="filter" aria-pressed={filter.team === null && !filter.undrafted} onClick={() => setFilter({ ...filter, team: null, undrafted: false })}>
          All {board.length}
        </button>
        <button type="button" className="filter" aria-pressed={filter.undrafted} onClick={() => setFilter({ ...filter, team: null, undrafted: !filter.undrafted })}>
          Undrafted {board.length - drafted}
        </button>
        {franchises.map((team, i) => (
          <button
            key={team.id}
            type="button"
            className="filter"
            aria-pressed={filter.team === team.id}
            onClick={() => setFilter({ ...filter, undrafted: false, team: filter.team === team.id ? null : team.id })}
          >
            <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: tone(i) }} aria-hidden="true" />
            {team.name}
          </button>
        ))}
      </div>
      <div className="filters" role="group" aria-label="Filter by type">
        {TYPES.map((type) => (
          <button key={type} type="button" className="filter" aria-pressed={filter.type === type} onClick={() => setFilter({ ...filter, type: filter.type === type ? null : type })}>
            {type}
          </button>
        ))}
      </div>
      <p className="label">
        {rows.length} of {board.length} on the board
      </p>
      <div className="grid grid-6">
        {rows.map((mon) => {
          const owner = mon.draftedBy;
          const style = owner ? toneStyle(tone(index.get(owner) ?? 0)) : undefined;
          return (
            <article key={mon.id} className={`card hoverable board-mon${owner ? " taken" : ""}`} style={style}>
              <Sprite id={mon.spriteId} name={mon.name} size={48} />
              <div>
                <div className="head">
                  <b>{mon.name}</b>
                  <span className="cost">{mon.cost}</span>
                </div>
                <span className="types">
                  {mon.types.map((type) => (
                    <span key={type} className="type">
                      {type}
                    </span>
                  ))}
                </span>
                <div style={{ marginTop: "0.2rem" }}>{mon.megaStone ? `${mon.megaStone}` : mon.abilities.join(" · ")}</div>
              </div>
              <div className="stats">
                {STATS.map((stat) => (
                  <div key={stat}>
                    <span>{stat}</span>
                    <b>{mon.baseStats[stat] ?? "–"}</b>
                  </div>
                ))}
              </div>
              <div className="owner">{owner ? names.get(owner) : "undrafted"}</div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
