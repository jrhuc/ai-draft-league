import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Sprite } from "@/components/sprite";
import { tone, toneStyle } from "@/lib/format";
import type { DraftPick } from "@/lib/season";

export type TeamRef = { id: string; name: string };

const HOVER_OPEN_MS = 600;

type Open = { overall: number; pinned: boolean };

export function PickPath({ picks, franchises }: { picks: DraftPick[]; franchises: TeamRef[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const timer = useRef<number | null>(null);
  const index = new Map(franchises.map((team, i) => [team.id, i]));
  const byId = new Map(franchises.map((team) => [team.id, team]));
  const seats = franchises.length;
  const rounds = Math.max(...picks.map((pick) => pick.round));
  const column = (pick: DraftPick): number => {
    const slot = (pick.overall - 1) % seats;
    return pick.round % 2 === 1 ? slot + 1 : seats - slot;
  };
  const pathStyle: CSSProperties & { "--seats": number } = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    "--seats": seats,
  };

  const cancelHoverOpen = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    if (!open?.pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".node, .pick-pop")) setOpen(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open?.pinned]);

  useEffect(() => cancelHoverOpen, []);

  return (
    <div
      className="path-wrap"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(null);
      }}
    >
      <ol
        className="path"
        data-focus={hover ? "" : undefined}
        onMouseLeave={() => setHover(null)}
        style={pathStyle}
      >
        {Array.from({ length: rounds }, (_, i) => (
          <li
            key={`round-${i + 1}`}
            className="round"
            style={{ gridRow: i * 2 + 1, gridColumn: "1 / -1" }}
            role="presentation"
            aria-hidden="true"
          >
            Round {i + 1} <i>{i % 2 === 0 ? "→" : "←"}</i>
          </li>
        ))}
        {picks.map((pick) => {
          const style = toneStyle(tone(index.get(pick.franchiseId) ?? 0));
          const on = hover !== null && hover === pick.franchiseId;
          const isOpen = open?.overall === pick.overall;
          const col = column(pick);
          const flip = col > seats / 2;
          const up = pick.round > rounds / 2;
          return (
            <li
              key={pick.overall}
              className={isOpen ? "pop-open" : undefined}
              style={{ ...style, gridRow: pick.round * 2, gridColumn: col }}
              onMouseEnter={() => {
                setHover(pick.franchiseId);
                cancelHoverOpen();
                timer.current = window.setTimeout(() => {
                  setOpen((prev) =>
                    prev?.pinned ? prev : { overall: pick.overall, pinned: false },
                  );
                }, HOVER_OPEN_MS);
              }}
              onMouseLeave={() => {
                cancelHoverOpen();
                setOpen((prev) =>
                  prev && !prev.pinned && prev.overall === pick.overall ? null : prev,
                );
              }}
            >
              <button
                type="button"
                className={`node${on ? " on" : ""}${isOpen ? " picked" : ""}`}
                onFocus={() => setHover(pick.franchiseId)}
                onBlur={() => setHover(null)}
                onClick={() =>
                  setOpen((prev) =>
                    prev?.overall === pick.overall && prev.pinned
                      ? null
                      : { overall: pick.overall, pinned: true },
                  )
                }
                aria-expanded={isOpen}
              >
                <span className="n">
                  #{pick.overall}
                  <i>{pick.pokemon.cost} pts</i>
                </span>
                <Sprite id={pick.pokemon.spriteId} name={pick.pokemon.name} size={40} />
                <b>{pick.pokemon.name}</b>
                <small>{byId.get(pick.franchiseId)?.name ?? pick.franchiseId}</small>
              </button>
              {isOpen ? (
                <div
                  className={`pick-pop${flip ? " flip" : ""}${up ? " up" : ""}`}
                  role="dialog"
                  aria-label={`Pick ${pick.overall} reasoning`}
                >
                  <div className="meta">
                    <Link className="team-tag" to={`/teams/${pick.franchiseId}/`}>
                      <span className="swatch" aria-hidden="true" />
                      {byId.get(pick.franchiseId)?.name ?? pick.franchiseId}
                    </Link>
                    {pick.fallback ? (
                      <span
                        className="chip chip-warn"
                        title="The model's response failed validation and the harness picked for it"
                      >
                        AUTO
                      </span>
                    ) : null}
                  </div>
                  <p>{pick.rationale || "No reasoning recorded."}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
