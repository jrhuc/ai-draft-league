import { BoardGrid } from "@/components/board-grid";
import { PickPath } from "@/components/pick-path";
import { useSeason, useTitle } from "@/lib/season-context";

export function DraftPage() {
  const season = useSeason();
  useTitle("Draft");
  const picks = season.draft.picks;
  const auto = picks.filter((pick) => pick.fallback).length;
  const drafted = season.board.filter((mon) => mon.draftedBy !== null).length;
  const teams = season.franchises.map(({ id, name, model }) => ({ id, name, model }));
  return (
    <>
      <section className="hero">
        <span className="label">Draft</span>
        <h1>{picks.length} picks in snake draft order</h1>
        <p className="sub">
          Hover a pick to trace its team through the draft. Click it, or linger a moment, to read
          the model’s reasoning.{" "}
          {auto > 0
            ? `${auto} pick${auto === 1 ? "" : "s"} fell to the auto-picker after the model’s choice was illegal.`
            : "Every pick was the model’s own."}
        </p>
      </section>
      <section className="section">
        <PickPath picks={picks} franchises={teams} />
      </section>
      <section className="section">
        <div className="section-head">
          <h2>Board</h2>
          <p>
            {drafted} of {season.board.length} Pokémon were drafted. Each team had{" "}
            {season.season.board.budget} points to spend.
          </p>
        </div>
        <BoardGrid board={season.board} franchises={teams} />
      </section>
    </>
  );
}
