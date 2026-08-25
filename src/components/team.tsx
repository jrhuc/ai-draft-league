import { Link } from "react-router-dom";
import { tone, toneStyle } from "@/lib/format";
import { franchise, franchiseIndex } from "@/lib/load";
import type { SeasonBundle } from "@/lib/season";
import { useSeason } from "@/lib/season-context";

export function teamStyle(season: SeasonBundle, id: string): React.CSSProperties {
  return toneStyle(tone(franchiseIndex(season, id)));
}

export function TeamTag({
  id,
  link = true,
  muted = false,
}: {
  id: string;
  link?: boolean;
  muted?: boolean;
}) {
  const season = useSeason();
  const team = franchise(season, id);
  const inner = (
    <>
      <span className="swatch" aria-hidden="true" />
      {team.name}
    </>
  );
  const className = `team-tag${muted ? " muted" : ""}`;
  return link ? (
    <Link className={className} style={teamStyle(season, id)} to={`/teams/${id}`}>
      {inner}
    </Link>
  ) : (
    <span className={className} style={teamStyle(season, id)}>
      {inner}
    </span>
  );
}
