import readline from "node:readline";

import type { Battle, Pokemon } from "pokemon-showdown";
import { z } from "zod";

import {
  acceptedBattleActionEntries,
  battleActionCandidates,
  cloneBattle,
  type GameSource,
  openPosition,
  pendingSides,
  type Position,
  replayGame,
} from "./fork.js";
import { type Rng, seededRng } from "./random.js";
import type { Pid } from "./types.js";

export interface ValueSettings {
  samples: number;
  epsilon: number;
  maxTurns: number;
  /** Distinct salts give independent dice, so one pass can choose an action and another value it. */
  salt: number;
}

export const DEFAULT_VALUE_SETTINGS: ValueSettings = {
  samples: 12,
  epsilon: 0.25,
  maxTurns: 40,
  salt: 1,
};

export interface ReplyValue {
  reply: string;
  source: "greedy" | "recorded";
  greedy: number;
  explored: number;
}

export interface ActionValue {
  command: string;
  label: string;
  value: number;
  explored: number;
  replies: ReplyValue[];
}

export interface PositionValue {
  focal: Pid;
  turn: number;
  greedy: string;
  recorded: string | null;
  hidden_opponents: number;
  rollouts: number;
  unfinished: number;
  settings: ValueSettings;
  actions: ActionValue[];
}

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

function opponent(pid: Pid): Pid {
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

/** The continuation policy every value is conditional on: each active Pokémon uses its highest
 * projected damage, Mega Evolves when it can, and never switches or uses a status move by choice. */
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

function rollout(battle: Battle, rng: Rng, settings: ValueSettings, epsilon: number): Pid | null {
  const limit = battle.turn + settings.maxTurns;
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
  if (!battle.ended) return null;
  const winner = battle.sides.find((side) => side.name === battle.winner);
  return winner?.id === "p1" || winner?.id === "p2" ? winner.id : null;
}

function hiddenOpponents(battle: Battle, focal: Pid): number {
  return battle
    .getSide(opponent(focal))
    .pokemon.filter((mon) => !mon.fainted && !mon.isActive && mon.previouslySwitchedIn === 0)
    .length;
}

/** Win rate of every accepted focal action at a simultaneous turn decision, conditional on the
 * stated continuation policy. The simulator sees both full teams, so `hidden_opponents` reports how
 * much of that the focal player could not. Forced switches and team preview are not valued. */
export function valuePosition(
  position: Position,
  focal: Pid,
  settings: ValueSettings = DEFAULT_VALUE_SETTINGS,
  psDir?: string,
  commands?: readonly string[],
): PositionValue | null {
  const other = opponent(focal);
  const root = openPosition(position, psDir);
  const request = root.getSide(focal).activeRequest;
  if (!request || request.wait || request.forceSwitch || request.teamPreview) return null;
  if (!pendingSides(root).includes(other)) return null;
  if (root.getSide(other).activeRequest?.forceSwitch) return null;

  const policyRng = () => seededRng(`policy:${position.index}`);
  const recorded = position.actual[other];
  const greedyReply = greedyCommand(root, other, policyRng());
  const replies: Array<[string, ReplyValue["source"]]> = [[greedyReply, "greedy"]];
  if (recorded && recorded !== greedyReply) replies.push([recorded, "recorded"]);

  let rollouts = 0;
  let unfinished = 0;
  const play = (command: string, reply: string, sample: number, epsilon: number): number | null => {
    const battle = openPosition(position, psDir);
    battle.resetRNG(`${sample + 1},${position.index + 1},${settings.salt},${epsilon > 0 ? 2 : 1}`);
    if (!battle.choose(focal, command) || !battle.choose(other, reply)) return null;
    rollouts += 1;
    const winner = rollout(
      battle,
      seededRng(`rollout:${settings.salt}:${position.index}:${sample}:${epsilon}`),
      settings,
      epsilon,
    );
    if (winner === null) unfinished += 1;
    return winner === null ? 0.5 : winner === focal ? 1 : 0;
  };
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;

  const actions: ActionValue[] = [];
  for (const entry of acceptedBattleActionEntries(root, focal)) {
    if (commands && !commands.includes(entry.command)) continue;
    const perReply: ReplyValue[] = [];
    for (const [reply, source] of replies) {
      const greedy: number[] = [];
      const explored: number[] = [];
      for (let sample = 0; sample < settings.samples; sample++) {
        const plain = play(entry.command, reply, sample, 0);
        if (plain !== null) greedy.push(plain);
        const noisy = play(entry.command, reply, sample, settings.epsilon);
        if (noisy !== null) explored.push(noisy);
      }
      if (greedy.length)
        perReply.push({ reply, source, greedy: mean(greedy), explored: mean(explored) });
    }
    if (!perReply.length) continue;
    actions.push({
      command: entry.command,
      label: entry.label,
      value: mean(perReply.map((reply) => reply.greedy)),
      explored: mean(perReply.map((reply) => reply.explored)),
      replies: perReply,
    });
  }
  return {
    focal,
    turn: position.turn,
    greedy: greedyCommand(root, focal, policyRng()),
    recorded: position.actual[focal] ?? null,
    hidden_opponents: hiddenOpponents(root, focal),
    rollouts,
    unfinished,
    settings,
    actions,
  };
}

const seedSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const sidesOf = <T extends z.ZodType>(value: T) => z.object({ p1: value, p2: value });
const gameSchema = z.object({
  id: z.string(),
  source: z.object({
    format: z.string(),
    seed: seedSchema,
    names: sidesOf(z.string()),
    packed: sidesOf(z.string()),
    choices: sidesOf(z.array(z.string())),
  }),
  log: z.array(z.string()),
  settings: z
    .object({
      samples: z.int().min(1),
      epsilon: z.number().min(0).max(1),
      maxTurns: z.int().min(1),
      salt: z.int().min(0).max(65535),
    })
    .partial()
    .optional(),
  only: z
    .array(
      z.object({
        pid: z.enum(["p1", "p2"]),
        choice_index: z.int().min(0),
        commands: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/** One recorded game per input line. A game whose replay does not reproduce its recorded log is
 * reported unverified and none of its positions are valued. */
export async function servePositions(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  psDir?: string,
): Promise<void> {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const game = gameSchema.parse(JSON.parse(line));
    const source: GameSource = game.source;
    if (psDir) source.psDir = psDir;
    const replay = replayGame(source, game.log);
    output.write(
      `${JSON.stringify({ kind: "game", id: game.id, verified: replay.verified, winner: replay.winner, turns: replay.turns })}\n`,
    );
    if (!replay.verified) continue;
    const settings = { ...DEFAULT_VALUE_SETTINGS, ...game.settings };
    for (const position of replay.positions) {
      for (const pid of position.pending) {
        const choiceIndex = position.choiceIndex[pid];
        if (choiceIndex === undefined) continue;
        const wanted = game.only?.find((o) => o.pid === pid && o.choice_index === choiceIndex);
        if (game.only && !wanted) continue;
        const value = valuePosition(position, pid, settings, psDir, wanted?.commands);
        if (!value) continue;
        output.write(
          `${JSON.stringify({ kind: "position", id: game.id, index: position.index, choice_index: choiceIndex, opponent_choice_index: position.choiceIndex[pid === "p1" ? "p2" : "p1"] ?? null, ...value })}\n`,
        );
      }
    }
  }
}
