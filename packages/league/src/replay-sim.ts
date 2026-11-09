import type { Battle, Pokemon } from "pokemon-showdown";

import { buildMenus } from "./choices.js";
import { battleRequest, deterministicBattleSnapshot, pendingSides, type Position } from "./fork.js";
import { defaultPsDir } from "./paths.js";
import { isBattleLine, type ReplayGame } from "./replay-log.js";
import { loadShowdown } from "./showdown.js";
import { stateKey } from "./state-model.js";
import type { BattleRequest, Pid } from "./types.js";

type PokemonSet = Pokemon["set"];
type Spread = PokemonSet["evs"];

export type ReplayPosition = Pick<
  Position,
  "index" | "turn" | "pending" | "requests" | "actual" | "snapshot"
>;

export interface ReplayDivergence {
  turn: number;
  want: string | null;
  got: string | null;
  /** The last lines the simulator wrote before parting from the log. */
  written: string[];
}

export interface ReplaySimulation {
  teams: Record<Pid, string>;
  positions: ReplayPosition[];
  /** Null when every recorded line was reproduced; otherwise where the simulator and the log part. */
  divergence: ReplayDivergence | null;
  /** Stat points moved off their assumed values because the log required it. */
  notes: string[];
}

const SEATS = ["p1", "p2"] as const;
const SLOTS = "ab";
const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const HP_FIELD = new Map([
  ["-damage", 3],
  ["-heal", 3],
  ["-sethp", 3],
  ["switch", 4],
  ["drag", 4],
  ["replace", 4],
]);
const ENTRY_KINDS = new Set(["switch", "drag", "replace"]);
const TURN_KINDS = new Set(["move", "cant", "switch"]);
const ACTION_KINDS = new Set(["move", "switch", "drag", "cant", "upkeep", "turn", "win", "tie"]);
const SURVIVAL =
  /^\|(?:-enditem\|[^|]+\|Focus Sash|-activate\|[^|]+\|(?:ability: Sturdy|move: Endure|item: Focus Band))/;
const OUTSIDE_BATTLE = new Set(["-message", "win", "tie"]);
const ROLL_DEFAULT = 8;
/** A draw from a range this wide is a percentage check: its top never passes, its bottom always does. */
const WIDE_DRAW = 16;
const ATTEMPT_LIMIT = 400;
const SIDE_LIMIT = 60;
const COMBINATION_LIMIT = 600;
const STEERED_LIMIT = 12;
const REPAIR_ATTEMPT_LIMIT = 12;
const REPAIR_BREADTH = 3;
const DRAW_REACH = 16;
const WORK_LIMIT = 12_000;
const REPAIR_LIMIT = 24;
const SPREAD_STAT = 32;
const SPREAD_TOTAL = 66;

function fields(line: string): string[] {
  return line.split("|");
}

function seatOf(ident: string | undefined): Pid | undefined {
  const seat = ident?.slice(0, 2);
  return seat === "p1" || seat === "p2" ? seat : undefined;
}

/** `p1a: Garchomp` and `p1: Garchomp` name the same Pokémon. */
function nameOf(ident: string): string {
  return `${ident.slice(0, 2)}${ident.slice(ident.indexOf(":"))}`;
}

function speciesOf(details: string): string {
  return details.split(",", 1)[0]!.trim();
}

class Divergence {
  written: string[] = [];

  constructor(
    readonly cursor: number,
    readonly want: string | undefined,
    readonly got: string | undefined,
  ) {}
}

interface Decision {
  size: number;
  chosen: number;
  kind: DiceKind;
}

export type DiceKind = "chance" | "draw" | "order" | "roll";

/** The outcome a draw of this kind usually has: the likelier side of a chance, a middling damage
 * roll, the first of an order, and a percentage check that does not pass. */
export function usualOutcome(size: number, kind: DiceKind): number {
  return kind === "roll" ? ROLL_DEFAULT : size > WIDE_DRAW ? size - 1 : 0;
}

/** Hands every random outcome of a battle to `decide`, which returns an index below `size`; for a
 * chance, index 0 is the likelier side. */
export function rigDice(battle: Battle, decide: (size: number, kind: DiceKind) => number): void {
  let rolling = false;
  let ordering = false;
  const prng = battle.prng;
  prng.random = (from?: number, to?: number) => {
    if (from === undefined) return 0.5;
    const low = to ? Math.floor(from) : 0;
    const size = (to ? Math.floor(to) : Math.floor(from)) - low;
    return size > 1 ? low + decide(size, rolling ? "roll" : ordering ? "order" : "draw") : low;
  };
  const shuffle = prng.shuffle.bind(prng);
  prng.shuffle = (items, start, end) => {
    ordering = true;
    try {
      shuffle(items, start, end);
    } finally {
      ordering = false;
    }
  };
  prng.randomChance = (numerator: number, denominator: number) => {
    if (numerator >= denominator) return true;
    if (numerator <= 0) return false;
    const likely = numerator * 2 >= denominator;
    return decide(2, "chance") === 0 ? likely : !likely;
  };
  const randomizer = battle.randomizer.bind(battle);
  battle.randomizer = (baseDamage) => {
    rolling = true;
    try {
      return randomizer(baseDamage);
    } finally {
      rolling = false;
    }
  };
}

