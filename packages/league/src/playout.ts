import type { Battle, Pokemon } from "pokemon-showdown";

import {
  acceptedBattleActionEntries,
  battleActionCandidates,
  cloneBattle,
  pendingSides,
} from "./fork.js";
import type { Rng } from "./random.js";
import type { Pid } from "./types.js";

const SPREAD_TARGETS = new Set(["allAdjacentFoes", "allAdjacent"]);
const UNTARGETED = new Set([
  "self",
  "all",
  "allySide",
  "foeSide",
  "allyTeam",
  "allies",
  "randomNormal",
  "scripted",
  ...SPREAD_TARGETS,
]);

export function opposing(pid: Pid): Pid {
  return pid === "p1" ? "p2" : "p1";
}

function living(mons: readonly (Pokemon | null)[]): Pokemon[] {
  return mons.flatMap((mon) => (mon && !mon.fainted ? [mon] : []));
}

function projectedScore(scratch: Battle, attacker: Pokemon, moveId: string): [number, string] {
  const move = scratch.dex.getActiveMove(moveId);
  if (move.category === "Status") return [-1, ""];
  const foes = living(attacker.side.foe.active);
  if (!foes.length) return [-1, ""];
  const spread = SPREAD_TARGETS.has(move.target);
  const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
  let best: [number, string] = [-1, ""];
  for (const group of spread ? [foes] : foes.map((foe) => [foe])) {
    let score = 0;
    for (const foe of group) {
      const attempt = scratch.dex.getActiveMove(moveId);
      if (spread && foes.length > 1) attempt.spreadHit = true;
      let damage = 0;
      try {
        damage = Number(scratch.actions.getDamage(attacker, foe, attempt, true)) || 0;
      } catch {}
      const fraction = Math.min(1, damage / Math.max(1, foe.hp));
      score += fraction + (fraction >= 1 ? 0.5 : 0);
    }
    const target = UNTARGETED.has(move.target) ? "" : ` +${(group[0]?.position ?? 0) + 1}`;
    if (score * accuracy > best[0]) best = [score * accuracy, target];
  }
  return best;
}

/** The continuation policy every rollout value is conditional on: each active Pokémon uses its
 * highest projected damage, Mega Evolves when it can, and never switches or uses a status move by
 * choice. It reads the true battle, so it knows both full teams. */
export function greedyCommand(battle: Battle, pid: Pid, rng: Rng, epsilon = 0): string {
  const side = battle.getSide(pid);
  const request = side.activeRequest;
  if (!request || request.wait) return "";
  const candidates = () => battleActionCandidates(battle, pid);
  const pick = (commands: string[]) => commands[Math.floor(rng() * commands.length)] ?? "default";
  if (request.forceSwitch || request.teamPreview || (epsilon > 0 && rng() < epsilon))
    return pick(candidates());
  const scratch = cloneBattle(battle);
  const parts: string[] = [];
  let mega = false;
  for (const [slot, active] of request.active.entries()) {
    const attacker = scratch.getSide(pid).active[slot];
    if (!attacker || attacker.fainted) {
      parts.push("pass");
      continue;
    }
    let best: [number, string] = [-1, ""];
    for (const [index, entry] of active.moves.entries()) {
      if (entry.disabled || entry.pp === 0) continue;
      const [score, target] = projectedScore(scratch, attacker, entry.id);
      if (score > best[0]) best = [score, `move ${index + 1}${target}`];
    }
    if (best[0] < 0) return pick(candidates());
    const evolve: boolean = Boolean(active.canMegaEvo) && !mega;
    if (evolve) mega = true;
    parts.push(evolve ? `${best[1]} mega` : best[1]);
  }
  return parts.join(", ");
}

export function winnerOf(battle: Battle): Pid | null {
  if (!battle.ended) return null;
  const winner = battle.sides.find((side) => side.name === battle.winner);
  return winner?.id === "p1" || winner?.id === "p2" ? winner.id : null;
}

export function playOut(battle: Battle, rng: Rng, maxTurns: number, epsilon: number): Pid | null {
  const limit = battle.turn + maxTurns;
  while (!battle.ended && battle.turn < limit) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    for (const pid of pending) {
      if (battle.ended) break;
      if (battle.choose(pid, greedyCommand(battle, pid, rng, epsilon))) continue;
      const fallback = acceptedBattleActionEntries(battle, pid);
      const entry = fallback[Math.floor(rng() * fallback.length)];
      if (!battle.choose(pid, entry?.command ?? "default")) battle.choose(pid, "default");
    }
  }
  return winnerOf(battle);
}
