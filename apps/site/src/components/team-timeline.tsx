import { Link } from "react-router-dom";
import { MatchRow } from "./match-list";
import { buildChanges } from "@/lib/build-changes";
import { matchesFor, monName } from "@/lib/load";
import type { Season } from "@/lib/season";
import { weeklyReviewsForFranchise } from "@/lib/weekly-reviews";

type Review = ReturnType<typeof weeklyReviewsForFranchise>[number];

function ReviewNote({ review }: { review: Review }) {
  return (
    <details className="timeline-review">
      <summary>{review.stageLabel}</summary>
      <p className="prose">{review.reasoningText}</p>
      <p className="hint">
        Roster version {review.rosterVersion} · Memory: {review.memoryPages} pages,{" "}
        {review.memoryCharacters.toLocaleString("en-US")} characters
      </p>
    </details>
  );
}

export function TeamTimeline({ season, id }: { season: Season; id: string }) {
  const rows = matchesFor(season, id).filter(
    (row) => row.week && row.week.number <= season.season.releasedThroughWeek,
  );
  const reviews = weeklyReviewsForFranchise(season.weeklyReviews, id);
  const weeks = [
    ...new Set([...rows.map((row) => row.week!.number), ...reviews.map((review) => review.week)]),
  ].sort((a, b) => a - b);
  if (!weeks.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>Adaptation timeline</h2>
        <p>
          Registered-team changes, model-authored reviews, and roster moves in order. Results do not
          establish which changes helped.
        </p>
      </div>
      <ol className="team-timeline">
        {weeks.map((week) => {
          const window = season.transactions.find((entry) => entry.afterWeek === week);
          const trades =
            window?.offers.filter(
              (offer) => offer.accepted && (offer.from === id || offer.to === id),
            ) ?? [];
          const swaps = window?.moves.find((move) => move.franchiseId === id)?.swaps ?? [];
          return (
            <li key={week} className="card card-pad">
              <h3>Week {week}</h3>
              {rows
                .filter((row) => row.week!.number === week)
                .map((row) => {
                  const build = row.match.builds.find((entry) => entry.franchiseId === id);
                  const prior = rows
                    .slice(0, rows.indexOf(row))
                    .findLast((entry) =>
                      entry.match.builds.some((entry) => entry.franchiseId === id),
                    );
                  const previous = prior?.match.builds.find((entry) => entry.franchiseId === id);
                  const changes = build && previous ? buildChanges(previous, build) : null;
                  return (
                    <div key={row.match.id}>
                      <MatchRow match={row.match} href={row.href} />
                      {build ? (
                        <>
                          <a href={`#build-${row.match.id}`}>Registered team and stated reason</a>
                          {changes ? (
                            <details className="timeline-diff">
                              <summary>
                                Changes since {prior!.label.toLowerCase()} · {changes.added.length}{" "}
                                in, {changes.removed.length} out
                                {changes.setsVisible
                                  ? `, ${changes.sets.length} set fields changed`
                                  : " · set details unavailable"}
                              </summary>
                              {changes.added.length ? (
                                <p>
                                  Registered:{" "}
                                  {changes.added.map((mon) => monName(season, mon)).join(", ")}
                                </p>
                              ) : null}
                              {changes.removed.length ? (
                                <p>
                                  No longer registered:{" "}
                                  {changes.removed.map((mon) => monName(season, mon)).join(", ")}
                                </p>
                              ) : null}
                              {changes.sets.length ? (
                                <div className="timeline-table">
                                  <table>
                                    <thead>
                                      <tr>
                                        <th>Pokémon</th>
                                        <th>Field</th>
                                        <th>Before</th>
                                        <th>After</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {changes.sets.map((change) => (
                                        <tr key={`${change.species}-${change.field}`}>
                                          <th>{change.species}</th>
                                          <td>{change.field}</td>
                                          <td>{change.before}</td>
                                          <td>{change.after}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : null}
                              <p className="hint">
                                Registration changes are not roster trades or swaps.
                              </p>
                            </details>
                          ) : (
                            <p className="hint">First released registered team.</p>
                          )}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              {reviews
                .filter((review) => review.week === week && review.stage === "week")
                .map((review) => (
                  <ReviewNote key={`${review.stage}-${review.rosterVersion}`} review={review} />
                ))}
              {window ? (
                <div className="timeline-transactions">
                  <Link to={`/transactions#after-week-${week}`}>
                    Transactions after week {week}
                  </Link>
                  {trades.map((trade, index) => {
                    if (trade.give === null || trade.get === null || trade.to === null)
                      throw new Error("accepted trade is missing its exchange");
                    return (
                      <p key={index}>
                        Traded {monName(season, trade.from === id ? trade.give : trade.get)} for{" "}
                        {monName(season, trade.from === id ? trade.get : trade.give)}
                      </p>
                    );
                  })}
                  {swaps.map((swap) => (
                    <p key={`${swap.drop}-${swap.add}`}>
                      Swapped {monName(season, swap.drop)} for {monName(season, swap.add)}
                    </p>
                  ))}
                  {!trades.length && !swaps.length ? (
                    <p className="hint">No completed roster moves.</p>
                  ) : null}
                </div>
              ) : null}
              {reviews
                .filter((review) => review.week === week && review.stage === "transactions")
                .map((review) => (
                  <ReviewNote key={`${review.stage}-${review.rosterVersion}`} review={review} />
                ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