/** Runs one stretch of the simulator against the recorded lines: every random outcome is a
 * decision that can be replayed differently, and every HP change is pulled to the recorded one. */
class Steer {
  readonly trace: Decision[] = [];
  cursor: number;
  private stableRaw: number;
  private stableCursor: number;
  private readonly resynced = new Set<number>();

  private readonly startRaw: number;

  constructor(
    private readonly battle: Battle,
    private readonly expected: readonly string[],
    cursor: number,
    private readonly forced: readonly number[],
    private awaitingStart: boolean,
  ) {
    this.cursor = cursor;
    this.stableCursor = cursor;
    this.stableRaw = battle.log.length;
    this.startRaw = battle.log.length;
    rigDice(battle, (size, kind) => this.decide(size, kind));
    const spreadDamage = battle.spreadDamage.bind(battle);
    battle.spreadDamage = (damage, targets, source, effect, instafaint) => {
      if (targets) this.pullDamage(damage, targets);
      return spreadDamage(damage, targets, source, effect, instafaint);
    };
    const heal = battle.heal.bind(battle);
    battle.heal = (amount, target, source, effect) => {
      const healed = target ?? battle.event?.target;
      const wanted =
        healed?.hp && healed.isActive && healed.hp < healed.maxhp
          ? this.wanted(healed, "-heal", [])
          : undefined;
      const landed = wanted && healed ? this.hpFor(healed, wanted.token, healed.hp + amount) : 0;
      return heal(
        healed && landed > healed.hp ? landed - healed.hp : amount,
        target,
        source,
        effect,
      );
    };
  }

  written(): string[] {
    const lines: string[] = [];
    const log = this.battle.log;
    for (let raw = this.startRaw; raw < log.length; raw += 1) {
      const split = log[raw]!.startsWith("|split|");
      const line = split ? (log[raw + 2] ?? "") : log[raw]!;
      if (split) raw += 2;
      if (isBattleLine(line)) lines.push(line);
    }
    return lines.slice(-10);
  }

  private decide(size: number, kind: DiceKind): number {
    this.sync(false);
    const planned = this.forced[this.trace.length];
    const chosen = planned !== undefined && planned < size ? planned : usualOutcome(size, kind);
    this.trace.push({ size, chosen, kind });
    return chosen;
  }

  private pokemon(ident: string): Pokemon | undefined {
    const seat = seatOf(ident);
    const slot = SLOTS.indexOf(ident.charAt(2));
    return seat && slot >= 0 ? (this.battle.getSide(seat).active[slot] ?? undefined) : undefined;
  }

  /** The HP a recorded token stands for, as near as possible to where the simulator had it. */
  private hpFor(pokemon: Pokemon, token: string, near: number): number {
    const exact = /^(\d+)\/(\d+)/.exec(token);
    if (!exact) return near;
    if (Number(exact[2]) !== 100) return Number(exact[1]);
    const held = pokemon.hp;
    let best = near;
    let cost = Infinity;
    for (let hp = 1; hp <= pokemon.maxhp; hp += 1) {
      pokemon.hp = hp;
      const shown = pokemon.getHealth().shared;
      const off = shown === token ? 0 : 1 + Math.abs(Number.parseInt(shown, 10) - Number(exact[1]));
      const candidate = off * 10_000 + Math.abs(hp - near);
      if (candidate < cost) {
        best = hp;
        cost = candidate;
      }
    }
    pokemon.hp = held;
    return best;
  }

  /** Looks ahead, within the action under way, for the recorded HP line of this Pokémon. */
  private wanted(
    pokemon: Pokemon,
    kind: string,
    claimed: number[],
  ): { token: string; lethal: boolean } | undefined {
    this.sync(false);
    const ident = pokemon.toString();
    let survives = false;
    for (let index = this.cursor; index < this.expected.length; index += 1) {
      const line = this.expected[index]!;
      const [, lineKind = "", who, token = ""] = fields(line);
      if (lineKind === kind && who === ident && !claimed.includes(index)) {
        claimed.push(index);
        return { token, lethal: survives || token.endsWith("fnt") };
      }
      if (index > this.cursor && ACTION_KINDS.has(lineKind)) return undefined;
      if (who === ident && SURVIVAL.test(line)) survives = true;
    }
    return undefined;
  }

  private pullDamage(
    damage: Parameters<Battle["spreadDamage"]>[0],
    targets: NonNullable<Parameters<Battle["spreadDamage"]>[1]>,
  ): void {
    const claimed: number[] = [];
    for (const [index, target] of targets.entries()) {
      const natural = damage[index];
      if (!target || !target.hp || !target.isActive) continue;
      if (natural === true || natural === false || natural === undefined || natural <= 0) continue;
      const wanted = this.wanted(target, "-damage", claimed);
      if (!wanted) continue;
      const held = target.hp;
      damage[index] = wanted.lethal
        ? Math.max(natural, held)
        : Math.max(1, held - this.hpFor(target, wanted.token, Math.max(1, held - natural)));
    }
  }

