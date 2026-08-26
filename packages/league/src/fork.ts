import type { Battle } from "pokemon-showdown";

import { BaseEngine } from "./battle-agent.js";
import { buildMenus } from "./choices.js";
import { defaultPsDir } from "./paths.js";
import { canonicalJson } from "./serialization.js";
import { loadShowdown } from "./showdown.js";
import { routeUpdateLines } from "./sim.js";
import type { BattleRequest, Pid } from "./types.js";

export interface GameSource {
  format: string;
  seed: [number, number, number, number];
  names: Record<Pid, string>;
  packed: Record<Pid, string>;
  choices: Record<Pid, string[]>;
  psDir?: string;
}

export interface Position {
  index: number;
  turn: number;
  pending: Pid[];
  requests: Record<Pid, BattleRequest>;
  actual: Partial<Record<Pid, string>>;
  choiceIndex: Partial<Record<Pid, number>>;
  seen: Record<Pid, number>;
  snapshot: string;
}

export interface Replay {
  verified: boolean;
  positions: Position[];
  log: string[];
  pov: Record<Pid, string[]>;
  turns: number;
  winner: string | null;
  ranOutOfChoices: boolean;
}

const CHOICE_LIMIT = 500;
interface ReplayRouteState {
  pov: { p1: string[]; p2: string[] };
  log: string[];
  publicLog: string[];
  pendingSplit: string[];
  winner: string | null;
  turns: number;
}

type SnapshotValue =
  | null
  | string
  | number
  | boolean
  | SnapshotValue[]
  | { [key: string]: SnapshotValue };

interface SerializedBattleSnapshot {
  [key: string]: SnapshotValue | undefined;
  log?: string[];
}

function routeState(): ReplayRouteState {
  return {
    pov: { p1: [], p2: [] },
    log: [],
    publicLog: [],
    pendingSplit: [],
    winner: null,
    turns: 0,
  };
}

function comparable(lines: string[]): string[] {
  return lines.filter((line) => line && !line.startsWith("|t:|") && !line.startsWith("|timer|"));
}

export interface LegalActionEntry {
  number: number;
  choices: number[];
  command: string;
  label: string;
}

/** Enumerates the modeled request-menu candidate superset; only the native acceptance helpers
 * below may promote these commands into an authoritative action set. */
export function requestActionCandidateEntries(request: BattleRequest): LegalActionEntry[] {
  const menus = buildMenus(request);
  if (!menus.length) return [];
  let combinations: number[][] = [[]];
  for (const menu of menus) {
    combinations = combinations.flatMap((prefix) =>
      menu.flatMap((item, index) => (item.kind === "forfeit" ? [] : [[...prefix, index]])),
    );
  }
  const actions = new Map<string, LegalActionEntry>();
  for (const choices of combinations) {
    let parts: string[];
    try {
      parts = BaseEngine.parts(menus, choices);
    } catch {
      continue;
    }
    const command = request.teamPreview ? `team ${parts.join("")}` : parts.join(", ");
    const labels = choices.map(
      (choice, slot) => menus[slot]?.[choice]?.label ?? parts[slot] ?? "pass",
    );
    const label = request.teamPreview
      ? labels
          .map(
            (entry, slot) =>
              `${["Lead 1", "Lead 2", "Back 1", "Back 2"][slot] ?? `Slot ${slot + 1}`}: ${entry}`,
          )
          .join("; ")
      : labels.length === 1
        ? (labels[0] ?? command)
        : labels.map((entry, slot) => `Slot ${slot + 1}: ${entry}`).join("; ");
    if (!actions.has(command)) actions.set(command, { number: -1, choices, command, label });
  }
  return [...actions.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.command), Buffer.from(b.command)))
    .map((entry, number) => ({ ...entry, number }));
}

type NativeBattleConstructor = {
  fromJSON(serialized: ReturnType<Battle["toJSON"]>): Battle;
};
function nativeBattleConstructor(battle: Battle): NativeBattleConstructor {
  const battleClass = battle.constructor;
  const fromJSON = Object.getOwnPropertyDescriptor(battleClass, "fromJSON")?.value;
  if (!(fromJSON instanceof Function)) throw new Error("Showdown Battle.fromJSON is unavailable");
  return {
    fromJSON(serialized) {
      return fromJSON.call(battleClass, serialized);
    },
  };
}
interface ShowdownRequestBridge {
  side: { pokemon: readonly { ident: string }[] };
}

function battleRequest(request: ShowdownRequestBridge): BattleRequest {
  return (
    // SAFETY: BattleRequest mirrors the fields consumed from the pinned Showdown ChoiceRequest.
    request as BattleRequest
  );
}

/** Filters the declared request-derived candidates through the authoritative Showdown side-choice
 * oracle. Each candidate gets an independent restarted serialization clone, and accepted candidates
 * are assigned canonical dense zero-based numbers without changing their generator order. */
