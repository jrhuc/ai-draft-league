import { Link, useParams } from "react-router-dom";
import { Mark, Model } from "@/components/mark";
import { ReplayViewer } from "@/components/replay";
import { SetCard } from "@/components/set-card";
import { TeamTag, teamStyle } from "@/components/team";
import { spriteKey, tone } from "@/lib/format";
import { franchise, franchiseIndex, matchBySeries, monName } from "@/lib/load";
import type { Match, SeasonBundle } from "@/lib/season";
import { useSeason, useTitle } from "@/lib/season-context";
import { NotFoundPage } from "@/routes/not-found";

function fieldedGames(match: Match, side: 0 | 1, draftId: string): number[] {
  return match.games
    .filter((game) => game.brought[side].includes(draftId))
    .map((game) => game.number);
}

function spriteMap(season: SeasonBundle, match: Match): Array<[string, string]> {
  const pairs = new Map<string, string>();
  for (const mon of season.board) {
    pairs.set(spriteKey(mon.name), mon.spriteId);
    pairs.set(spriteKey(mon.id), mon.spriteId);
    const mega = mon.name.match(/^Mega (.+?)(?: ([XY]))?$/);
    if (mega) pairs.set(spriteKey(`${mega[1]} Mega ${mega[2] ?? ""}`), mon.spriteId);
  }
  for (const build of match.builds)
    for (const set of build.sets ?? []) pairs.set(spriteKey(set.species), set.spriteId);
  return [...pairs];
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
  const row = matchBySeries(season, seriesId);
  const replay = season.replays[seriesId];
  if (!row || !replay) throw new Error(`series ${seriesId} is not released`);
  const { match, label } = row;
  const [a, b] = match.franchises;
  useTitle(`${franchise(season, a).name} vs ${franchise(season, b).name} · ${label}`);
  const team = (id: string) => ({
    id,
    name: franchise(season, id).name,
    tone: tone(franchiseIndex(season, id)),
    model: franchise(season, id).model,
  });
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
          <h2>Team sheets</h2>
          <p>
            Each team registers six before the series and brings four to every game. Each card lists
            the games it played.
          </p>
        </div>
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
                  <div className="build-head">
                    <span className="chip chip-warn">{build.attempts} attempts</span>
                  </div>
                ) : null}
                <details>
                  <summary>Why this team</summary>
                  <p className="rationale">{build.rationale || "No build reasoning recorded."}</p>
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
                          games={fieldedGames(match, side, draftId)}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="closed-note">
                    Registered: {build.prepared.map((mon) => monName(season, mon)).join(", ")}. Full
                    sets are published when the season ends.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {match.games.some((game) => game.brought[0].length || game.brought[1].length) ? (
        <section className="section">
          <div className="section-head">
            <h2>Game by game</h2>
            <p>What each side actually sent out, read from the battle log.</p>
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

      <section className="section">
        <div className="section-head">
          <h2>Replay</h2>
          <p>
            Step through each turn. Every choice includes the model’s reasoning. AUTO marks a turn
            the harness had to pick for it.
          </p>
        </div>
        <ReplayViewer
          replay={replay}
          teams={[team(a), team(b)]}
          sprites={spriteMap(season, match)}
        />
      </section>
    </>
  );
}
