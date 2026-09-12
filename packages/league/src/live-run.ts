import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import type { AgentProgress, LiveGame, LiveRunSnapshot } from "./public/live-protocol.js";

export const LIVE_RUN_FILE = "live.json";

/** What the running process writes; `readLiveRun` adds the run state from `status.json`. */
export type LiveRunFile = Omit<LiveRunSnapshot, "state">;

export class LiveRun {
  private timer?: NodeJS.Timeout;
  private disabled = false;
  readonly snapshot: LiveRunFile;

  constructor(readonly runDir: string) {
    this.snapshot = {
      runId: path.basename(runDir),
      generation: randomUUID(),
      updatedAt: new Date().toISOString(),
      revision: 0,
      agents: [],
      games: [],
    };
    this.flush();
  }

  agent(progress: AgentProgress): void {
    const agents = this.snapshot.agents;
    const index = agents.findIndex((entry) => entry.session === progress.session);
    if (progress.activity === "ended") {
      if (index >= 0) agents.splice(index, 1);
    } else if (index < 0) agents.push(progress);
    else agents[index] = progress;
    this.schedule();
  }

  readonly game = (game: LiveGame): void => {
    const index = this.snapshot.games.findIndex((entry) => entry.seriesId === game.seriesId);
    if (index < 0) this.snapshot.games.push(game);
    else this.snapshot.games[index] = game;
    this.schedule();
  };

  readonly invalidate = (): void => {
    this.snapshot.revision += 1;
    this.schedule();
  };

  private schedule(): void {
    if (!this.timer && !this.disabled) this.timer = setTimeout(() => this.flush(), 100);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disabled) return;
    this.snapshot.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(this.runDir, { recursive: true });
      writeAtomicJson(path.join(this.runDir, LIVE_RUN_FILE), this.snapshot);
    } catch (error) {
      this.disabled = true;
      console.error("Live watch could not write its snapshot:", error);
    }
  }
}
