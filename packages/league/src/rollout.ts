import type { Battle, Pokemon, Side } from "pokemon-showdown";

import { pendingSides } from "./fork.js";
import { opposing, winnerOf } from "./playout.js";
import type { Pid } from "./types.js";

type ActiveMove = ReturnType<Battle["dex"]["getActiveMove"]>;
type MoveRequestSlot = {
  moves: { id: string; pp?: number; disabled?: string | boolean }[];
  trapped?: boolean;
  canMegaEvo?: boolean;
};

const KO_BONUS = 0.5;
const CHIP_TAKEN = 0.5;
const GUARD_COST = 0.3;
const SWITCH_COST = 0.3;
const SPREAD_EDGE = 0.1;
const FLINCH_EDGE = 0.1;
const SPEED_FLIP = 0.25;
const SPREAD_TARGETS = new Set(["allAdjacentFoes", "allAdjacent"]);
const SINGLE_TARGETS = new Set(["normal", "any", "adjacentFoe"]);
const PRIORITY_BLOCKERS = ["armortail", "dazzling", "queenlymajesty"];

interface Hit {
  mon: Pokemon;
  damage: number;
}

interface Option {
  part: string;
  hits: Hit[];
  priority: number;
  utility: number;
  move?: ActiveMove;
  guard?: boolean;
  enter?: Pokemon;
  flinch?: Pokemon;
}

interface Slot {
  mon: Pokemon;
  speed: number;
  options: Option[];
  mega: boolean;
  trapped: boolean;
}

function living(mons: readonly (Pokemon | null)[]): Pokemon[] {
  return mons.flatMap((mon) => (mon && !mon.fainted ? [mon] : []));
}

function gain(mon: Pokemon, damage: number): number {
  return damage >= mon.hp ? mon.hp / mon.maxhp + KO_BONUS : damage / mon.maxhp;
}

function loss(mon: Pokemon, damage: number): number {
  return damage >= mon.hp ? mon.hp / mon.maxhp + KO_BONUS : (CHIP_TAKEN * damage) / mon.maxhp;
}

/** Projection runs Showdown's damage handlers on the rollout battle itself: a resist berry eats
 * itself inside `getDamage`, and rolls draw from the battle's dice, so both are shielded and the
 * log is trimmed back. */
function shielded<T>(battle: Battle, work: () => T): T {
  const prng = battle.prng;
  const logged = battle.log.length;
  const mons = battle.sides.flatMap((side) => side.pokemon);
  battle.prng = prng.clone();
  for (const mon of mons)
    Object.defineProperty(mon, "eatItem", { value: () => true, configurable: true });
  try {
    return work();
  } finally {
    battle.prng = prng;
    battle.log.length = logged;
    for (const mon of mons) Reflect.deleteProperty(mon, "eatItem");
  }
}

function prepare(
  battle: Battle,
  user: Pokemon,
  id: string,
  target: Pokemon | undefined,
): ActiveMove {
  const move = battle.dex.getActiveMove(id);
  if (move.category === "Status") return move;
  battle.singleEvent("ModifyType", move, null, user, target ?? null, move, move);
  battle.singleEvent("ModifyMove", move, null, user, target ?? null, move, move);
  battle.runEvent("ModifyType", user, target ?? null, move, move);
  if (move.willCrit === undefined) move.willCrit = false;
  return move;
}

function damage(battle: Battle, user: Pokemon, move: ActiveMove, target: Pokemon): number {
  let dealt = 0;
  try {
    dealt = Number(battle.actions.getDamage(user, target, move, true)) || 0;
  } catch {}
  const hits = Array.isArray(move.multihit)
    ? user.hasAbility("skilllink")
      ? (move.multihit[1] ?? 3)
      : 3
    : (move.multihit ?? 1);
  const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
  return dealt * hits * accuracy;
}

function priorityOf(user: Pokemon, move: ActiveMove): number {
  let priority = move.priority;
  if (move.category === "Status" && user.hasAbility("prankster")) priority += 1;
  if (move.type === "Flying" && user.hp === user.maxhp && user.hasAbility("galewings"))
    priority += 1;
  if (move.flags.heal && user.hasAbility("triage")) priority += 3;
  return priority;
}

