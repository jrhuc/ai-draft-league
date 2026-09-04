import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Mark, Model } from "ui/components/mark";
import { ReplayViewer, type Team } from "ui/components/replay";
import { SetCard } from "ui/components/set-card";
import { tone } from "ui/lib/format";
import { TeamTag, teamStyle } from "@/components/team";
import { franchise, franchiseIndex, matchBySeries, monName } from "@/lib/load";
import type { Match } from "@/lib/season";
import { useSeason, useTitle } from "@/lib/season-context";
import { NotFoundPage } from "@/routes/not-found";

function broughtGames(match: Match, side: 0 | 1, draftId: string): number[] {
  return match.games
    .filter((game) => game.brought[side].includes(draftId))
    .map((game) => game.number);
}

export function MatchPage() {
  const season = useSeason();
  const { seriesId } = useParams();
  const row = seriesId ? matchBySeries(season, seriesId) : null;
  const replay = seriesId ? season.replays[seriesId] : undefined;
  if (!seriesId || !row || !replay) return <NotFoundPage />;
  return <MatchPageBody seriesId={seriesId} />;
}

function MatchPageBody({ seriesId }: { seriesId: string }) {
  const season = useSeason();
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const row = matchBySeries(season, seriesId);
  const replay = season.replays[seriesId];
  if (!row || !replay) throw new Error(`series ${seriesId} is not released`);
  const { match, label } = row;
  const [a, b] = match.franchises;
  useTitle(`${franchise(season, a).name} vs ${franchise(season, b).name} · ${label}`);
  const team = (id: string): Team => ({
    id,
    name: franchise(season, id).name,
    tone: tone(franchiseIndex(season, id)),
    model: franchise(season, id).model,
  });
  const teams: [Team, Team] = [team(a), team(b)];
  const teamFor = (id: string | null): Team | null =>
    teams.find((entry) => entry.id === id) ?? null;
  const games = replay.games.map((game) => ({
    ...game,
    winner: teamFor(game.winnerId),
    decisions: game.decisions.map((decision) => ({
      ...decision,
      team: team(decision.franchiseId),
    })),
    reflections: game.reflections.map((reflection) => ({
      ...reflection,
      team: team(reflection.franchiseId),
    })),
  }));
  function Side({ id, right = false }: { id: string; right?: boolean }) {
    const lost = match.winnerId !== null && match.winnerId !== id;
    return (
      <div
        className={`side${right ? " right" : ""}${lost ? " lost" : ""}`}
        style={teamStyle(season, id)}
      >
        <h2>
          <Link className="title-tag" to={`/teams/${id}`}>
            <Mark spec={franchise(season, id).model} size="0.72em" tone />
            {franchise(season, id).name}
          </Link>
        </h2>
        <Model spec={franchise(season, id).model} />
      </div>
    );
  }
  return (
    <>
      <section className="hero match-hero">
        <h1 className="label">{label}</h1>
        <Side id={a} />
        <div className="big-score">
          {match.score ? `${match.score[0]}–${match.score[1]}` : "vs"}
          <small>{match.games.map((game) => `G${game.number} ${game.turns}t`).join(" · ")}</small>
        </div>
        <Side id={b} right />
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Replay</h2>
          <p>
            Replay via <a href="https://pokemonshowdown.com/">Pokémon Showdown</a>. Model reasoning
            follows each turn. AUTO marks a forced choice.
          </p>
        </div>
        <ReplayViewer
          games={games}
          teams={teams}
          sheets={
            <details
              className="sheets"
              open={sheetsOpen}
              onToggle={(event) => setSheetsOpen(event.currentTarget.open)}
            >
              <summary>
                Team sheets
                <span className="hint">
                  The 6 registered before the series, 4 brought per game.
                  {season.season.sheets === "closed" && season.season.status !== "complete"
                    ? " Full sets are published when the season ends."
                    : ""}
                </span>
              </summary>
              <div className="two-col">
                {([0, 1] as const).map((side) => {
                  const build = match.builds[side];
                  if (!build) throw new Error(`match ${match.id} has no build for side ${side}`);
                  return (
                    <div
                      key={build.franchiseId}
                      className="build"
                      style={teamStyle(season, build.franchiseId)}
                    >
                      {build.attempts > 1 ? (
                        <span className="chip chip-warn">{build.attempts} attempts</span>
                      ) : null}
                      <details>
                        <summary>Why this team</summary>
                        <p className="rationale">
                          {build.rationale || "No build reasoning recorded."}
                        </p>
                      </details>
                      {build.sets ? (
                        <div className="grid grid-2">
                          {build.sets.map((set, index) => {
                            const draftId = build.prepared[index];
                            if (!draftId)
                              throw new Error(
                                `build ${build.franchiseId} has a set without a draft pick`,
                              );
                            return (
                              <SetCard
                                key={draftId}
                                set={set}
                                games={broughtGames(match, side, draftId)}
                              />
                            );
                          })}
                        </div>
                      ) : (
                        <p className="closed-note">
                          Registered: {build.prepared.map((mon) => monName(season, mon)).join(", ")}
                          .
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          }
        />
      </section>

      {match.games.some((game) => game.brought[0].length || game.brought[1].length) ? (
        <section className="section">
          <div className="section-head">
            <h2>Game by game</h2>
            <p>The 4 each side brought, leads first.</p>
          </div>
          <div className="two-col">
            {([0, 1] as const).map((side) => (
              <div
                key={side}
                className="card card-pad"
                style={teamStyle(season, match.franchises[side])}
              >
                <TeamTag id={match.franchises[side]} />
                <ul className="game-usage">
                  {match.games.map((game) => (
                    <li key={game.number}>
                      <span className="label">
                        G{game.number} ·{" "}
                        {game.winnerId === null
                          ? "no winner"
                          : game.winnerId === match.franchises[side]
                            ? "won"
                            : "lost"}{" "}
                        · {game.turns}t
                      </span>
                      <span>
                        {game.brought[side].length
                          ? game.brought[side].map((mon) => monName(season, mon)).join(", ")
                          : "Nothing recorded"}
                      </span>
                      {game.megaEvolved[side] ? (
                        <span className="chip">{monName(season, game.megaEvolved[side])}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
