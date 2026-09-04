import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { Frame } from "ui/components/frame";
import { formatLabel } from "ui/lib/format";
import { NavLink } from "@/components/nav-link";
import { useSeason } from "@/lib/season-context";
import { DraftPage } from "@/routes/draft";
import { HomePage } from "@/routes/home";
import { MatchPage } from "@/routes/match";
import { NotFoundPage } from "@/routes/not-found";
import { PlayoffsPage } from "@/routes/playoffs";
import { TeamPage } from "@/routes/team";
import { TeamsPage } from "@/routes/teams";
import { TransactionsPage } from "@/routes/transactions";

const dev = import.meta.env.DEV;
const LivePage = dev ? lazy(() => import("@/routes/live")) : null;
const ArchivePage = dev ? lazy(() => import("@/routes/archive")) : null;
const DevNav = dev ? lazy(() => import("@/components/dev-nav")) : null;

const NAV: Array<[string, string]> = [
  ["/", "Standings"],
  ["/draft", "Draft"],
  ["/teams", "Teams"],
  ["/transactions", "Transactions"],
  ["/playoffs", "Playoffs"],
];

function releaseLabel(bundle: ReturnType<typeof useSeason>): string {
  const s = bundle.season;
  if (s.status === "complete") return "Season complete";
  if (s.status === "draft") {
    const total = bundle.franchises.length * s.board.picksPerFranchise;
    const picks = bundle.draft.picks.length;
    return picks < total ? `Drafting · pick ${picks + 1} of ${total}` : "Draft complete";
  }
  if (s.releasedPlayoffRounds > 0)
    return s.releasedPlayoffRounds >= s.playoffRounds ? "Final played" : "Playoffs underway";
  return `Through week ${s.releasedThroughWeek} of ${s.totalWeeks}`;
}

export function App() {
  const season = useSeason();
  const commit = season.provenance.showdownCommit;
  return (
    <Frame
      wordmark={
        <>
          AI <em>Draft</em> League
        </>
      }
      nav={
        <nav aria-label="Sections">
          {NAV.map(([href, label]) => (
            <NavLink key={href} href={href}>
              {label}
            </NavLink>
          ))}
          {DevNav ? (
            <Suspense fallback={null}>
              <DevNav />
            </Suspense>
          ) : null}
        </nav>
      }
      release={releaseLabel(season)}
      repo="https://github.com/jrhuc/ai-draft-league"
      footer={
        <>
          <span>
            {season.season.title} · {formatLabel(season.season.format)}
          </span>
          <span>
            Games played on a pinned Pokémon Showdown fork
            {commit ? (
              <>
                {" "}
                (
                <a href={`https://github.com/smogon/pokemon-showdown/commit/${commit}`}>
                  {commit.slice(0, 10)}
                </a>
                )
              </>
            ) : null}
            .
          </span>
        </>
      }
    >
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/draft" element={<DraftPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:id" element={<TeamPage />} />
        <Route path="/matches/:seriesId" element={<MatchPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/playoffs" element={<PlayoffsPage />} />
        {LivePage ? (
          <Route
            path="/live"
            element={
              <Suspense fallback={null}>
                <LivePage />
              </Suspense>
            }
          />
        ) : null}
        {ArchivePage ? (
          <Route
            path="/archive"
            element={
              <Suspense fallback={null}>
                <ArchivePage />
              </Suspense>
            }
          />
        ) : null}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Frame>
  );
}
