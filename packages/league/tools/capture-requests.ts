#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RandomEngine } from "../src/battle-agent.js";
import { REPO_ROOT } from "../src/paths.js";
import { SimBattle } from "../src/sim.js";
import { loadPool } from "../src/teams.js";
import type { AgentContext, BattleRequest, Pid } from "../src/types.js";

type RequestKind = "teampreview" | "move";

interface CapturedRequests {
  teampreview?: BattleRequest;
  move?: BattleRequest;
}

const REQUEST_KINDS = ["teampreview", "move"] as const satisfies readonly RequestKind[];
const REQUEST_FILE_NAMES = {
  teampreview: "team_preview.json",
  move: "turn.json",
} as const satisfies Record<RequestKind, string>;

class CaptureEngine extends RandomEngine {
  constructor(
    pid: Pid,
    seed: number,
    private readonly captured: CapturedRequests,
  ) {
    super(pid, seed);
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const kind = request.teamPreview ? "teampreview" : "move";
    this.captured[kind] ??= structuredClone(request);
    return super.act(request, context);
  }
}

async function captureRequests(): Promise<void> {
  const pool = loadPool();
  const captured: CapturedRequests = {};
  for (let seed = 1; seed <= 8; seed += 1) {
    const battle = new SimBattle(
      pool.format,
      {
        p1: { name: "capture-a", team: pool.teams[0]!.packed },
        p2: { name: "capture-b", team: pool.teams[1]!.packed },
      },
      seed,
    );
    await battle.run({
      p1: new CaptureEngine("p1", seed * 2, captured),
      p2: new CaptureEngine("p2", seed * 2 + 1, captured),
    });
    if (REQUEST_KINDS.every((kind) => captured[kind])) break;
  }
  const missing: RequestKind[] = [];
  const files: Array<{ name: string; request: BattleRequest }> = [];
  for (const kind of REQUEST_KINDS) {
    const request = captured[kind];
    if (request) files.push({ name: REQUEST_FILE_NAMES[kind], request });
    else missing.push(kind);
  }
  if (missing.length) throw new Error(`could not capture request kinds: ${missing.join(", ")}`);
  const output = path.join(REPO_ROOT, "tests", "data", "showdown_requests");
  fs.mkdirSync(output, { recursive: true });
  for (const { name, request } of files)
    fs.writeFileSync(path.join(output, name), `${JSON.stringify(request, null, 1)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await captureRequests();
