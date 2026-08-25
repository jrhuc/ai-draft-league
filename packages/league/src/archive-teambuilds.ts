import path from "node:path";

import type { LeagueTeambuildView } from "./views.js";
import { readRunLines } from "./run-artifacts.js";
import { decodeTeamBuildJournalRow } from "./teambuild.js";

export function readArchivedTeambuilds(runsDir: string, runId: string): LeagueTeambuildView[] {
  const file = path.join(runsDir, runId, "teambuild", "teambuild.jsonl");
  return readRunLines(runsDir, runId, "teambuild", "teambuild.jsonl").map((row, index) => {
    const entry = decodeTeamBuildJournalRow(row, `${file} line ${index + 1}`);
    return { ...entry.view, notebook: entry.notebook };
  });
}