  /** Compares everything the simulator has written since the stretch began. The latest move line
   * can still be rewritten or withdrawn by the simulator, so only the lines before it are final. */
  sync(final: boolean): void {
    const { battle, expected } = this;
    const log = battle.log;
    const settledBelow =
      final || battle.lastMoveLine < this.stableRaw ? log.length : battle.lastMoveLine;
    let raw = this.stableRaw;
    let cursor = this.stableCursor;
    let awaitingStart = this.awaitingStart;
    while (raw < log.length) {
      const settled = raw < settledBelow;
      let line = log[raw]!;
      if (line.startsWith("|split|")) {
        line = log[raw + 2] ?? "";
        raw += 3;
      } else raw += 1;
      const kind = fields(line)[1];
      const want = expected[cursor];
      if (isBattleLine(line) && kind !== "player" && !(awaitingStart && line !== "|start")) {
        awaitingStart = false;
        if (!settled && kind === "-anim" && line !== want) continue;
        if (line !== want && !(want && this.relaxed(line, want, cursor, settled)))
          throw new Divergence(cursor, want, line);
        cursor += 1;
      }
      if (!settled) continue;
      this.stableRaw = raw;
      this.stableCursor = cursor;
      this.awaitingStart = awaitingStart;
    }
    this.cursor = cursor;
  }

  private relaxed(got: string, want: string, cursor: number, settled: boolean): boolean {
    const a = fields(got);
    const b = fields(want);
    if (a[1] !== b[1] || a[2] !== b[2]) return false;
    if (!settled && (a[1] === "move" || a[1] === "-anim"))
      return a[3] === b[3] && (a[4] === b[4] || b[4] === "");
    const at = HP_FIELD.get(a[1] ?? "");
    if (at === undefined || a.length !== b.length) return false;
    if (a.some((part, index) => index !== at && part !== b[index])) return false;
    const [was = "", now = ""] = [a[at], b[at]];
    if (was.endsWith("fnt") !== now.endsWith("fnt")) return false;
    if ((was.split(" ")[1] ?? "") !== (now.split(" ")[1] ?? "")) return false;
    if (!this.resynced.has(cursor)) {
      this.resynced.add(cursor);
      const pokemon = this.pokemon(a[2] ?? "");
      if (pokemon?.hp) pokemon.sethp(this.hpFor(pokemon, now, pokemon.hp));
    }
    return true;
  }
}

interface Attempt {
  battle: Battle;
  cursor: number;
  trace: Decision[];
  divergence: Divergence | null;
}

interface Stretch {
  snapshot: string;
  expected: readonly string[];
  cursor: number;
  first: boolean;
  psDir: string;
  /** Simulator runs spent on this game; repairs stop once it passes the limit. */
  work: { attempts: number };
}

function attempt(
  stretch: Stretch,
  commands: Partial<Record<Pid, string>>,
  forced: readonly number[],
): Attempt | null {
  stretch.work.attempts += 1;
  const { Battle: BattleClass } = loadShowdown(stretch.psDir);
  const battle = BattleClass.fromJSON(stretch.snapshot);
  battle.restart(() => {});
  const steer = new Steer(battle, stretch.expected, stretch.cursor, forced, stretch.first);
  let divergence: Divergence | null = null;
  try {
    for (const pid of pendingSides(battle)) {
      if (battle.ended) break;
      const command = commands[pid];
      if (!command || !battle.choose(pid, command)) return null;
    }
    steer.sync(true);
  } catch (error) {
    if (!(error instanceof Divergence)) throw error;
    divergence = error;
    divergence.written = steer.written();
  }
  return { battle, cursor: divergence?.cursor ?? steer.cursor, trace: steer.trace, divergence };
}

/** How nearly a diverging attempt wrote the wanted line: the same event on the same Pokémon, as
 * when a status lands but is the wrong one, is one draw away from matching. */
function closeness(result: Attempt): number {
  const [, wantKind, wantWho] = fields(result.divergence?.want ?? "");
  const [, gotKind, gotWho] = fields(result.divergence?.got ?? "");
  if (!wantWho || wantWho !== gotWho) return 0;
  return wantKind === gotKind ? 2 : 1;
}

function alternatives(decision: Decision): number[] {
  const values =
    decision.kind === "roll" || decision.size > WIDE_DRAW
      ? [0, decision.size - 1]
      : Array.from({ length: decision.size }, (_, value) => value);
  return values.filter((value) => value !== decision.chosen);
}

/** A decision replayed differently, first keeping every later decision as it was made and then
 * letting the later ones fall back to their usual outcomes. */
function redecided(trace: readonly Decision[], index: number, value: number): number[][] {
  const made = trace.map((decision) => decision.chosen);
  return [
    [...made.slice(0, index), value, ...made.slice(index + 1)],
    [...made.slice(0, index), value],
  ];
}

/** Replays a stretch until its lines match, changing one random outcome at a time and keeping a
 * change only when it carries the match further into the recorded log. */
