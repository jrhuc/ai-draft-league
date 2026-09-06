import type { TeamBuildView } from "./views.js";

export interface BuildBriefing {
  team_plan: string;
  set_notes: Array<{ species: string; note: string }>;
}

export function buildBriefing(build: Pick<TeamBuildView, "rationale" | "sets">): string {
  const briefing: BuildBriefing = {
    team_plan: build.rationale,
    set_notes: build.sets.map((set) => ({ species: set.species, note: set.note ?? "" })),
  };
  return `Your manager-authored build briefing:\n${JSON.stringify(briefing)}`;
}
