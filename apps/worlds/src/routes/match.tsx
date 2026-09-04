import { useState } from "react";
import { useParams } from "react-router-dom";
import { entrantStyle, ordinal } from "@/components/entrant";
import { useTitle, useTournament } from "@/lib/context";
import { Mark } from "ui/components/mark";
import { ReplayViewer, type Team } from "ui/components/replay";
import { SetCard } from "ui/components/set-card";
import { modelLabel, modelProvider, tone } from "ui/lib/format";
import { entrant, entrantIndex, matchBySeries, monName } from "@/lib/load";
import type { Match } from "@/lib/tournament";
import { NotFoundPage } from "@/routes/not-found";

function broughtGames(match: Match, side: 0 | 1, setId: string) {
  return match.games
    .filter((game) => game.brought[side].includes(setId))
    .map((game) => game.number);
}

export function MatchPage() {
  const bundle = useTournament();
  const { seriesId } = useParams();
  const row = seriesId ? matchBySeries(bundle, seriesId) : null;
  const replay = seriesId ? bundle.replays[seriesId] : undefined;
  if (!seriesId || !row || !replay) return <NotFoundPage />;
  return <MatchPageBody seriesId={seriesId} />;
}

function MatchPageBody({ seriesId }: { seriesId: string }) {
  const bundle = useTournament();
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const row = matchBySeries(bundle, seriesId);
  const replay = bundle.replays[seriesId];
  if (!row || !replay) throw new Error(`series ${seriesId} is not released`);
  const { match, label } = row;
  const [a, b] = match.entrants;
  useTitle(
    `${modelLabel(entrant(bundle, a).model)} vs ${modelLabel(entrant(bundle, b).model)} · ${label}`,
  );
  const team = (id: string): Team => ({
    id,
    name: modelLabel(entrant(bundle, id).model),
    tone: tone(entrantIndex(bundle, id)),
    model: entrant(bundle, id).model,
  });
  const teams: [Team, Team] = [team(a), team(b)];
  const teamFor = (id: string | null): Team | null =>
    teams.find((entry) => entry.id === id) ?? null;
  const games = replay.games.map((game) => ({
    ...game,
    winner: teamFor(game.winnerId),
    decisions: game.decisions.map((decision) => ({ ...decision, team: team(decision.entrantId) })),
    reflections: game.reflections.map((reflection) => ({
      ...reflection,
      team: team(reflection.entrantId),
    })),
  }));
  function Side({ id, right = false }: { id: string; right?: boolean }) {
    const entry = entrant(bundle, id);
    const lost = match.winnerId !== id;
    const provider = modelProvider(entry.model);
    return (
      <div
        className={`side${right ? " right" : ""}${lost ? " lost" : ""}`}
        style={entrantStyle(bundle, id)}
      >
        <h2>
          <span className="title-tag">
            <Mark spec={entry.model} size="0.72em" tone />
            {modelLabel(entry.model)}
          </span>
        </h2>
        {provider ? <span className="model">via {provider}</span> : null}
        <span className="label">
          piloting {entry.team.player}’s
          {entry.team.placement === null ? "" : ` ${ordinal(entry.team.placement)}-place`} team
        </span>
      </div>
    );
  }
  return (
    <>
      <section className="hero match-hero">
        <h1 className="label">{label}</h1>
        <Side id={a} />
        <div className="big-score">
          {`${match.score[0]}–${match.score[1]}`}
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
                  The 6 registered per player, 4 brought per game.
                  {bundle.event?.reconstructedSpreads ? " Spreads use public sets." : ""}
                </span>
              </summary>
              <div className="two-col">
                {([0, 1] as const).map((side) => {
                  const entry = entrant(bundle, match.entrants[side]);
                  return (
                    <div key={entry.id} className="build" style={entrantStyle(bundle, entry.id)}>
                      {entry.team.paste ? (
                        <a
                          href={entry.team.paste}
                          target="_blank"
                          rel="noreferrer"
                          className="chip"
                        >
                          Show original sheet →
                        </a>
                      ) : null}
                      <div className="grid grid-2">
                        {entry.team.sets.map((set) => {
                          const games = broughtGames(match, side, set.id);
                          return <SetCard key={set.id} set={set} games={games} />;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          }
        />
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Game by game</h2>
          <p>The 4 each model brought, leads first.</p>
        </div>
        <div className="two-col">
          {([0, 1] as const).map((side) => (
            <div
              key={side}
              className="card card-pad"
              style={entrantStyle(bundle, match.entrants[side])}
            >
              <span className="team-tag" style={entrantStyle(bundle, match.entrants[side])}>
                <Mark spec={entrant(bundle, match.entrants[side]).model} tone />
                {modelLabel(entrant(bundle, match.entrants[side]).model)}
              </span>
              <ul className="game-usage">
                {match.games.map((game) => (
                  <li key={game.number}>
                    <span className="label">
                      G{game.number} ·{" "}
                      {game.winnerId === null
                        ? "no winner"
                        : game.winnerId === match.entrants[side]
                          ? "won"
                          : "lost"}{" "}
                      · {game.turns}t
                    </span>
                    <span>{game.brought[side].map((mon) => monName(bundle, mon)).join(", ")}</span>
                    {game.megaEvolved[side] ? (
                      <span className="chip">{monName(bundle, game.megaEvolved[side])}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