function steered(
  stretch: Stretch,
  commands: Partial<Record<Pid, string>>,
  limit: number,
): Attempt | null {
  let remaining = limit;
  let best = attempt(stretch, commands, []);
  while (best?.divergence && remaining > 0) {
    let better: Attempt | null = null;
    search: for (let index = best.trace.length - 1; index >= 0; index -= 1) {
      for (const value of alternatives(best.trace[index]!)) {
        for (const forced of redecided(best.trace, index, value)) {
          if (remaining-- <= 0) break search;
          const next = attempt(stretch, commands, forced);
          if (
            next &&
            (!next.divergence ||
              next.cursor > best.cursor ||
              (next.cursor === best.cursor && closeness(next) > closeness(best)))
          ) {
            better = next;
            break search;
          }
        }
      }
    }
    if (!better) break;
    best = better;
  }
  return best;
}

interface Observed {
  switchTo?: string;
  move?: string;
  target?: string;
  mega: boolean;
}

function observe(lines: readonly string[], pid: Pid, slot: number, name: string): Observed {
  const observed: Observed = { mega: false };
  const position = `${pid}${SLOTS[slot]}:`;
  for (const line of lines) {
    const [, kind = "", who = "", third = "", fourth = ""] = fields(line);
    if (kind === "turn") break;
    if (ENTRY_KINDS.has(kind) && who.startsWith(position)) {
      if (kind === "switch" && !line.includes("|[from]") && !observed.move)
        observed.switchTo = speciesOf(third);
      break;
    }
    if (seatOf(who) !== pid || nameOf(who) !== name) continue;
    if (kind === "faint") break;
    if (kind === "-mega") observed.mega = true;
    else if (kind === "cant" && !observed.move) observed.move = fourth || "?";
    else if (kind === "move" && !observed.move) {
      if (line.includes("|[from]") && !line.includes("|[from] lockedmove")) continue;
      observed.move = third;
      observed.target = fourth.slice(0, 3);
    }
  }
  if (observed.move && !observed.target) {
    const fired = lines.find((line) => {
      const [, kind = "", who = "", third, fourth] = fields(line);
      return (
        (kind === "-anim" || (kind === "move" && line.includes("|[from] lockedmove"))) &&
        seatOf(who) === pid &&
        nameOf(who) === name &&
        third === observed.move &&
        Boolean(fourth)
      );
    });
    if (fired) observed.target = fields(fired)[4]!.slice(0, 3);
  }
  return observed;
}

interface Solution {
  commands: Partial<Record<Pid, string>>;
  result: Attempt;
}

interface Failure {
  stretch: Stretch;
  turn: number;
  /** The attempts that matched the most recorded lines, best first. */
  furthest: Solution[];
}

interface Pass {
  positions: ReplayPosition[];
  /** Where in the recorded lines each position began. */
  starts: number[];
  cursor: number;
  failure: Failure | null;
}

/** How many recorded lines a pass matched, counting the stretch it stopped in. */
function reached(pass: Pass): number {
  if (!pass.failure) return Infinity;
  return pass.failure.furthest[0]?.result.cursor ?? pass.cursor;
}

/** Rebuilds a recorded game inside the simulator from its public log: the choices are read off
 * the log, the dice are steered until every recorded line is reproduced, and stat points no sheet
 * shows are assumed and then corrected by the order the Pokémon were seen to act in. */
export class ReplaySimulator {
  private readonly dex;
  private readonly expected: string[];
  private readonly sets: Record<Pid, PokemonSet[]>;
  private readonly known: Record<Pid, boolean>;
  private readonly solutions = new Map<
    number,
    { commands: Solution["commands"]; trace: Decision[] }
  >();
  private readonly notes: string[] = [];
  private readonly work = { attempts: 0 };

