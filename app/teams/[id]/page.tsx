import Link from "next/link";
import { MatchRow } from "@/components/match-list";
import { Model } from "@/components/mark";
import { SetCard } from "@/components/set-card";
import { Sprite } from "@/components/sprite";
import { TeamTag, teamStyle } from "@/components/team";
import { franchise, franchiseName, matchesFor, monName, season } from "@/lib/load";

export function generateStaticParams() {
  return season.franchises.map((team) => ({ id: team.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: franchise(id).name };
}

const ACQUIRED = { draft: "Drafted", trade: "Traded for", "free-agency": "Signed" };

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const team = franchise(id);
  const standing = season.standings.find((row) => row.franchiseId === team.id);
  const rows = matchesFor(team.id);
  const review = season.reviews.find((entry) => entry.franchiseId === team.id);
  return (
    <>
      <section className="hero team-hero" style={teamStyle(team.id)}>
        <span className="label">
          {standing ? `#${standing.rank} · ` : ""}
          {team.record.seriesWins}–{team.record.seriesLosses} series · {team.record.gameWins}–{team.record.gameLosses} games
          {team.finish ? ` · ${team.finish}` : ""}
        </span>
        <h1>{team.name}</h1>
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
          <p>Open a row for the pick reasoning.</p>
        </div>
        <div className="card roster">
          {team.roster.map((slot) => (
            <details key={slot.id} className="roster-row">
              <summary>
                <Sprite id={slot.spriteId} name={slot.name} size={40} />
                <b>{slot.name}</b>
                <span className="sub">
                  {ACQUIRED[slot.acquired]}
                  {slot.overallPick !== null ? ` · pick ${slot.overallPick}` : ""} · {slot.cost} pts
                </span>
                {slot.fallback ? <span className="chip chip-warn">AUTO</span> : null}
              </summary>
              <p>{slot.rationale || "No reasoning recorded."}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Season</h2>
          <p>Each series shows the six the model registered and why. Open the match for the games.</p>
        </div>
        {rows.map(({ match, label, href }) => {
          const build = match.builds.find((entry) => entry.franchiseId === team.id);
          const opponent = match.franchises.find((id) => id !== team.id) ?? null;
          return (
            <article key={match.id} className="section build">
              <div className="week-head">
                <h3>{label}</h3>
                {opponent ? (
                  <span className="hint">
                    vs <TeamTag id={opponent} />
                  </span>
                ) : null}
              </div>
              <MatchRow match={match} href={href} turns />
              {build ? (
                <details>
                  <summary>
                    Team sheet{build.sets === null ? " (closed until the season ends)" : ""}
                    {build.attempts > 1 ? ` · ${build.attempts} attempts to produce a legal team` : ""}
                  </summary>
                  <p className="rationale">{build.rationale || "No build reasoning recorded."}</p>
                  {build.sets ? (
                    <div className="grid grid-3">
                      {build.sets.map((set) => (
                        <SetCard key={set.species} set={set} games={null} />
                      ))}
                    </div>
                  ) : (
                    <p className="closed-note">
                      Registered: {build.prepared.map(monName).join(", ")}. Full sets stay hidden while the season is live so opponents can’t read them here.
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
            <p>Written by the model after its last game.{review.fallback ? " Auto-generated after the model failed to answer." : ""}</p>
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
        <Link href="/teams/">← All teams</Link>
        {season.season.championId && season.season.championId !== team.id ? <> · Champion: {franchiseName(season.season.championId)}</> : null}
      </p>
    </>
  );
}
