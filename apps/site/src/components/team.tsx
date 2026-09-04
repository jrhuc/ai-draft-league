import { Link } from "react-router-dom";
import { Mark } from "ui/components/mark";
import { modelLabel, tone, toneStyle } from "ui/lib/format";
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
  title = true,
}: {
  id: string;
  link?: boolean;
  muted?: boolean;
  title?: boolean;
}) {
  const season = useSeason();
  const team = franchise(season, id);
  const inner = (
    <>
      <Mark spec={team.model} tone />
      <span className="name">{team.name}</span>
    </>
  );
  const className = `team-tag${muted ? " muted" : ""}`;
  const hover = title ? modelLabel(team.model) : undefined;
  return link ? (
    <Link className={className} style={teamStyle(season, id)} to={`/teams/${id}`} title={hover}>
      {inner}
    </Link>
  ) : (
    <span className={className} style={teamStyle(season, id)} title={hover}>
      {inner}
    </span>
  );
}