function flinchable(battle: Battle, foe: Pokemon): boolean {
  if (foe.hasAbility(["innerfocus", "shielddust"]) || foe.hasItem("covertcloak")) return false;
  if (living(foe.side.active).some((mon) => mon.hasAbility(PRIORITY_BLOCKERS))) return false;
  return !(battle.field.isTerrain("psychicterrain") && foe.isGrounded());
}

function speedFlips(side: Side, speeds: Map<Pokemon, number>, tailwind: boolean): number {
  let flips = 0;
  for (const own of living(side.active))
    for (const foe of living(side.foe.active)) {
      const mine = speeds.get(own) ?? 0;
      const theirs = speeds.get(foe) ?? 0;
      if (tailwind) flips += Number(theirs > mine && 2 * mine > theirs);
      else flips += Number(theirs > mine) - Number(mine > theirs);
    }
  return flips;
}

function slotOptions(
  battle: Battle,
  side: Side,
  index: number,
  request: MoveRequestSlot,
  speeds: Map<Pokemon, number>,
): Slot | null {
  const mon = side.active[index];
  if (!mon || mon.fainted) return null;
  if (mon.getLockedMove())
    return {
      mon,
      speed: speeds.get(mon) ?? 0,
      options: [{ part: "move 1", hits: [], priority: 0, utility: 0 }],
      mega: false,
      trapped: true,
    };
  const foes = living(side.foe.active);
  const ally = living(side.active).find((other) => other !== mon);
  const trickRoom = Boolean(battle.field.pseudoWeather.trickroom);
  const options: Option[] = [];
  for (const [slot, entry] of request.moves.entries()) {
    if (entry.disabled || entry.pp === 0) continue;
    const move = prepare(battle, mon, entry.id, foes[0]);
    const part = `move ${slot + 1}`;
    const priority = priorityOf(mon, move);
    if (move.category === "Status") {
      if (move.stallingMove && !mon.volatiles.stall)
        options.push({ part, hits: [], priority, utility: -GUARD_COST, guard: true });
      const flips =
        move.id === "tailwind" && !side.sideConditions.tailwind && !trickRoom
          ? speedFlips(side, speeds, true)
          : move.id === "trickroom" && !trickRoom
            ? speedFlips(side, speeds, false)
            : 0;
      if (flips > 0) options.push({ part, hits: [], priority, utility: SPEED_FLIP * flips });
      continue;
    }
    if (!foes.length) continue;
    if (SPREAD_TARGETS.has(move.target)) {
      const targets = move.target === "allAdjacent" && ally ? [...foes, ally] : foes;
      move.spreadHit = targets.length > 1;
      const hits = targets.map((target) => ({
        mon: target,
        damage: damage(battle, mon, move, target),
      }));
      options.push({ part, hits, priority, utility: foes.length > 1 ? SPREAD_EDGE : 0, move });
    } else if (SINGLE_TARGETS.has(move.target)) {
      for (const foe of foes) {
        const dealt = damage(battle, mon, move, foe);
        const flinch = move.id === "fakeout" && dealt > 0 && flinchable(battle, foe);
        options.push({
          part: `${part} +${foe.position + 1}`,
          hits: [{ mon: foe, damage: dealt }],
          priority,
          utility: flinch ? FLINCH_EDGE : 0,
          move,
          flinch: flinch ? foe : undefined,
        });
      }
    } else if (move.target === "randomNormal") {
      const hits = foes.map((foe) => ({
        mon: foe,
        damage: damage(battle, mon, move, foe) / foes.length,
      }));
      options.push({ part, hits, priority, utility: 0, move });
    }
  }
  if (!options.length) options.push(fallbackMove(battle, mon, request));
  return {
    mon,
    speed: speeds.get(mon) ?? 0,
    options,
    mega: Boolean(request.canMegaEvo),
    trapped: Boolean(request.trapped),
  };
}

function fallbackMove(battle: Battle, mon: Pokemon, request: MoveRequestSlot): Option {
  const slot = Math.max(
    0,
    request.moves.findIndex((entry) => !entry.disabled && entry.pp !== 0),
  );
  const target = battle.dex.moves.get(request.moves[slot]?.id ?? "").target;
  const foe = living(mon.side.foe.active)[0];
  const suffix = SINGLE_TARGETS.has(target) && foe ? ` +${foe.position + 1}` : "";
  return { part: `move ${slot + 1}${suffix}`, hits: [], priority: 0, utility: 0 };
}

