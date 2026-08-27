import type { Pid } from "./types.js";

interface MoveState {
  name: string;
  used: number;
  pp?: number;
  maxpp?: number;
}

export interface LastMove {
  name: string;
  target?: string;
  turn: number;
}

export interface TimedEffect {
  name: string;
  startedTurn: number;
  duration?: number;
}

export interface SideTimer {
  seconds: number | null;
  turnSeconds: number | null;
  at: number;
  running: boolean;
}

export interface SideTimers {
  p1: SideTimer | undefined;
  p2: SideTimer | undefined;
}

export interface ProtectReducedSlots {
  [slot: number]: boolean;
}

export class MonState {
  species = "Pokémon";
  hp: string | undefined;
  hpPercent: number | undefined;
  status: string | undefined;
  stats: Record<string, number> = {};
  boosts: Record<string, number> = {};
  volatiles = new Set<string>();
  moves = new Map<string, MoveState>();
  lastMove: LastMove | undefined;
  choiceLock: string | undefined;
  item: string | undefined;
  itemConsumed = false;
  ability: string | undefined;
  abilitySuppressed = false;
  nature: string | undefined;
  mega = false;
  fainted = false;
  preview = false;
  brought: boolean | undefined;
  formes = new Set<string>();
  /** Successful consecutive Protect-like stalls; 0 means next Protect is full odds. */
  protectSuccessStreak = 0;

  constructor(public ident: string) {}

  recordMove(name: string, used = 0): MoveState {
    const key = stateKey(name);
    const entry = this.moves.get(key) ?? { name, used: 0 };
    if (name.includes(" ")) entry.name = name;
    entry.used += used;
    this.moves.set(key, entry);
    return entry;
  }
}

export class SideState {
  mons = new Map<string, MonState>();
  active: Record<string, string> = {};
  conditions = new Map<string, TimedEffect>();
  sheet: MonState[] = [];
  showteam = false;
}

export interface BattleStateView {
  readonly pid: Pid;
  weather: TimedEffect | undefined;
  fields: Map<string, TimedEffect>;
  sides: { p1: SideState; p2: SideState };
}

export const PROTECT_MOVES = new Set([
  "protect",
  "detect",
  "banefulbunker",
  "spikyshield",
  "silktrap",
  "burningbulwark",
]);

export const SCREEN_MOVES = new Set(["reflect", "lightscreen", "auroraveil"]);

export function stateKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
