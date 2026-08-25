import { Link } from "react-router-dom";
import { TeamTag } from "@/components/team";
import type { Match } from "@/lib/season";

function Side({ id, match, right }: { id: string; match: Match; right?: boolean }) {
  const lost = match.winnerId !== null && match.winnerId !== id;
  return (
    <span className={`side${right ? " right" : ""}${lost ? " lost" : ""}`}>
      <span className="name">
        <TeamTag id={id} link={false} muted={lost} />
      </span>
    </span>
  );
}

export function MatchRow({
  match,
  href,
  turns,
}: {
  match: Match;
  href: string | null;
  turns?: boolean;
}) {
  const [a, b] = match.franchises;
  const totalTurns = match.games.reduce((sum, game) => sum + game.turns, 0);
  const body = (
    <>
      <Side id={a} match={match} />
      <span className="score">
        {match.score ? `${match.score[0]}–${match.score[1]}` : "vs"}
        {match.score && turns ? <small>{totalTurns} turns</small> : null}
      </span>
      <Side id={b} match={match} right />
      <span className="go">{match.status === "complete" ? "Watch →" : "Upcoming"}</span>
    </>
  );
  return href ? (
    <Link className="card match-row" to={href}>
      {body}
    </Link>
  ) : (
    <div className="card match-row">{body}</div>
  );
}
