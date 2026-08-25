import { Link } from "react-router-dom";
import { Model } from "@/components/mark";
import { TeamTag, teamStyle } from "@/components/team";
import { franchise, playoffRoundLabel } from "@/lib/load";
import { useSeason, useTitle } from "@/lib/season-context";

export function PlayoffsPage() {
  const season = useSeason();
  useTitle("Playoffs");
  const bracket = season.playoffs;
  const champion = season.season.championId ? franchise(season, season.season.championId) : null;
  return (
    <>
      <section className="hero">
        <span className="label">Playoffs</span>
        <h1>{champion ? `${champion.name} takes the title` : "Bracket"}</h1>
        <p className="sub">
          {bracket
            ? `Top ${season.season.playoffRounds === 2 ? 4 : 2} by series record, seeded ${season.season.playoffRounds === 2 ? "1v4 and 2v3" : "1v2"}. Best-of-three throughout.`
            : "The bracket is set when the regular season ends."}
        </p>
        {champion ? <Model spec={champion.model} /> : null}
      </section>
      {bracket ? (
        <div className="bracket">
          {bracket.rounds.map((round, i) => (
            <div key={i} className="bracket-round">
              <span className="label">{playoffRoundLabel(season, i + 1)}</span>
              {round.map((slot) => {
                const href = slot.match?.seriesId ? `/matches/${slot.match.seriesId}` : null;
                const body = slot.slots.map((id, j) => {
                  const lost = slot.match?.winnerId && id && slot.match.winnerId !== id;
                  const wins = slot.match?.score?.[j];
                  return (
                    <span
                      key={j}
                      className={`bracket-slot${lost ? " lost" : ""}`}
                      style={id ? teamStyle(season, id) : undefined}
                    >
                      {id ? (
                        <TeamTag id={id} link={false} muted={Boolean(lost)} />
                      ) : (
                        <span style={{ color: "var(--t5)" }}>TBD</span>
                      )}
                      <span className="num">{wins ?? ""}</span>
                    </span>
                  );
                });
                return (
                  <div key={slot.seriesIndex} className="card bracket-match">
                    {href ? (
                      <Link to={href}>
                        {body}
                        <span className="go">Watch →</span>
                      </Link>
                    ) : (
                      <div>{body}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
