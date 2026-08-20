import Link from "next/link";
import { tone } from "@/lib/format";
import { franchise, franchiseIndex } from "@/lib/load";

export function teamStyle(id: string): React.CSSProperties {
  return { ["--tone" as string]: tone(franchiseIndex(id)) } as React.CSSProperties;
}

export function TeamTag({ id, link = true, muted = false }: { id: string; link?: boolean; muted?: boolean }) {
  const team = franchise(id);
  const inner = (
    <>
      <span className="swatch" aria-hidden="true" />
      {team.name}
    </>
  );
  const className = `team-tag${muted ? " muted" : ""}`;
  return link ? (
    <Link className={className} style={teamStyle(id)} href={`/teams/${id}/`}>
      {inner}
    </Link>
  ) : (
    <span className={className} style={teamStyle(id)}>
      {inner}
    </span>
  );
}
