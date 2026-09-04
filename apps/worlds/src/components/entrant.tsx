import { Mark } from "ui/components/mark";
import { useTournament } from "@/lib/context";
import { modelLabel, tone, toneStyle } from "ui/lib/format";
import { entrant, entrantIndex } from "@/lib/load";
import type { TournamentBundle } from "@/lib/tournament";

export function entrantStyle(bundle: TournamentBundle, id: string): React.CSSProperties {
  return toneStyle(tone(entrantIndex(bundle, id)));
}

export function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th";
  return `${value}${suffix}`;
}

export function EntrantTag({ id, muted = false }: { id: string; muted?: boolean }) {
  const bundle = useTournament();
  const entry = entrant(bundle, id);
  return (
    <span
      className={`team-tag${muted ? " muted" : ""}`}
      style={entrantStyle(bundle, id)}
      title={modelLabel(entry.model)}
    >
      <Mark spec={entry.model} tone />
      <span className="name">{modelLabel(entry.model)}</span>
    </span>
  );
}
