import { Route, Routes } from "react-router-dom";
import { Frame } from "ui/components/frame";
import { formatLabel, modelLabel } from "ui/lib/format";
import { useTournament } from "@/lib/context";
import { allMatches, entrant } from "@/lib/load";
import { HomePage } from "@/routes/home";
import { MatchPage } from "@/routes/match";
import { NotFoundPage } from "@/routes/not-found";

export function App() {
  const bundle = useTournament();
  const champion = bundle.tournament.championId
    ? entrant(bundle, bundle.tournament.championId)
    : null;
  const played = allMatches(bundle).length;
  const total = bundle.entrants.length - 1;
  const release = champion
    ? `Champion · ${modelLabel(champion.model)}`
    : `Progress · ${played}/${total} matches`;
  return (
    <Frame
      wordmark={
        <>
          VGC <em>AI</em> Tournament
        </>
      }
      release={release}
      repo="https://github.com/jrhuc/ai-draft-league/tree/main/apps/worlds"
      footer={
        <>
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
        </>
      }
    >
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/matches/:seriesId" element={<MatchPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Frame>
  );
}