  constructor(
    private readonly game: ReplayGame,
    spreads: Partial<Record<Pid, readonly PokemonSet[]>> = {},
    private readonly psDir = defaultPsDir(),
  ) {
    const { Dex, Teams } = loadShowdown(psDir);
    this.dex = Dex.forFormat(game.formatId);
    this.expected = [
      ...game.leads,
      ...game.turns.flatMap((turn) => [`|turn|${turn.turn}`, ...turn.lines]),
    ];
    const team = (pid: Pid): PokemonSet[] => {
      const sheet = game.sheets[pid];
      const sets = sheet ? Teams.unpack(sheet) : null;
      if (!sets?.length) throw new Error(`${game.id} shows no team sheet for ${pid}`);
      const previews = game.preview.flatMap((line) => {
        const [, kind, seat, details = ""] = fields(line);
        return kind === "poke" && seat === pid ? [details] : [];
      });
      const names = new Map<string, string>();
      for (const line of this.expected) {
        const [, kind = "", who = "", details = ""] = fields(line);
        if (ENTRY_KINDS.has(kind) && seatOf(who) === pid)
          names.set(this.base(speciesOf(details)), who.slice(who.indexOf(":") + 2));
      }
      for (const [index, set] of sets.entries()) {
        const known = spreads[pid]?.find(
          (candidate) => this.base(candidate.species) === this.base(set.species),
        );
        set.evs = { ...(known?.evs ?? this.assumedSpread(set)) };
        set.ivs = known?.ivs ?? { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
        set.shiny = previews[index]?.includes("shiny") ?? false;
        set.name = names.get(this.base(set.species)) ?? "";
      }
      return sets;
    };
    this.sets = { p1: team("p1"), p2: team("p2") };
    this.known = { p1: Boolean(spreads.p1), p2: Boolean(spreads.p2) };
  }

  private base(species: string): string {
    return stateKey(this.dex.species.get(species.replace(/-\*$/, "")).baseSpecies || species);
  }

  /** A stand-in for stat points no sheet shows: full investment where the nature points. */
  private assumedSpread(set: PokemonSet): Spread {
    const nature = this.dex.natures.get(set.nature);
    const categories = set.moves.map((move: string) => this.dex.moves.get(move).category);
    const attack =
      categories.filter((category: string) => category === "Special").length >=
      categories.filter((category: string) => category === "Physical").length
        ? "spa"
        : "atk";
    const spread: Spread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    const plus = nature.plus;
    const first = plus === "spe" ? "spe" : plus === "def" || plus === "spd" ? "hp" : attack;
    const second = plus === "spe" ? attack : plus === "def" || plus === "spd" ? plus : "hp";
    spread[first] = 32;
    spread[second] = 32;
    spread[STATS.find((stat) => stat !== first && stat !== second && stat !== nature.minus)!] = 2;
    return spread;
  }

  private packed() {
    const { Teams } = loadShowdown(this.psDir);
    return { p1: Teams.pack(this.sets.p1), p2: Teams.pack(this.sets.p2) };
  }

  private open(snapshot: string): Battle {
    const { Battle: BattleClass } = loadShowdown(this.psDir);
    const battle = BattleClass.fromJSON(snapshot);
    battle.restart(() => {});
    return battle;
  }

  private request(battle: Battle, pid: Pid): BattleRequest {
    return battleRequest(battle.getSide(pid).activeRequest!);
  }

  private teamIndex(request: BattleRequest, species: string): number {
    return (request.side?.pokemon ?? []).findIndex(
      (pokemon) => this.base(speciesOf(pokemon.details ?? "")) === this.base(species),
    );
  }

  private previewCommand(request: BattleRequest, pid: Pid): string {
    const brought: number[] = [];
    const add = (index: number) => {
      if (index >= 0 && !brought.includes(index)) brought.push(index);
    };
    for (const slot of SLOTS) {
      const lead = this.expected.find((line) => line.startsWith(`|switch|${pid}${slot}:`));
      if (lead) add(this.teamIndex(request, speciesOf(fields(lead)[3] ?? "")));
    }
    for (const line of this.expected) {
      const [, kind = "", who = "", details = ""] = fields(line);
      if (ENTRY_KINDS.has(kind) && seatOf(who) === pid)
        add(this.teamIndex(request, speciesOf(details)));
    }
    for (const index of (request.side?.pokemon ?? []).keys()) add(index);
    const size = request.maxChosenTeamSize ?? brought.length;
    return `team ${brought
      .slice(0, size)
      .map((index) => index + 1)
      .join("")}`;
  }

  private switchCommand(request: BattleRequest, pid: Pid, upcoming: readonly string[]): string {
    const taken = new Set<number>();
    const team = request.side?.pokemon ?? [];
    const revived = upcoming
      .find((line) => line.startsWith(`|-heal|${pid}: `) && line.includes("Revival Blessing"))
      ?.split("|")[2];
    return (request.forceSwitch ?? [])
      .map((forced, slot) => {
        if (!forced) return "pass";
        if (team.filter((pokemon) => pokemon.active)[slot]?.reviving)
          return `switch ${team.findIndex((pokemon) => pokemon.ident === revived) + 1}`;
        const entry = upcoming.find((line) => {
          const [, kind = "", who = ""] = fields(line);
          return ENTRY_KINDS.has(kind) && who.startsWith(`${pid}${SLOTS[slot]}:`);
        });
        const index = entry ? this.teamIndex(request, speciesOf(fields(entry)[3] ?? "")) : -1;
        if (index < 0 || taken.has(index)) return "pass";
        taken.add(index);
        return `switch ${index + 1}`;
      })
      .join(", ");
  }

  private moveCommands(request: BattleRequest, pid: Pid, upcoming: readonly string[]): string[] {
    const foe = pid === "p1" ? "p2" : "p1";
    const active = (request.side?.pokemon ?? []).filter((pokemon) => pokemon.active);
    const menus = buildMenus(request).map((menu, slot) => {
      const mon = active[slot];
      const observed = observe(upcoming, pid, slot, mon?.ident ?? "");
      const moves = request.active?.[slot]?.moves ?? [];
      const parsed = menu.map((item) => {
        const move = /^move (\d+)(?: ([+-])(\d))?( mega)?$/.exec(item.part);
        const target = move?.[2]
          ? `${move[2] === "+" ? foe : pid}${SLOTS[Number(move[3]) - 1]}`
          : undefined;
        return {
          part: item.part,
          kind: item.kind,
          move: move ? stateKey(moves[Number(move[1]) - 1]?.move ?? "") : undefined,
          mega: Boolean(move?.[4]),
          target,
          switchTo: item.kind === "switch" ? Number(item.part.slice(7)) - 1 : undefined,
        };
      });
      if (parsed.every((item) => item.kind === "pass")) return parsed;
      let kept = parsed.filter((item) =>
        observed.switchTo
          ? item.switchTo === this.teamIndex(request, observed.switchTo)
          : item.kind === "move" && item.mega === observed.mega,
      );
      const wanted = stateKey(observed.move ?? "");
      const named = kept.filter((item) => item.move === wanted);
      const unlisted = moves.findIndex((move) => stateKey(move.move ?? "") === wanted);
      if (named.length) kept = named;
      else if (unlisted >= 0 && !observed.switchTo)
        kept = ["", " -1", " -2", " +1", " +2"].map((aim) => ({
          part: `move ${unlisted + 1}${aim}${observed.mega ? " mega" : ""}`,
          kind: "move" as const,
          move: wanted,
          mega: observed.mega,
          target: undefined,
          switchTo: undefined,
        }));
      if (!kept.length) kept = parsed.filter((item) => item.kind !== "forfeit");
      const priority = (item: (typeof parsed)[number]) =>
        Math.abs(this.dex.moves.get(item.move ?? "").priority ?? 0);
      if (!named.length) kept.sort((a, b) => priority(a) - priority(b));
      return [
        ...kept.filter((item) => item.target === observed.target),
        ...kept.filter((item) => item.target !== observed.target),
      ];
    });
    let commands: string[][] = [[]];
    for (const menu of menus)
      commands = commands.flatMap((parts) =>
        menu
          .filter(
            (item) =>
              !(item.mega && parts.some((part) => part.endsWith(" mega"))) &&
              !(item.kind === "switch" && parts.includes(item.part)),
          )
          .map((item) => [...parts, item.part]),
      );
    return commands.slice(0, SIDE_LIMIT).map((parts) => parts.join(", "));
  }

  private candidates(battle: Battle, pid: Pid, cursor: number): string[] {
    const request = this.request(battle, pid);
    const upcoming = this.expected.slice(cursor);
    if (request.teamPreview) return [this.previewCommand(request, pid)];
    if (request.forceSwitch) return [this.switchCommand(request, pid, upcoming)];
    return this.moveCommands(request, pid, upcoming);
  }

  /** The commands and dice that carry one stretch furthest, best first; solved when the first
   * diverges nowhere. */
  private solve(stretch: Stretch, steeredLimit: number): Solution[] {
    const battle = this.open(stretch.snapshot);
    const pending = pendingSides(battle);
    const options = SEATS.map((pid) =>
      pending.includes(pid) ? this.candidates(battle, pid, stretch.cursor) : [undefined],
    );
    const tried: Solution[] = [];
    search: for (const p1 of options[0]!) {
      for (const p2 of options[1]!) {
        if (tried.length >= COMBINATION_LIMIT) break search;
        const commands: Partial<Record<Pid, string>> = {};
        if (p1) commands.p1 = p1;
        if (p2) commands.p2 = p2;
        const result = attempt(stretch, commands, []);
        if (!result) continue;
        if (!result.divergence) return [{ commands, result }];
        tried.push({ commands, result });
      }
    }
    const ranked = (solutions: Solution[]) => {
      solutions.sort(
        (a, b) => b.result.cursor - a.result.cursor || this.nearness(b) - this.nearness(a),
      );
      const strays = new Set<string>();
      const fresh: Solution[] = [];
      const repeated: Solution[] = [];
      for (const solution of solutions) {
        const stray = `${solution.result.cursor}|${solution.result.divergence?.got}`;
        (strays.has(stray) ? repeated : fresh).push(solution);
        strays.add(stray);
      }
      return [...fresh, ...repeated];
    };
    tried.splice(0, tried.length, ...ranked(tried));
    for (const [index, entry] of tried.slice(0, steeredLimit).entries()) {
      const result = steered(stretch, entry.commands, ATTEMPT_LIMIT);
      if (!result) continue;
      if (!result.divergence) return [{ commands: entry.commands, result }];
      tried[index] = { commands: entry.commands, result };
    }
    return ranked(tried);
  }

  private start(): Battle {
    const { Battle: BattleClass } = loadShowdown(this.psDir);
    const start = new BattleClass({ formatid: this.game.formatId, seed: "1,2,3,4" });
    const teams = this.packed();
    for (const pid of SEATS)
      start.setPlayer(pid, { name: this.game.players[pid], team: teams[pid] });
    return start;
  }

  /** How close a diverging attempt is to the log: the right Pokémon doing the wrong thing beats
   * the wrong Pokémon acting, which beats a line the log never has. */
  private nearness(solution: Solution): number {
    const divergence = solution.result.divergence;
    if (!divergence?.want || !divergence.got) return 0;
    const [, , wanted] = fields(divergence.want);
    const [, kind, who, third] = fields(divergence.got);
    if (who === wanted) return 2;
    const ahead = this.expected.slice(divergence.cursor + 1);
    const turnEnd = ahead.findIndex((line) => line.startsWith("|turn|"));
    return (turnEnd < 0 ? ahead : ahead.slice(0, turnEnd)).some((line) => {
      const [, laterKind, laterWho, laterThird] = fields(line);
      return laterKind === kind && laterWho === who && (kind !== "move" || laterThird === third);
    })
      ? 1
      : 0;
  }

  private pass(): Pass {
    const start = this.start();
    const positions: ReplayPosition[] = [];
    const starts: number[] = [];
    let snapshot = deterministicBattleSnapshot(start);
    let cursor = 0;
    for (;;) {
      const battle = this.open(snapshot);
      const pending = pendingSides(battle);
      if (battle.ended || !pending.length) break;
      if (this.expected.slice(cursor).every((line) => OUTSIDE_BATTLE.has(fields(line)[1] ?? "")))
        break;
      const stretch: Stretch = {
        snapshot,
        expected: this.expected,
        cursor,
        first: !positions.length,
        psDir: this.psDir,
        work: this.work,
      };
      const cached = this.solutions.get(positions.length);
      const replayed = cached
        ? attempt(
            stretch,
            cached.commands,
            cached.trace.map((decision) => decision.chosen),
          )
        : null;
      const ranked =
        cached && replayed && !replayed.divergence
          ? [{ commands: cached.commands, result: replayed }]
          : this.solve(stretch, STEERED_LIMIT);
      const solution = ranked[0];
      if (!solution || solution.result.divergence)
        return {
          positions,
          starts,
          cursor,
          failure: { stretch, turn: battle.turn, furthest: ranked },
        };
      this.solutions.set(positions.length, {
        commands: solution.commands,
        trace: solution.result.trace,
      });
      starts.push(cursor);
      positions.push({
        index: positions.length,
        turn: battle.turn,
        pending,
        requests: { p1: this.request(battle, "p1"), p2: this.request(battle, "p2") },
        actual: solution.commands,
        snapshot,
      });
      cursor = solution.result.cursor;
      const next = solution.result.battle;
      next.resetRNG();
      snapshot = deterministicBattleSnapshot(next);
    }
    return { positions, starts, cursor, failure: null };
  }

  private setSpeed(set: PokemonSet, value: number): void {
    set.evs.spe = value;
    const others = STATS.filter((stat) => stat !== "spe");
    const total = () => STATS.reduce((sum, stat) => sum + set.evs[stat], 0);
    while (total() > SPREAD_TOTAL) {
      const richest = others.reduce((a, b) => (set.evs[b] > set.evs[a] ? b : a));
      set.evs[richest] -= 1;
    }
  }

  /** When the simulator's Pokémon act in an order the log contradicts, the Speed of one whose stat
   * points are assumed is moved the least distance that carries the match past that line; an order
   * only an exact tie explains is found by trying every value. */
  private *speedRepairs(failure: Failure): Generator<{ set: PokemonSet; value: number }> {
    const event = (line: string) => {
      const [, kind, who, third] = fields(line);
      return `${kind}|${who}|${kind === "move" ? third : ""}`;
    };
    const seen = new Set<string>();
    for (const furthest of failure.furthest) {
      const divergence = furthest.result.divergence;
      if (!divergence?.want || !divergence.got) continue;
      const signature = `${divergence.want}\n${divergence.got}`;
      if (seen.has(signature)) continue;
      if (seen.size >= REPAIR_BREADTH) break;
      seen.add(signature);
      const ahead = this.expected.slice(divergence.cursor + 1);
      const turnEnd = ahead.findIndex((line) => line.startsWith("|turn|"));
      const later = turnEnd < 0 ? ahead : ahead.slice(0, turnEnd);
      const [, wantKind = "", wantWho] = fields(divergence.want);
      const [, gotKind = "", gotWho] = fields(divergence.got);
      const outOfTurn = TURN_KINDS.has(wantKind) && TURN_KINDS.has(gotKind) && wantWho !== gotWho;
      if (!outOfTurn && !later.some((line) => event(line) === event(divergence.got!))) continue;
      const reached = furthest.result.cursor;
      const before = this.open(failure.stretch.snapshot);
      const leaving = [divergence.want, divergence.got].flatMap((line) => {
        const [, kind = "", who = ""] = fields(line);
        const out = ENTRY_KINDS.has(kind)
          ? before.getSide(seatOf(who)!).active[SLOTS.indexOf(who.charAt(2))]
          : undefined;
        return out ? [out.fullname] : [];
      });
      const idents = signature.match(/p[12][ab]: [^|\]\n]+/g) ?? [];
      for (const name of new Set([...leaving, ...idents.map((ident) => nameOf(ident))])) {
        const pid = seatOf(name)!;
        if (this.known[pid]) continue;
        const position = this.open(failure.stretch.snapshot)
          .getSide(pid)
          .pokemon.findIndex((mon) => mon.fullname === name);
        const set = this.sets[pid].find(
          (candidate) =>
            candidate.name === name.slice(4) ||
            this.base(candidate.species) === this.base(name.slice(4)),
        );
        if (position < 0 || !set) continue;
        const carries = (value: number): boolean => {
          const probe = this.open(failure.stretch.snapshot);
          const mon = probe.getSide(pid).pokemon[position]!;
          mon.set.evs.spe = value;
          mon.baseStoredStats.spe = probe.statModify(mon.baseSpecies.baseStats, mon.set, "spe");
          mon.storedStats.spe = probe.statModify(mon.species.baseStats, mon.set, "spe");
          probe.updateSpeed();
          const result = steered(
            { ...failure.stretch, snapshot: deterministicBattleSnapshot(probe) },
            furthest.commands,
            REPAIR_ATTEMPT_LIMIT,
          );
          return Boolean(result && result.cursor > reached);
        };
        const current = set.evs.spe;
        const offered = new Set<number>();
        for (const extreme of [SPREAD_STAT, 0]) {
          if (extreme === current || !carries(extreme)) continue;
          let fails = current;
          let works = extreme;
          while (Math.abs(works - fails) > 1) {
            const middle = Math.trunc((works + fails) / 2);
            if (carries(middle)) works = middle;
            else fails = middle;
          }
          offered.add(works);
          yield { set, value: works };
        }
        for (let value = 0; value <= SPREAD_STAT; value += 1) {
          if (value === current || offered.has(value) || !carries(value)) continue;
          yield { set, value };
        }
      }
    }
  }

