import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useReveal } from "../lib/use-reveal";
import { PokeBall } from "./pokeball";

function RouteEffects() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("#main")?.focus({ preventScroll: true });
  }, [pathname]);
  return null;
}

export function Frame({
  wordmark,
  nav,
  release,
  repo,
  footer,
  children,
}: {
  wordmark: ReactNode;
  nav?: ReactNode;
  release: string;
  repo: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  useReveal();
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
            <span>{wordmark}</span>
          </Link>
          {nav}
          <span className="release mono">
            <span className="dot" aria-hidden="true" />
            {release}
          </span>
          <a
            className="repo-link"
            href={repo}
            target="_blank"
            rel="noreferrer"
            aria-label="View the source on GitHub"
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
        {children}
      </main>
      <footer className="foot">
        <div className="foot-inner mono">
          {footer}
          <span>
            Sprites © Pokémon Showdown. Pokémon names are trademarks of Nintendo, Creatures Inc.,
            and GAME FREAK inc.
          </span>
        </div>
      </footer>
    </>
  );
}
