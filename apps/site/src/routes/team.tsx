import { Link, useParams } from "react-router-dom";
import { MatchRow } from "@/components/match-list";
import { TeamTimeline } from "@/components/team-timeline";
import { Mark, Model } from "ui/components/mark";
import { SetCard } from "ui/components/set-card";
import { Sprite } from "ui/components/sprite";
import { teamStyle } from "@/components/team";
import { franchise, franchiseName, matchesFor, monName } from "@/lib/load";
import { useSeason, useTitle } from "@/lib/season-context";
import { NotFoundPage } from "@/routes/not-found";

const ACQUIRED = {
  draft: { label: "Drafted", className: "acq-draft" },
  trade: { label: "Traded for", className: "acq-trade" },
  "free-agency": { label: "Signed", className: "acq-signed" },
} as const;

export function TeamPage() {
  const season = useSeason();
  const { id } = useParams();
  if (!id || !season.franchises.some((team) => team.id === id)) return <NotFoundPage />;
  return <TeamPageBody id={id} />;
}

function TeamPageBody({ id }: { id: string }) {
  const season = useSeason();
  const team = franchise(season, id);
  useTitle(team.name);
  const standing = season.standings.find((row) => row.franchiseId === team.id);
  const rows = matchesFor(season, team.id);
  const review = season.reviews.find((entry) => entry.franchiseId === team.id);
  return (
    <>
      <section className="hero">
        <span className="label">
          {standing ? `#${standing.rank} · ` : ""}
          {team.record.seriesWins}–{team.record.seriesLosses} series · {team.record.gameWins}–
          {team.record.gameLosses} games
          {team.finish ? ` · ${team.finish}` : ""}
        </span>
        <h1 style={teamStyle(season, team.id)}>
          <span className="title-tag">
            <Mark spec={team.model} size="0.72em" tone />
            {team.name}
          </span>
        </h1>
        <div className="hero-row">
          <Model spec={team.model} />
          <span className="hint">
            {team.budget.spent} of {team.budget.total} points spent
          </span>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Roster</h2>
          <p>Open a row for the model's stated reason at the pick.</p>
        </div>
        <div className="card roster">
          {team.roster.map((slot) => (
            <details key={slot.id} className="roster-row">
              <summary>
                <Sprite id={slot.spriteId} name={slot.name} size={40} />
                <b>{slot.name}</b>
                <span className="sub">
                  <span className={`acq ${ACQUIRED[slot.acquired].className}`}>
                    {ACQUIRED[slot.acquired].label}
                  </span>
                  {slot.overallPick !== null ? ` · pick ${slot.overallPick}` : ""} · {slot.cost} pts
                </span>
                <span className="why" aria-hidden="true">
                  stated reason
                </span>
              </summary>
              <p>{slot.rationale || "No stated reason recorded."}</p>
            </details>
          ))}
        </div>
      </section>

      <TeamTimeline season={season} id={id} />
      <section className="section">
        <div className="section-head">
          <h2>Registered teams</h2>
          <p>
            Each series shows the six Pokémon the model registered and why it chose them. Open the
            match for the games.
          </p>
        </div>
        {rows.map(({ match, label, href }) => {
          const build = match.builds.find((entry) => entry.franchiseId === team.id);
          return (
            <article key={match.id} id={`build-${match.id}`} className="section build">
              <div className="week-head">
                <h3>{label}</h3>
              </div>
              <MatchRow match={match} href={href} turns />
              {build ? (
                <details>
                  <summary>
                    Team sheet{build.sets === null ? " (closed until the season ends)" : ""}
                    {build.attempts > 1
                      ? ` · ${build.attempts} attempts to produce a legal team`
                      : ""}
                  </summary>
                  <p className="rationale">{build.rationale || "No stated reason recorded."}</p>
                  {build.sets ? (
                    <div className="grid grid-3">
                      {build.sets.map((set) => (
                        <SetCard key={set.species} set={set} />
                      ))}
                    </div>
                  ) : (
                    <p className="closed-note">
                      Registered: {build.prepared.map((mon) => monName(season, mon)).join(", ")}.
                      Full sets stay hidden while the season is live so opponents can’t read them
                      here.
                    </p>
                  )}
                </details>
              ) : null}
            </article>
          );
        })}
      </section>
      {review ? (
        <section className="section">
          <div className="section-head">
            <h2>Season review</h2>
            <p>Written by the model after its last game.</p>
          </div>
          <div className="card card-pad review">
            <p className="prose">{review.summary}</p>
            <dl>
              <dt>Went well</dt>
              <dd>{review.didWell}</dd>
              <dt>Went badly</dt>
              <dd>{review.didPoorly}</dd>
              <dt>Would change</dt>
              <dd>{review.wouldChange}</dd>
            </dl>
          </div>
        </section>
      ) : null}
      <p className="hint">
        <Link to="/teams">← All teams</Link>
        {season.season.championId && season.season.championId !== team.id ? (
          <> · Champion: {franchiseName(season, season.season.championId)}</>
        ) : null}
      </p>
    </>
  );
}
