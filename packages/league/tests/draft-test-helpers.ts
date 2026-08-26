import assert from "node:assert/strict";
import type { DraftBoardMon, DraftState } from "../src/draft.js";
import { loadBoard } from "../src/draft.js";
import { emptyMemory } from "../src/franchise-memory.js";
import { FORMAT_AUTHORITY_NOTICE } from "../src/prompts.js";
import type { Completion, JsonObject, Provider, ProviderMessage } from "../src/types.js";
import type { TradeWindowState } from "../src/trade-window.js";
import { legalTeamResponse } from "./fixtures/team-build.js";

export const BOARD = loadBoard("regmb-202607");
export const mon = (id: string): DraftBoardMon => {
  const found = BOARD.mons.find((candidate) => candidate.id === id);
  assert.ok(found, `board is missing ${id}`);
  return found;
};

export function assertFormatAuthority(prompt: string): void {
  assert.equal(prompt.split(FORMAT_AUTHORITY_NOTICE).length - 1, 1);
}

export function freshState(overrides: Partial<DraftState> = {}): DraftState {
  return {
    board: BOARD,
    taken: new Map(),
    rosters: [[], []],
    budgets: [BOARD.budget, BOARD.budget],
    teamNames: ["", ""],
    ...overrides,
  };
}

export function transactionState(entrants = 2): TradeWindowState {
  const rosters = Array.from({ length: entrants }, (): DraftBoardMon[] => []);
  const bases = new Set<string>();
  let cursor = 0;
  for (const candidate of [...BOARD.mons].sort(
    (a, b) => a.cost - b.cost || a.id.localeCompare(b.id),
  )) {
    if (bases.has(candidate.base)) continue;
    bases.add(candidate.base);
    rosters[cursor]!.push(candidate);
    if (rosters[cursor]!.length === BOARD.picks) cursor += 1;
    if (cursor === entrants) break;
  }
  assert.equal(cursor, entrants, "fixture needs enough complete inexpensive rosters");
  return {
    board: BOARD,
    models: Array.from({ length: entrants }, () => "random"),
    teamNames: Array.from({ length: entrants }, (_, entrant) => `Team ${entrant + 1}`),
    rosters,
    budgets: rosters.map((roster) => BOARD.budget - roster.reduce((sum, mon) => sum + mon.cost, 0)),
    memories: Array.from({ length: entrants }, () => emptyMemory()),
    standings: Array.from({ length: entrants }, (_, entrant) => ({
      entrant,
      w: 0,
      l: 0,
      gw: 0,
      gl: 0,
    })),
    results: Array.from({ length: entrants }, () => []),
    reflections: Array.from({ length: entrants }, () => []),
    history: [],
    swapsAllowed: 6,
    swapsUsed: Array.from({ length: entrants }, () => 0),
  };
}

export function scriptedProvider(
  responses: string[],
  onComplete?: (messages: ProviderMessage[]) => void,
): Provider {
  let call = 0;
  return {
    complete(_system, messages): Promise<Completion> {
      onComplete?.(messages);
      const text = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return Promise.resolve({ text, usage: { total_tokens: 10 }, toolCalls: [] });
    },
  };
}

export const TEAMBUILD_ROSTER = [
  "garchomp",
  "incineroar",
  "sinistcha",
  "farigiraf",
  "whimsicott",
  "pelipper",
  "charizard-mega-y",
  "toxapex",
  "grimmsnarl",
  "gholdengo",
].map(mon);

export function teambuildRequest(overrides: JsonObject = {}) {
  return {
    seriesIndex: 0,
    entrant: 0,
    opponent: 1,
    stage: "roundrobin" as const,
    model: "fake:model",
    opponentModel: "fake:rival",
    franchiseName: "Test Tauros",
    roster: TEAMBUILD_ROSTER,
    opponentRoster: TEAMBUILD_ROSTER.slice(0, 10),
    memory: emptyMemory("Flexible Ground offense with two speed-control modes."),
    playoffContext: [],
    format: BOARD.format,
    ...overrides,
  };
}

export const GOOD_TEAM = legalTeamResponse(
  "Rain beats their sun core, so Pelipper leads with Charizard held back.",
);
