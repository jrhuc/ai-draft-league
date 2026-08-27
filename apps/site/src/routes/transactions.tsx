import { TeamTag } from "@/components/team";
import { franchiseName, monName } from "@/lib/load";
import { useSeason, useTitle } from "@/lib/season-context";

export function TransactionsPage() {
  const season = useSeason();
  useTitle("Transactions");
  const windows = season.transactions;
  return (
    <>
      <section className="hero">
        <span className="label">Transactions</span>
        <h1>Trades and free agency</h1>
        <p className="sub">
          Mid-season, each team may offer one trade and then swap from the undrafted pool. Each
          offer shows the message the model sent and the reasoning it kept private.
        </p>
      </section>
      {windows.length === 0 ? (
        <p className="card card-pad hint">
          {season.season.status === "complete"
            ? "This season had no transaction window."
            : "No transaction window has been released yet."}
        </p>
      ) : null}
      {windows.map((window) => (
        <section key={window.afterWeek} className="section">
          <div className="section-head">
            <h2>After week {window.afterWeek}</h2>
            <p className="order">
              Order:{" "}
              {window.order.map((id, i) => (
                <span key={id}>
                  {i > 0 ? " → " : ""}
                  <TeamTag id={id} />
                </span>
              ))}
            </p>
          </div>
          <h3 className="label">Offers</h3>
          <div className="grid">
            {window.offers.map((offer, i) => (
              <article key={`${offer.from}-${i}`} className="card card-pad offer">
                <div className="line">
                  <TeamTag id={offer.from} />
                  {offer.to ? (
                    <>
                      <span className="arrow">
                        offers <b>{offer.give ? monName(season, offer.give) : "—"}</b> for{" "}
                        <b>{offer.get ? monName(season, offer.get) : "—"}</b> to
                      </span>
                      <TeamTag id={offer.to} />
                      {offer.accepted === true ? (
                        <span className="chip chip-good">Accepted</span>
                      ) : offer.accepted === false ? (
                        <span className="chip chip-bad">Declined</span>
                      ) : (
                        <span className="chip">No answer</span>
                      )}
                    </>
                  ) : (
                    <span className="arrow">made no offer</span>
                  )}
                </div>
                {offer.message ? <blockquote>“{offer.message}”</blockquote> : null}
                <div className="why">
                  <b>{franchiseName(season, offer.from)} privately:</b>{" "}
                  {offer.offerReasoning || "—"}
                </div>
                {offer.to && offer.responseReasoning ? (
                  <div className="why">
                    <b>{franchiseName(season, offer.to)} privately:</b> {offer.responseReasoning}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <h3 className="label" style={{ marginTop: 24 }}>
            Free agency
          </h3>
          <div className="grid">
            {window.moves.map((move) => (
              <article key={move.franchiseId} className="card card-pad offer">
                <div className="line">
                  <TeamTag id={move.franchiseId} />
                  {move.swaps.length === 0 ? <span className="arrow">stood pat</span> : null}
                  {move.swapsRemaining !== null ? (
                    <span className="chip">
                      {move.swapsRemaining}
                      {season.season.swapsAllowed !== null
                        ? ` of ${season.season.swapsAllowed}`
                        : ""}{" "}
                      swaps left
                    </span>
                  ) : null}
                  {move.fallback ? <span className="chip chip-warn">AUTO</span> : null}
                </div>
                {move.swaps.map((swap) => (
                  <div key={`${swap.drop}-${swap.add}`} className="swap">
                    <span className="drop">− {monName(season, swap.drop)}</span>
                    <span className="add">+ {monName(season, swap.add)}</span>
                  </div>
                ))}
                {move.reasoning ? (
                  <div className="why">
                    <b>Why:</b> {move.reasoning}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
