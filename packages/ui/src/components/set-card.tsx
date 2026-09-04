import { evLine, titleCase } from "../lib/format";
import { ItemIcon } from "./item-icon";
import { Sprite } from "./sprite";

export type SetView = {
  species: string;
  spriteId: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  evs: { [stat: string]: number };
};

export function SetCard({ set, games }: { set: SetView; games?: number[] }) {
  const bench = games !== undefined && games.length === 0;
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
        {games === undefined ? null : bench ? (
          <span>bench</span>
        ) : (
          <em>{games.map((n) => `G${n}`).join(" · ")}</em>
        )}
      </footer>
    </article>
  );
}