function intent(slot: Slot): Option | null {
  let best: Option | null = null;
  let bestValue = 0;
  for (const option of slot.options) {
    if (!option.move) continue;
    let value = option.utility;
    for (const hit of option.hits)
      value +=
        hit.mon.side === slot.mon.side ? -gain(hit.mon, hit.damage) : gain(hit.mon, hit.damage);
    if (value > bestValue) [best, bestValue] = [option, value];
  }
  return best;
}

interface Action {
  user: Pokemon;
  speed: number;
  option: Option;
  ours: boolean;
}

function jointValue(
  battle: Battle,
  ours: Slot[],
  choice: Option[],
  threats: Action[],
  redirected: Map<Option, Map<Pokemon, number>>,
): number {
  const occupant = new Map<Pokemon, Pokemon>();
  const guarded = new Set<Pokemon>();
  let value = 0;
  for (const [index, slot] of ours.entries()) {
    const option = choice[index]!;
    if (option.enter) occupant.set(slot.mon, option.enter);
    if (option.guard) guarded.add(slot.mon);
    if (option.enter || option.guard) value += option.utility;
  }
  const actions: Action[] = [
    ...ours.flatMap((slot, index) => {
      const option = choice[index]!;
      return option.enter || option.guard
        ? []
        : [{ user: slot.mon, speed: slot.speed, option, ours: true }];
    }),
    ...threats,
  ].sort(
    (a, b) =>
      b.option.priority - a.option.priority || b.speed - a.speed || Number(a.ours) - Number(b.ours),
  );
  const taken = new Map<Pokemon, number>();
  const flinched = new Set<Pokemon>();
  const down = (mon: Pokemon) => (taken.get(mon) ?? 0) >= mon.hp;
  for (const { user, option, ours: own } of actions) {
    if (down(user) || flinched.has(user)) continue;
    value += own ? option.utility : 0;
    for (const hit of option.hits) {
      if (guarded.has(hit.mon) || down(hit.mon)) continue;
      const replacement = occupant.get(hit.mon);
      let dealt = hit.damage;
      if (replacement && option.move) {
        const known = redirected.get(option) ?? new Map<Pokemon, number>();
        redirected.set(option, known);
        dealt = known.get(replacement) ?? damage(battle, user, option.move, replacement);
        known.set(replacement, dealt);
      }
      const target = replacement ?? hit.mon;
      taken.set(target, (taken.get(target) ?? 0) + dealt);
      if (own && option.flinch === hit.mon) flinched.add(hit.mon);
    }
  }
  for (const [mon, dealt] of taken)
    value += mon.side === ours[0]?.mon.side ? -loss(mon, dealt) : gain(mon, dealt);
  return value;
}

function turnCommand(battle: Battle, ours: (Slot | null)[], theirs: (Slot | null)[]): string {
  const active = ours.filter((slot): slot is Slot => slot !== null);
  const threats = theirs.flatMap((slot) => {
    const option = slot ? intent(slot) : null;
    return slot && option ? [{ user: slot.mon, speed: slot.speed, option, ours: false }] : [];
  });
  const incoming = new Map<Pokemon, number>();
  for (const { option } of threats)
    for (const hit of option.hits) incoming.set(hit.mon, (incoming.get(hit.mon) ?? 0) + hit.damage);
  const foeMoves = theirs.flatMap((slot) =>
    slot
      ? [...new Set(slot.options.flatMap((option) => (option.move ? [option.move] : [])))].map(
          (move) => [slot.mon, move] as const,
        )
      : [],
  );
  const safe = new Map<Pokemon, boolean>();
  const resists = (mon: Pokemon) => {
    const known =
      safe.get(mon) ?? foeMoves.every(([foe, move]) => damage(battle, foe, move, mon) < mon.hp / 2);
    safe.set(mon, known);
    return known;
  };
  for (const slot of active) {
    if (slot.trapped || (incoming.get(slot.mon) ?? 0) < slot.mon.hp) continue;
    const side = slot.mon.side;
    for (const bench of side.pokemon.slice(side.active.length))
      if (!bench.fainted && resists(bench))
        slot.options.push({
          part: `switch ${side.pokemon.indexOf(bench) + 1}`,
          hits: [],
          priority: 7,
          utility: -SWITCH_COST,
          enter: bench,
        });
  }
  const redirected = new Map<Option, Map<Pokemon, number>>();
  let best: Option[] = active.map((slot) => slot.options[0]!);
  let bestValue = -Infinity;
  const visit = (index: number, choice: Option[]) => {
    if (index === active.length) {
      const value = jointValue(battle, active, choice, threats, redirected);
      if (value > bestValue) [best, bestValue] = [[...choice], value];
      return;
    }
    for (const option of active[index]!.options) {
      if (option.enter && choice.some((other) => other.enter === option.enter)) continue;
      visit(index + 1, [...choice, option]);
    }
  };
  visit(0, []);
  let mega = false;
  return ours
    .map((slot) => {
      if (!slot) return "pass";
      const option = best[active.indexOf(slot)]!;
      if (slot.mega && !mega && !option.enter) {
        mega = true;
        return `${option.part} mega`;
      }
      return option.part;
    })
    .join(", ");
}

