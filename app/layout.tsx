import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { NavLink } from "@/components/nav-link";
import { formatLabel } from "@/lib/format";
import { season } from "@/lib/load";
import "./globals.css";
import "./styles/draft.css";
import "./styles/teams.css";
import "./styles/matches.css";
import "./styles/transactions.css";
import "./styles/playoffs.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const viewport = { themeColor: "#0a0a0a" };

export const metadata: Metadata = {
  title: { default: season.season.title, template: `%s · ${season.season.title}` },
  description: "A Pokémon draft league played by frontier models: every pick, build, and turn with the reasoning behind it.",
};

const NAV: Array<[string, string]> = [
  ["/", "Standings"],
  ["/draft/", "Draft"],
  ["/teams/", "Teams"],
  ["/transactions/", "Transactions"],
  ["/playoffs/", "Playoffs"],
];

function releaseLabel(): string {
  const s = season.season;
  if (s.status === "complete") return "Season complete";
  if (s.status === "draft") return "Draft complete";
  if (s.releasedPlayoffRounds > 0) return s.releasedPlayoffRounds >= s.playoffRounds ? "Final played" : "Playoffs underway";
  return `Through week ${s.releasedThroughWeek} of ${s.totalWeeks}`;
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="top">
          <div className="top-inner">
            <Link className="wordmark" href="/">
              <span className="wordmark-dot" aria-hidden="true" />
              AI Draft League
            </Link>
            <nav aria-label="Sections">
              {NAV.map(([href, label]) => (
                <NavLink key={href} href={href}>
                  {label}
                </NavLink>
              ))}
            </nav>
            <span className="release mono">
              <span className="dot" aria-hidden="true" />
              {releaseLabel()}
            </span>
          </div>
        </header>
        <main id="main" className="page">
          {children}
        </main>
        <footer className="foot">
          <div className="foot-inner mono">
            <span>
              {season.season.title} · {formatLabel(season.season.format)}
            </span>
            <span>
              Games played in a pinned Pokémon Showdown fork
              {season.provenance.showdownCommit ? ` (${season.provenance.showdownCommit.slice(0, 10)})` : ""}; full logs in{" "}
              <a href="https://github.com/jrhuc/vgc-model-league">vgc-model-league</a>.
            </span>
            <span>Sprites © Pokémon Showdown. Pokémon names are trademarks of Nintendo, Creatures Inc., and GAME FREAK inc.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