  private repairedSpeed(pass: Pass): Pass | null {
    for (const { set, value } of this.speedRepairs(pass.failure!)) {
      if (this.spent()) break;
      const before = { ...set.evs };
      const solutions = new Map(this.solutions);
      this.setSpeed(set, value);
      const next = this.carriesOn(pass, 0, this.start(), 0) ? this.pass() : pass;
      if (reached(next) > reached(pass)) {
        const side = SEATS.find((pid) => this.sets[pid].includes(set));
        this.notes.push(
          `${side} ${set.species}: assumed ${before.spe} Speed points; the order on turn ${pass.failure!.turn} needs ${value > before.spe ? "at least" : "at most"} ${value}`,
        );
        return next;
      }
      set.evs = before;
      this.solutions.clear();
      for (const [step, solution] of solutions) this.solutions.set(step, solution);
    }
    return null;
  }

  private stretchAt(pass: Pass, step: number): Stretch {
    return {
      snapshot: pass.positions[step]!.snapshot,
      expected: this.expected,
      cursor: pass.starts[step]!,
      first: step === 0,
      psDir: this.psDir,
      work: this.work,
    };
  }

  /** Whether the stretches from `step` on, replayed with the commands that solved them, now carry
   * the match past where it stopped. */
  private carriesOn(pass: Pass, step: number, battle: Battle, cursor: number): boolean {
    let from = { battle, cursor };
    for (let at = step; at <= pass.positions.length; at += 1) {
      from.battle.resetRNG();
      const stretch: Stretch = {
        snapshot: deterministicBattleSnapshot(from.battle),
        expected: this.expected,
        cursor: from.cursor,
        first: at === 0,
        psDir: this.psDir,
        work: this.work,
      };
      const solved = this.solutions.get(at);
      const commands = solved?.commands ?? pass.failure?.furthest[0]?.commands;
      if (!commands) return false;
      const replayed = solved
        ? attempt(
            stretch,
            commands,
            solved.trace.map((decision) => decision.chosen),
          )
        : null;
      const next =
        replayed && !replayed.divergence
          ? replayed
          : steered(stretch, commands, REPAIR_ATTEMPT_LIMIT);
      if (!next) return false;
      if (at === pass.positions.length) return !next.divergence || next.cursor > reached(pass);
      if (next.divergence) return false;
      from = next;
    }
    return false;
  }