export function acceptedLegalActionEntries(
  battle: Battle,
  pid: Pid,
  candidates: readonly LegalActionEntry[],
): LegalActionEntry[] {
  const BattleClass = nativeBattleConstructor(battle);
  const serialized = battle.toJSON();
  const accepted: LegalActionEntry[] = [];
  for (const candidate of candidates) {
    try {
      const clone = BattleClass.fromJSON(structuredClone(serialized));
      clone.restart(() => {});
      if (clone.getSide(pid).choose(candidate.command) === true) {
        accepted.push({ ...structuredClone(candidate), number: accepted.length });
      }
    } catch {}
  }
  return accepted;
}

export function acceptedBattleActionEntries(battle: Battle, pid: Pid): LegalActionEntry[] {
  const request = battle.getSide(pid).activeRequest;
  if (!request || request.wait) return [];
  return acceptedLegalActionEntries(
    battle,
    pid,
    requestActionCandidateEntries(battleRequest(request)),
  );
}

/** Removes exact Showdown wall-clock messages without treating lookalike text as time. Recursive
 * canonical serialization defines new snapshot bytes; older noncanonical snapshots remain restorable. */
export function deterministicBattleSnapshot(battle: Battle): string {
  const serialized: SerializedBattleSnapshot = JSON.parse(JSON.stringify(battle.toJSON()));
  if (serialized.log) {
    serialized.log = serialized.log.map((line) => (/^\|t:\|\d+$/u.test(line) ? "|t:|" : line));
  }
  return canonicalJson(serialized);
}

export function newBattle(source: GameSource): Battle {
  const { Battle: BattleClass } = loadShowdown(source.psDir ?? defaultPsDir());
  const [a, b, c, d] = source.seed;
  const battle = new BattleClass({ formatid: source.format, seed: `${a},${b},${c},${d}` });
  for (const pid of ["p1", "p2"] as const) {
    battle.setPlayer(pid, { name: source.names[pid], team: source.packed[pid] });
  }
  return battle;
}

export function pendingSides(battle: Battle): Pid[] {
  return (["p1", "p2"] as const).filter((pid) => {
    const request = battle.getSide(pid).activeRequest;
    return Boolean(request) && !request?.wait;
  });
}

export function replayGame(source: GameSource, recordedLog?: string[]): Replay {
  const battle = newBattle(source);
  const cursor = { p1: 0, p2: 0 };
  const positions: Position[] = [];
  const state = routeState();
  let consumed = 0;
  let ranOutOfChoices = false;
  let rejectedChoice = false;
  let steps = 0;

  const drain = () => {
    const fresh = battle.log.slice(consumed).filter((line) => line);
    consumed = battle.log.length;
    if (fresh.length) routeUpdateLines(fresh, state);
  };

  while (!battle.ended && steps++ < CHOICE_LIMIT) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const decisions: Array<[Pid, string]> = [];
    for (const pid of pending) {
      const choice = source.choices[pid][cursor[pid]];
      if (choice === undefined) {
        ranOutOfChoices = true;
        break;
      }
      cursor[pid] += 1;
      decisions.push([pid, choice]);
    }
    if (ranOutOfChoices) break;
    drain();
    positions.push({
      index: positions.length,
      turn: battle.turn,
      pending,
      requests: {
        p1: battleRequest(battle.getSide("p1").activeRequest!),
        p2: battleRequest(battle.getSide("p2").activeRequest!),
      },
      actual: Object.fromEntries(decisions),
      choiceIndex: Object.fromEntries(pending.map((pid) => [pid, cursor[pid] - 1])),
      seen: { p1: state.pov.p1.length, p2: state.pov.p2.length },
      snapshot: deterministicBattleSnapshot(battle),
    });
    for (const [pid, choice] of decisions) {
      if (choice.split(", ").includes("forfeit")) {
        battle.lose(pid);
        break;
      }
      if (!battle.choose(pid, choice)) {
        rejectedChoice = true;
        break;
      }
    }
    if (rejectedChoice) break;
  }

  drain();
  const expected = recordedLog === undefined ? undefined : comparable(recordedLog);
  const produced = comparable(state.log);
  const consumedEveryChoice = (["p1", "p2"] as const).every(
    (pid) => cursor[pid] === source.choices[pid].length,
  );
  const verified =
    expected !== undefined &&
    battle.ended &&
    steps <= CHOICE_LIMIT &&
    !ranOutOfChoices &&
    !rejectedChoice &&
    consumedEveryChoice &&
    produced.length === expected.length &&
    produced.every((line, index) => line === expected[index]);

  return {
    verified,
    positions,
    log: state.log,
    pov: state.pov,
    turns: battle.turn,
    winner: battle.winner || null,
    ranOutOfChoices,
  };
}

export function openPosition(position: Position, psDir = defaultPsDir()): Battle {
  const { Battle: BattleClass } = loadShowdown(psDir);
  const battle = BattleClass.fromJSON(position.snapshot);
  battle.restart(() => {});
  return battle;
}

export function playJoint(battle: Battle, choices: Partial<Record<Pid, string>>): boolean {
  for (const pid of pendingSides(battle)) {
    const choice = choices[pid];
    if (!choice || !battle.choose(pid, choice)) return false;
    if (battle.ended) return true;
  }
  return true;
}
