import Link from "next/link";
import { Model } from "@/components/mark";
import { ReplayViewer } from "@/components/replay";
import { SetCard } from "@/components/set-card";
import { TeamTag, teamStyle } from "@/components/team";
import { spriteKey, tone } from "@/lib/format";
import { franchise, franchiseIndex, matchBySeries, monName, releasedSeriesIds, season } from "@/lib/load";
import type { Match } from "@/lib/season";

export function generateStaticParams() {
  return releasedSeriesIds().map((seriesId) => ({ seriesId }));
}

export async function generateMetadata({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  const row = matchBySeries(seriesId);
  if (!row) return {};
  const [a, b] = row.match.franchises;
  return { title: `${franchise(a).name} vs ${franchise(b).name} · ${row.label}` };
}


function fieldedGames(match: Match, side: 0 | 1, draftId: string): number[] {
  return match.games.filter((game) => game.brought[side].includes(draftId)).map((game) => game.number);
}

function spriteMap(match: Match): Array<[string, string]> {
  const pairs = new Map<string, string>();
  for (const mon of season.board) {
    pairs.set(spriteKey(mon.name), mon.spriteId);
    pairs.set(spriteKey(mon.id), mon.spriteId);
    const mega = mon.name.match(/^Mega (.+?)(?: ([XY]))?$/);
    if (mega) pairs.set(spriteKey(`${mega[1]} Mega ${mega[2] ?? ""}`), mon.spriteId);
  }
  for (const build of match.builds) for (const set of build.sets ?? []) pairs.set(spriteKey(set.species), set.spriteId);
  return [...pairs];
}

function Side({ id, match, right = false }: { id: string; match: Match; right?: boolean }) {
  const lost = match.winnerId !== null && match.winnerId !== id;
  return (
    <div className={`side${right ? " right" : ""}${lost ? " lost" : ""}`} style={teamStyle(id)}>
      <h2>
        <Link href={`/teams/${id}/`}>{franchise(id).name}</Link>
      </h2>
      <Model spec={franchise(id).model} />
    </div>
  );
}

export default async function MatchPage({ params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  const row = matchBySeries(seriesId);
  const replay = season.replays[seriesId];
  if (!row || !replay) throw new Error(`series ${seriesId} is not released`);
  const { match, label } = row;
  const [a, b] = match.franchises;
  const team = (id: string) => ({ id, name: franchise(id).name, tone: tone(franchiseIndex(id)) });
  return (
    <>
      <section className="hero match-hero">
        <h1 className="label">
          {label} · {franchise(a).name} vs {franchise(b).name}
        </h1>
        <Side id={a} match={match} />
        <div className="big-score">
          {match.score ? `${match.score[0]}–${match.score[1]}` : "vs"}
          <small>{match.games.map((game) => `G${game.number} ${game.turns}t`).join(" · ")}</small>
        </div>
        <Side id={b} match={match} right />
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Team sheets</h2>
          <p>Six registered before the series, four brought to each game. Each card lists the games it played.</p>
        </div>
        <div className="two-col">
          {([0, 1] as const).map((side) => {
            const build = match.builds[side];
            if (!build) throw new Error(`match ${match.id} has no build for side ${side}`);
            return (
              <div key={build.franchiseId} className="build" style={teamStyle(build.franchiseId)}>
                <div className="build-head">
                  <TeamTag id={build.franchiseId} />
                  {build.attempts > 1 ? <span className="chip chip-warn">{build.attempts} attempts</span> : null}
                </div>
                <details>
                  <summary>Why this team</summary>
                  <p className="rationale">{build.rationale || "No build reasoning recorded."}</p>
                </details>
                {build.sets ? (
                  <div className="grid grid-2">
                    {build.sets.map((set, index) => {
                      const draftId = build.prepared[index];
                      if (!draftId) throw new Error(`build ${build.franchiseId} has a set without a draft pick`);
                      return <SetCard key={draftId} set={set} games={fieldedGames(match, side, draftId)} />;
                    })}
                  </div>
                ) : (
                  <p className="closed-note">Registered: {build.prepared.map(monName).join(", ")}. Full sets are published when the season ends.</p>
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
              <div key={side} className="card card-pad" style={teamStyle(match.franchises[side])}>
                <TeamTag id={match.franchises[side]} />
                <ul className="game-usage">
                  {match.games.map((game) => (
                    <li key={game.number}>
                      <span className="label">
                        G{game.number} · {game.winnerId === null ? "no winner" : game.winnerId === match.franchises[side] ? "won" : "lost"} · {game.turns}t
                      </span>
                      <span>{game.brought[side].length ? game.brought[side].map(monName).join(", ") : "Nothing recorded"}</span>
                      {game.megaEvolved[side] ? <span className="chip">{monName(game.megaEvolved[side])}</span> : null}
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
          <p>Step through each turn. Every choice includes the model’s reasoning; AUTO marks a turn the harness had to pick for it.</p>
        </div>
        <ReplayViewer replay={replay} teams={[team(a), team(b)]} sprites={spriteMap(match)} />
      </section>
    </>
  );
}
