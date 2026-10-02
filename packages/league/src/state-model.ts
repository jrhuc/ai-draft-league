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
  canMegaEvo = false;
  fainted = false;
  preview = false;
  brought: boolean | undefined;
  formes = new Set<string>();
  /** Types while they differ from the species' own (Protean, Soak); they revert on leaving the field. */
  types: string[] | undefined;
  /** The species to return to when a forme taken in battle (Stance Change, Transform) ends. */
  transientBase: string | undefined;
  transformed = false;
  /** Successful consecutive stalls; the next one's odds drop only while `lastStallTurn` is the previous turn. */
  protectSuccessStreak = 0;
  lastStallTurn: number | undefined;
  /** Direct hits since entering; Champions resets it on switch-out (Rage Fist). */
  timesAttacked = 0;

  constructor(public ident: string) {}

  /** Everything that ends when the Pokémon leaves the field. */
  leaveField(): void {
    this.boosts = {};
    this.volatiles.clear();
    this.choiceLock = undefined;
    this.timesAttacked = 0;
    this.types = undefined;
    this.transformed = false;
    this.protectSuccessStreak = 0;
    this.lastStallTurn = undefined;
    if (this.transientBase) this.species = this.transientBase;
    this.transientBase = undefined;
  }

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
  /** What was known of each slot's occupant before it entered, restored to a disguise when Illusion breaks. */
  entered: Record<string, Pick<MonState, "hp" | "hpPercent" | "status">> = {};
  conditions = new Map<string, TimedEffect>();
  sheet: MonState[] = [];
  showteam = false;
}

export interface PerspectiveStateView {
  readonly pid: Pid;
  weather: TimedEffect | undefined;
  fields: Map<string, TimedEffect>;
  sides: { p1: SideState; p2: SideState };
}

/** Moves that share Showdown's `stall` counter: each success lowers the next one's odds. */
export const PROTECT_MOVES = new Set([
  "protect",
  "detect",
  "banefulbunker",
  "spikyshield",
  "kingsshield",
  "endure",
  "wideguard",
  "quickguard",
]);

export const SCREEN_MOVES = new Set(["reflect", "lightscreen", "auroraveil"]);

export function stateKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
