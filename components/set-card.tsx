import { Sprite } from "@/components/sprite";
import { evLine, titleCase } from "@/lib/format";
import type { BuildSet } from "@/lib/season";

export function SetCard({ set, games }: { set: BuildSet; games: number[] | null }) {
  const bench = games !== null && games.length === 0;
  return (
    <article className={`card setcard${bench ? " bench" : ""}`}>
      <header>
        <Sprite id={set.spriteId} name={set.species} size={48} />
        <div>
          <b>{set.species}</b>
          <small>
            {set.ability} · {titleCase(set.nature)}
            {set.item ? ` · ${set.item}` : ""}
          </small>
        </div>
      </header>
      <ul>
        {set.moves.map((move) => (
          <li key={move}>{move}</li>
        ))}
      </ul>
      <footer>
        <span>{evLine(set.evs) || "no investment"}</span>
        {games === null ? null : bench ? <span>bench</span> : <em>{games.map((n) => `G${n}`).join(" · ")}</em>}
      </footer>
    </article>
  );
}