  /** A sleep or a confusion lasts as long as a draw made when it began, turns before the log
   * shows how long that was. A different draw is kept only when its own stretch still matches. */
  private redrawn(pass: Pass): Pass | null {
    const failed = pass.positions.length;
    const draws = [];
    for (let step = failed - 1; step >= Math.max(0, failed - DRAW_REACH); step -= 1)
      for (const [index, decision] of (this.solutions.get(step)?.trace ?? []).entries())
        if (decision.kind === "draw" && decision.size <= WIDE_DRAW)
          draws.push({ step, index, decision });
    draws.sort((a, b) => Number(b.decision.size > 2) - Number(a.decision.size > 2));
    for (const { step, index, decision } of draws) {
      if (this.spent()) break;
      const solution = this.solutions.get(step)!;
      for (let value = 0; value < decision.size; value += 1) {
        if (value === decision.chosen) continue;
        const changed = redecided(solution.trace, index, value)
          .map((forced) => attempt(this.stretchAt(pass, step), solution.commands, forced))
          .find((result) => result && !result.divergence);
        if (!changed) continue;
        if (!this.carriesOn(pass, step + 1, changed.battle, changed.cursor)) continue;
        const solutions = new Map(this.solutions);
        this.solutions.set(step, { commands: solution.commands, trace: changed.trace });
        const next = this.pass();
        if (reached(next) > reached(pass)) return next;
        this.solutions.clear();
        for (const [at, kept] of solutions) this.solutions.set(at, kept);
      }
    }
    return null;
  }

  private spent(): boolean {
    return this.work.attempts > WORK_LIMIT;
  }

  run(): ReplaySimulation {
    let pass = this.pass();
    for (let repairs = 0; pass.failure && repairs < REPAIR_LIMIT && !this.spent(); repairs += 1) {
      const next = this.repairedSpeed(pass) ?? this.redrawn(pass);
      if (!next) break;
      pass = next;
    }
    const failed = pass.failure?.furthest[0]?.result.divergence;
    return {
      teams: this.packed(),
      positions: pass.positions,
      divergence: pass.failure
        ? {
            turn: pass.failure.turn,
            want: failed?.want ?? null,
            got: failed?.got ?? null,
            written: failed?.written ?? [],
          }
        : null,
      notes: this.notes,
    };
  }
}
