import type { LeagueTeambuildView } from "./views.js";
import { readRunArtifacts } from "./run-artifact-store.js";
import { decodeTeamBuildJournalRow } from "./teambuild.js";

export function readArchivedTeambuilds(runDir: string): LeagueTeambuildView[] {
  return readRunArtifacts(runDir, "teambuild").map(({ key, value }) => {
    const entry = decodeTeamBuildJournalRow(value, `teambuild artifact ${key}`);
    return { ...entry.view, notebook: entry.notebook };
  });
}
