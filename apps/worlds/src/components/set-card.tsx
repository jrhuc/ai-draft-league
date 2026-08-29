import { ItemIcon } from "@/components/item-icon";
import { Sprite } from "@/components/sprite";
import { evLine, titleCase } from "@/lib/format";
import type { TeamSet } from "@/lib/tournament";

export function SetCard({ set, games }: { set: TeamSet; games: number[] | null }) {
  const bench = games !== null && games.length === 0;
  return (
    <article className={`card setcard${bench ? " bench" : ""}`}>
      <header>
        <span className="sprite-item">
          <Sprite id={set.spriteId} name={set.species} size={48} />
          {set.item ? <ItemIcon item={set.item} /> : null}
        </span>
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
        {games === null ? null : bench ? (
          <span>bench</span>
        ) : (
          <em>{games.map((n) => `G${n}`).join(" · ")}</em>
        )}
      </footer>
    </article>
  );
}
