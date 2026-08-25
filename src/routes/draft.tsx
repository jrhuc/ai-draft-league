import { BoardGrid } from "@/components/board-grid";
import { PickPath } from "@/components/pick-path";
import { useSeason, useTitle } from "@/lib/season-context";

export function DraftPage() {
  const season = useSeason();
  useTitle("Draft");
  const picks = season.draft.picks;
  const auto = picks.filter((pick) => pick.fallback).length;
  const drafted = season.board.filter((mon) => mon.draftedBy !== null).length;
  const teams = season.franchises.map(({ id, name }) => ({ id, name }));
  return (
    <>
      <section className="hero">
        <span className="label">Draft</span>
        <h1>{picks.length} picks, snake order</h1>
        <p className="sub">
          Hover or focus a pick to follow its team through the draft; click it to read the model’s
          reasoning.{" "}
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
            {drafted} of {season.board.length} Pokémon drafted · {season.season.board.budget} points
            per team
          </p>
        </div>
        <BoardGrid board={season.board} franchises={teams} />
      </section>
    </>
  );
}
