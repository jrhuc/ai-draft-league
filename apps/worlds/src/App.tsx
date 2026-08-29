import { useEffect } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { PokeBall } from "@/components/pokeball";
import { useTournament } from "@/lib/context";
import { formatLabel, modelLabel } from "@/lib/format";
import { allMatches, entrant } from "@/lib/load";
import { useReveal } from "@/lib/use-reveal";
import { HomePage } from "@/routes/home";
import { MatchPage } from "@/routes/match";
import { NotFoundPage } from "@/routes/not-found";

export function App() {
  const bundle = useTournament();
  useReveal();
  const champion = bundle.tournament.championId
    ? entrant(bundle, bundle.tournament.championId)
    : null;
  const played = allMatches(bundle).length;
  const total = bundle.entrants.length - 1;
  const release = champion
    ? `Champion · ${modelLabel(champion.model)}`
    : `Progress · ${played}/${total} matches`;
  return (
    <>
      <RouteEffects />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <Link className="wordmark" to="/" viewTransition>
            <PokeBall size={20} />
            <span>
              VGC <em>AI</em> Tournament
            </span>
          </Link>
          <span className="release mono">
            <span className="dot" aria-hidden="true" />
            {release}
          </span>
          <a
            className="repo-link"
            href="https://github.com/jrhuc/ai-draft-league/tree/main/apps/worlds"
            target="_blank"
            rel="noreferrer"
            aria-label="View the Worlds site source on GitHub"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19">
              <path
                fill="currentColor"
                d="M12 .7A11.5 11.5 0 0 0 8.4 23c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C16.9 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .7Z"
              />
            </svg>
          </a>
        </div>
      </header>
      <main id="main" className="page" tabIndex={-1}>
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
                {bundle.tournament.showdownCommit ? " · " : "."}
              </>
            ) : null}
            {bundle.tournament.showdownCommit ? (
              <>
                <a
                  href={`https://github.com/smogon/pokemon-showdown/commit/${bundle.tournament.showdownCommit}`}
                >
                  Showdown {bundle.tournament.showdownCommit.slice(0, 10)}
                </a>
                .
              </>
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

function RouteEffects() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("#main")?.focus({ preventScroll: true });
  }, [pathname]);
  return null;
}
