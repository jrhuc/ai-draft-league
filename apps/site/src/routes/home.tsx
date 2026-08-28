import { Link } from "react-router-dom";
import { MatchRow } from "@/components/match-list";
import { Mark, Model } from "@/components/mark";
import { Sprite } from "@/components/sprite";
import { Standings } from "@/components/standings";
import { TeamTag, teamStyle } from "@/components/team";
import { formatLabel } from "@/lib/format";
import { allMatches, franchise } from "@/lib/load";
import { useSeason, useTitle } from "@/lib/season-context";

function statusLine(s: ReturnType<typeof useSeason>["season"]): string {
  if (s.status === "complete") return "Season complete";
  if (s.status === "playoffs")
    return `Playoffs · round ${s.releasedPlayoffRounds} of ${s.playoffRounds}`;
  if (s.status === "regular-season") return `Week ${s.releasedThroughWeek} of ${s.totalWeeks}`;
  return "Draft complete";
}

export function HomePage() {
  const season = useSeason();
  useTitle();
  const s = season.season;
  const rows = allMatches(season);
  const weeks = season.weeks.filter((week) => week.matches.length > 0);
  const playoffRows = rows.filter((row) => row.week === null);
  const champion = s.championId ? franchise(season, s.championId) : null;
  const decisions = Object.values(season.replays).reduce(
    (n, replay) => n + replay.games.reduce((m, game) => m + game.decisions.length, 0),
    0,
  );
  const games = Object.values(season.replays).reduce((n, replay) => n + replay.games.length, 0);
  const transactionWeeks = new Set(season.transactions.map((window) => window.afterWeek));
  return (
    <>
      <section className="hero">
        <span className="label">{statusLine(s)}</span>
        <h1>{s.title}</h1>
        <p className="sub">
          {season.franchises.length} language models each drafted {s.board.picksPerFranchise}{" "}
          Pokémon on a {s.board.budget}-point budget. They built teams, traded, and played a{" "}
          {s.totalWeeks}-week season. Every pick, build, and turn comes with the model’s own
          reasoning.
        </p>
        <p className="sub mono">
          An exhibition season under one recorded configuration: the schedule, simulator revision,
          and provider routing never changed.
        </p>
        <dl className="facts">
          <div>
            <dt>Format</dt>
            <dd>{formatLabel(s.format)}</dd>
          </div>
          <div>
            <dt>Games</dt>
            <dd>{games}</dd>
          </div>
          <div>
            <dt>Decisions</dt>
            <dd>{decisions.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Teams</dt>
            <dd>{season.franchises.length}</dd>
          </div>
        </dl>
      </section>

      {champion ? (
        <Link
          className="champion"
          to={`/teams/${champion.id}`}
          style={teamStyle(season, champion.id)}
        >
          <span className="label">Champion</span>
          <h2>
            <span className="title-tag">
              <Mark spec={champion.model} size="0.72em" tone />
              {champion.name}
            </span>
          </h2>
          <Model spec={champion.model} />
          <span className="sprite-row">
            {champion.roster.map((slot) => (
              <Sprite key={slot.id} id={slot.spriteId} name={slot.name} size={40} />
            ))}
          </span>
        </Link>
      ) : null}

      <div className="home-grid">
        <section className="section">
          <div className="section-head">
            <h2>Standings</h2>
            <p>Top {s.playoffRounds === 2 ? 4 : 2} make the playoffs.</p>
          </div>
          <Standings compact />
        </section>

        <section className="section">
          <div className="section-head">
            <h2>Teams</h2>
            <Link to="/teams">All teams →</Link>
          </div>
          <div className="grid grid-2">
            {season.franchises.map((team) => (
              <Link
                key={team.id}
                to={`/teams/${team.id}`}
                className="card card-pad team-card"
                style={teamStyle(season, team.id)}
              >
                <div className="head">
                  <TeamTag id={team.id} link={false} title={false} />
                  <span className="record">
                    {team.record.seriesWins}–{team.record.seriesLosses}
                  </span>
                </div>
                <Model spec={team.model} />
                <span className="sprite-row">
                  {team.roster.map((slot) => (
                    <Sprite key={slot.id} id={slot.spriteId} name={slot.name} size={24} />
                  ))}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Schedule</h2>
          <p>
            Best-of-three series. Open a match to read the team sheets and the reasoning behind
            every turn.
          </p>
        </div>
        <div className="match-list">
          {weeks.map((week) => (
            <div key={week.number}>
              <div className="week-head">
                <h3>Week {week.number}</h3>
                {week.status === "scheduled" ? <span className="chip">Upcoming</span> : null}
                {transactionWeeks.has(week.number) ? (
                  <Link to="/transactions" className="chip">
                    Trade window after this week →
                  </Link>
                ) : null}
              </div>
              {week.matches.map((match) => (
                <MatchRow
                  key={match.id}
                  match={match}
                  href={match.seriesId ? `/matches/${match.seriesId}` : null}
                  turns
                />
              ))}
            </div>
          ))}
          {playoffRows.length > 0 ? (
            <div>
              <div className="week-head">
                <h3>Playoffs</h3>
                <Link to="/playoffs" className="chip">
                  Bracket →
                </Link>
              </div>
              {playoffRows.map((row) => (
                <div key={row.match.id}>
                  <span className="label" style={{ display: "block", margin: "8px 0 4px" }}>
                    {row.label}
                  </span>
                  <MatchRow match={row.match} href={row.href} turns />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
