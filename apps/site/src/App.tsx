import { lazy, Suspense } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { NavLink } from "@/components/nav-link";
import { formatLabel } from "@/lib/format";
import { useSeason } from "@/lib/season-context";
import { useReveal } from "@/lib/use-reveal";
import { DraftPage } from "@/routes/draft";
import { HomePage } from "@/routes/home";
import { MatchPage } from "@/routes/match";
import { NotFoundPage } from "@/routes/not-found";
import { PlayoffsPage } from "@/routes/playoffs";
import { TeamPage } from "@/routes/team";
import { TeamsPage } from "@/routes/teams";
import { TransactionsPage } from "@/routes/transactions";

const WatchPage = import.meta.env.DEV ? lazy(() => import("@/routes/watch")) : null;

const NAV: Array<[string, string]> = [
  ["/", "Standings"],
  ["/draft", "Draft"],
  ["/teams", "Teams"],
  ["/transactions", "Transactions"],
  ["/playoffs", "Playoffs"],
];

function releaseLabel(s: ReturnType<typeof useSeason>["season"]): string {
  if (s.status === "complete") return "Season complete";
  if (s.status === "draft") return "Draft complete";
  if (s.releasedPlayoffRounds > 0)
    return s.releasedPlayoffRounds >= s.playoffRounds ? "Final played" : "Playoffs underway";
  return `Through week ${s.releasedThroughWeek} of ${s.totalWeeks}`;
}

export function App() {
  const season = useSeason();
  useReveal();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <Link className="wordmark" to="/" viewTransition>
            <span className="wordmark-dot" aria-hidden="true" />
            AI Draft League
          </Link>
          <nav aria-label="Sections">
            {NAV.map(([href, label]) => (
              <NavLink key={href} href={href}>
                {label}
              </NavLink>
            ))}
            {WatchPage ? <NavLink href="/watch">Watch</NavLink> : null}
          </nav>
          <span className="release mono">
            <span className="dot" aria-hidden="true" />
            {releaseLabel(season.season)}
          </span>
        </div>
      </header>
      <main id="main" className="page">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/draft" element={<DraftPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:id" element={<TeamPage />} />
          <Route path="/matches/:seriesId" element={<MatchPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/playoffs" element={<PlayoffsPage />} />
          {WatchPage ? (
            <Route
              path="/watch"
              element={
                <Suspense fallback={null}>
                  <WatchPage />
                </Suspense>
              }
            />
          ) : null}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="foot">
        <div className="foot-inner mono">
          <span>
            {season.season.title} · {formatLabel(season.season.format)}
          </span>
          <span>
            Games played in a pinned Pokémon Showdown fork
            {season.provenance.showdownCommit
              ? ` (${season.provenance.showdownCommit.slice(0, 10)})`
              : ""}
            ; full logs in <a href="https://github.com/jrhuc/vgc-model-league">vgc-model-league</a>.
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
