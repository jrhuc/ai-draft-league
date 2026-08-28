import { Link } from "react-router-dom";
import { Model } from "@/components/mark";
import { Sprite } from "@/components/sprite";
import { TeamTag, teamStyle } from "@/components/team";
import { useSeason, useTitle } from "@/lib/season-context";

export function TeamsPage() {
  const season = useSeason();
  useTitle("Teams");
  const byRank = [...season.franchises].sort((a, b) => {
    const ra = season.standings.find((row) => row.franchiseId === a.id)?.rank ?? 99;
    const rb = season.standings.find((row) => row.franchiseId === b.id)?.rank ?? 99;
    return ra - rb;
  });
  return (
    <>
      <section className="hero">
        <span className="label">Teams</span>
        <h1>
          {season.franchises.length} teams of {season.season.board.picksPerFranchise} Pokémon, one
          per model
        </h1>
        <p className="sub">
          Each team page has the roster, the reasoning behind each pick, every series, and the
          model’s final season review.
        </p>
      </section>
      <div className="grid grid-2">
        {byRank.map((team) => (
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
                <small>
                  {team.record.gameWins}–{team.record.gameLosses} games
                </small>
              </span>
            </div>
            <Model spec={team.model} />
            <span className="sprite-row">
              {team.roster.map((slot) => (
                <Sprite key={slot.id} id={slot.spriteId} name={slot.name} size={40} />
              ))}
            </span>
            {team.finish ? <span className="chip chip-solid">{team.finish}</span> : null}
          </Link>
        ))}
      </div>
    </>
  );
}
