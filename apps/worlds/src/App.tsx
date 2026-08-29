import { Link, Route, Routes } from "react-router-dom";
import { PokeBall } from "@/components/pokeball";
import { useTitle, useTournament } from "@/lib/context";
import { formatLabel, modelLabel } from "@/lib/format";
import { allMatches, entrant } from "@/lib/load";
import { useReveal } from "@/lib/use-reveal";
import { HomePage } from "@/routes/home";
import { MatchPage } from "@/routes/match";
import { NotFoundPage } from "@/routes/not-found";

export function App() {
  const bundle = useTournament();
  useTitle();
  useReveal();
  const champion = bundle.tournament.championId
    ? entrant(bundle, bundle.tournament.championId)
    : null;
  const played = allMatches(bundle).length;
  const total = bundle.entrants.length - 1;
  const release = champion ? `${modelLabel(champion.model)} won it` : `${played}/${total}`;
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <Link className="wordmark" to="/" viewTransition>
            <PokeBall size={20} />
            <span>
              AI Pokémon Worlds <em>2026</em>
            </span>
          </Link>
          <span className="release mono">
            <span className="dot" aria-hidden="true" />
            {release}
          </span>
        </div>
      </header>
      <main id="main" className="page">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/matches/:seriesId" element={<MatchPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="foot">
        <div className="foot-inner mono">
          <span>AI Pokémon Worlds 2026 · {formatLabel(bundle.tournament.format)}</span>
          <span>
            {bundle.event ? (
              <>
                Teams from <a href={bundle.event.url}>{bundle.event.name}</a>
                {bundle.tournament.showdownCommit
                  ? `. Showdown ${bundle.tournament.showdownCommit.slice(0, 10)}.`
                  : "."}
              </>
            ) : bundle.tournament.showdownCommit ? (
              `Showdown ${bundle.tournament.showdownCommit.slice(0, 10)}.`
            ) : null}
          </span>
          <span>
            Sprites © Pokémon Showdown. Pokémon names are trademarks of Nintendo, Creatures Inc.,
            and GAME FREAK inc.
          </span>
        </div>
      </footer>
    </>
  );
}
