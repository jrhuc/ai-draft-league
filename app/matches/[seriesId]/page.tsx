import Link from "next/link";
import { Model } from "@/components/mark";
import { ReplayViewer } from "@/components/replay";
import { SetCard } from "@/components/set-card";
import { TeamTag, teamStyle } from "@/components/team";
import { baseSpecies, spriteKey, tone } from "@/lib/format";
import { franchise, franchiseIndex, matchBySeries, monName, releasedSeriesIds, season } from "@/lib/load";
import type { Match, Replay, ReplayGame } from "@/lib/season";

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

function sameSpecies(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function broughtIn(game: ReplayGame, side: 0 | 1, franchiseId: string, key: string): boolean {
  const preview = game.events.filter((event) => event.kind === "preview" && event.actor?.side === side).map((event) => baseSpecies(event.species ?? ""));
  const order = game.decisions.find((decision) => decision.franchiseId === franchiseId && decision.phase === "team_preview")?.action.match(/^team\s+(\d+)$/);
  if (order && preview.length > 0) return [...order[1]!].some((digit) => sameSpecies(preview[Number(digit) - 1] ?? "", key));
  return game.events.some((event) => event.kind === "switch" && event.actor?.side === side && sameSpecies(baseSpecies(event.species ?? ""), key));
}

function brought(replay: Replay, side: 0 | 1, species: string): number[] {
  const key = baseSpecies(species);
  return replay.games.filter((game) => broughtIn(game, side, replay.franchises[side], key)).map((game) => game.number);
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
          {match.builds.map((build, side) => (
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
                  {build.sets.map((set) => (
                    <SetCard key={set.species} set={set} games={brought(replay, side as 0 | 1, set.species)} />
                  ))}
                </div>
              ) : (
                <p className="closed-note">Registered: {build.prepared.map(monName).join(", ")}. Full sets are published when the season ends.</p>
              )}
            </div>
          ))}
        </div>
      </section>

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