function matchup(battle: Battle, mon: Pokemon, foes: Pokemon[]): number {
  let offence = 0;
  let threat = 0;
  for (const foe of foes) {
    for (const slot of mon.moveSlots) {
      const move = prepare(battle, mon, slot.id, foe);
      if (move.category !== "Status")
        offence = Math.max(offence, gain(foe, damage(battle, mon, move, foe)));
    }
    for (const slot of foe.moveSlots) {
      const move = prepare(battle, foe, slot.id, mon);
      if (move.category !== "Status")
        threat = Math.max(threat, loss(mon, damage(battle, foe, move, mon)));
    }
  }
  return offence - threat;
}

function replacements(battle: Battle, side: Side, forced: readonly boolean[]): string {
  const foes = living(side.foe.active);
  const bench = side.pokemon
    .slice(side.active.length)
    .filter((mon) => !mon.fainted)
    .map((mon) => ({ mon, score: matchup(battle, mon, foes) }))
    .sort((a, b) => b.score - a.score);
  return forced
    .map((needed) => {
      const next = needed ? bench.shift() : undefined;
      return next ? `switch ${side.pokemon.indexOf(next.mon) + 1}` : "pass";
    })
    .join(", ");
}

export function rolloutCommands(battle: Battle): Partial<Record<Pid, string>> {
  return shielded(battle, () => {
    const speeds = new Map<Pokemon, number>();
    for (const side of battle.sides)
      for (const mon of living(side.active)) speeds.set(mon, mon.getActionSpeed());
    const slots: Partial<Record<Pid, (Slot | null)[]>> = {};
    for (const pid of ["p1", "p2"] as const) {
      const side = battle.getSide(pid);
      const request = side.activeRequest;
      if (request && !request.wait && !request.teamPreview && !request.forceSwitch)
        slots[pid] = request.active.map((entry, index) =>
          slotOptions(battle, side, index, entry, speeds),
        );
    }
    const commands: Partial<Record<Pid, string>> = {};
    for (const pid of pendingSides(battle)) {
      const side = battle.getSide(pid);
      const request = side.activeRequest!;
      if (request.teamPreview) commands[pid] = "default";
      else if (request.forceSwitch) commands[pid] = replacements(battle, side, request.forceSwitch);
      else commands[pid] = turnCommand(battle, slots[pid] ?? [], slots[opposing(pid)] ?? []);
    }
    return commands;
  });
}

export function rolloutCommand(battle: Battle, pid: Pid): string {
  return rolloutCommands(battle)[pid] ?? "";
}

export function rollOut(battle: Battle, maxTurns: number): Pid | null {
  const limit = battle.turn + maxTurns;
  while (!battle.ended && battle.turn < limit) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const commands = rolloutCommands(battle);
    for (const pid of pending) {
      if (battle.ended) break;
      if (battle.choose(pid, commands[pid] ?? "default")) continue;
      if (!battle.choose(pid, "default")) throw new Error(`${pid} has no accepted rollout choice`);
    }
  }
  return winnerOf(battle);
}
