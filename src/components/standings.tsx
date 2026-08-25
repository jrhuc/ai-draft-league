import { TeamTag } from "@/components/team";
import { franchise } from "@/lib/load";
import { useSeason } from "@/lib/season-context";

export function Standings({ compact = false }: { compact?: boolean }) {
  const season = useSeason();
  const cut = season.season.playoffRounds === 2 ? 4 : 2;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="r">#</th>
            <th>Team</th>
            {compact ? null : <th>Model</th>}
            <th className="r">W</th>
            <th className="r">L</th>
            <th className="r">Games</th>
            <th className="r">+/−</th>
          </tr>
        </thead>
        <tbody>
          {season.standings.map((row) => (
            <tr key={row.franchiseId} className={row.rank === cut + 1 ? "playoff-line" : undefined}>
              <td className="r num">{row.rank}</td>
              <td className="team">
                <TeamTag id={row.franchiseId} />
              </td>
              {compact ? null : (
                <td style={{ color: "var(--t4)" }}>
                  {franchise(season, row.franchiseId).model.replace(/^[^:]*:/, "")}
                </td>
              )}
              <td className="r num">{row.seriesWins}</td>
              <td className="r num">{row.seriesLosses}</td>
              <td className="r num">
                {row.gameWins}–{row.gameLosses}
              </td>
              <td
                className="r num"
                style={{
                  color:
                    row.differential > 0
                      ? "var(--good)"
                      : row.differential < 0
                        ? "var(--bad)"
                        : "var(--t4)",
                }}
              >
                {row.differential > 0 ? `+${row.differential}` : row.differential}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
