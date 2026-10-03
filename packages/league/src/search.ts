import { setImmediate as yieldTurn } from "node:timers/promises";

import type { Battle } from "pokemon-showdown";

import { battleActionCandidates, cloneBattle, forkPoint, pendingSides } from "./fork.js";
import { opposing } from "./playout.js";
import { type Rng, shuffle } from "./random.js";
import { rollOut, rolloutCommand } from "./rollout.js";
import type { Pid } from "./types.js";

export interface SearchSettings {
  shortlistPerSide: number;
  rolloutsPerCell: number;
  maxTurns: number;
}

export const SEARCH_LEVELS = {
  fast: { shortlistPerSide: 3, rolloutsPerCell: 2, maxTurns: 40 },
  standard: { shortlistPerSide: 5, rolloutsPerCell: 3, maxTurns: 40 },
  deep: { shortlistPerSide: 7, rolloutsPerCell: 6, maxTurns: 40 },
} satisfies Record<string, SearchSettings>;

export type SearchLevel = keyof typeof SEARCH_LEVELS;

export interface SearchResult {
  command: string;
  value: number;
  candidates: number;
  rollouts: number;
}

function combinations(items: readonly number[], size: number): number[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) =>
    combinations(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]),
  );
}

/** Lead order and back order do not change a doubles game, so one lineup stands for each set. */
function lineups(teamSize: number, bring: number): string[] {
  const slots = Array.from({ length: teamSize }, (_, index) => index + 1);
  return combinations(slots, Math.min(2, bring)).flatMap((leads) =>
    combinations(
      slots.filter((slot) => !leads.includes(slot)),
      bring - leads.length,
    ).map((back) => `team ${[...leads, ...back].join("")}`),
  );
}

function plausibleTurnCommands(battle: Battle, pid: Pid): string[] {
  const request = battle.getSide(pid).activeRequest;
  if (!request || request.wait || request.forceSwitch || request.teamPreview) return [];
  const foes = battle.getSide(opposing(pid)).active;
  const standing = foes.map((foe) => Boolean(foe && !foe.fainted));
  return battleActionCandidates(battle, pid).filter((command) => {
    let megaOffered = false;
    let megaTaken = false;
    for (const [slot, part] of command.split(", ").entries()) {
      const match = /^move (\d+)(?: ([+-])(\d))?( mega)?$/.exec(part);
      if (!match) continue;
      const active = request.active[slot];
      if (active?.canMegaEvo) megaOffered = true;
      if (match[4]) megaTaken = true;
      const id = active?.moves[Number(match[1]) - 1]?.id;
      if (match[2] === "-" && id && battle.dex.moves.get(id).category !== "Status") return false;
      if (match[2] === "+" && !standing[Number(match[3]) - 1] && standing.some(Boolean))
        return false;
    }
    return !megaOffered || megaTaken;
  });
}

function candidateCommands(battle: Battle, pid: Pid): string[] {
  const request = battle.getSide(pid).activeRequest;
  if (!request || request.wait) return [];
  if (request.teamPreview)
    return lineups(request.side.pokemon.length, request.maxChosenTeamSize ?? 4);
  return request.forceSwitch
    ? battleActionCandidates(battle, pid)
    : plausibleTurnCommands(battle, pid);
}

/** Rows maximise the payoff and columns minimise it; the result is the row player's strategy. */
export function solveZeroSum(payoff: readonly (readonly number[])[], iterations = 3000): number[] {
  const rows = payoff.length;
  const columns = payoff[0]?.length ?? 0;
  if (rows === 0 || columns === 0) return [];
  const zeros = (length: number) => Array.from({ length }, () => 0);
  const rowRegret = zeros(rows);
  const columnRegret = zeros(columns);
  const total = zeros(rows);
  const strategy = (regrets: number[]) => {
    const sum = regrets.reduce((a, b) => a + b, 0);
    return regrets.map((value) => (sum > 0 ? value / sum : 1 / regrets.length));
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const row = strategy(rowRegret);
    const column = strategy(columnRegret);
    const rowValues = payoff.map((cells) =>
      cells.reduce((sum, cell, j) => sum + cell * column[j]!, 0),
    );
    const columnValues = column.map((_, j) =>
      payoff.reduce((sum, cells, i) => sum + cells[j]! * row[i]!, 0),
    );
    const value = rowValues.reduce((sum, cell, i) => sum + cell * row[i]!, 0);
    for (const [i, weight] of row.entries()) {
      rowRegret[i] = Math.max(0, rowRegret[i]! + rowValues[i]! - value);
      total[i]! += weight;
    }
    for (const j of column.keys())
      columnRegret[j] = Math.max(0, columnRegret[j]! + value - columnValues[j]!);
  }
  return total.map((weight) => weight / iterations);
}

function remaining(battle: Battle, pid: Pid): number {
  const team = battle.getSide(pid).pokemon;
  return team.reduce((sum, mon) => sum + mon.hp / mon.maxhp, 0) / Math.max(1, team.length);
}

/** The two sides' payoffs must sum to 1: the matrix solve treats the game as zero-sum. */
function payoff(battle: Battle, pid: Pid, winner: Pid | null): number {
  const other = opposing(pid);
  if (winner === null) return 0.5 + (remaining(battle, pid) - remaining(battle, other)) / 2;
  return winner === pid ? 0.5 + remaining(battle, pid) / 2 : 0.5 - remaining(battle, other) / 2;
}

const MIXING_FLOOR = 0.15;

/** Reads the true battle, so it knows both full teams, but never a choice the other side has
 * already committed for this decision. Yields after every rollout so a search never holds up the
 * other seats sharing its process. */
export async function searchAction(
  battle: Battle,
  pid: Pid,
  settings: SearchSettings,
  rng: Rng,
): Promise<SearchResult> {
  const other = opposing(pid);
  const root = cloneBattle(battle);
  for (const side of root.sides) side.clearChoice();
  const fork = forkPoint(root);
  const contested = pendingSides(root).includes(other);
  const part = () => 1 + Math.floor(rng() * 0xffff);
  const seeds = Array.from(
    { length: settings.rolloutsPerCell },
    () => `${part()},${part()},${part()},${part()}` as const,
  );
  const illegal = { [pid]: new Set<string>(), [other]: new Set<string>() };
  const cache = new Map<string, number | null>();
  let rollouts = 0;

  const evaluate = async (own: string, reply: string | null, sample: number) => {
    if (illegal[pid]!.has(own) || (reply !== null && illegal[other]!.has(reply))) return null;
    const key = `${sample}\n${own}\n${reply ?? ""}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const scratch = fork();
    scratch.resetRNG(seeds[sample]);
    let value: number | null = null;
    if (!scratch.choose(pid, own)) illegal[pid]!.add(own);
    else if (reply !== null && !scratch.choose(other, reply)) illegal[other]!.add(reply);
    else {
      rollouts += 1;
      const winner = rollOut(scratch, settings.maxTurns);
      value = payoff(scratch, pid, winner);
      await yieldTurn();
    }
    cache.set(key, value);
    return value;
  };
  const mean = async (cells: Array<[string, string | null, number]>) => {
    const played: number[] = [];
    for (const [own, reply, sample] of cells) {
      const value = await evaluate(own, reply, sample);
      if (value !== null) played.push(value);
    }
    return played.length ? played.reduce((sum, value) => sum + value, 0) / played.length : null;
  };

  const accepted = (side: Pid, command: string) => fork().getSide(side).choose(command);
  const references = (side: Pid, commands: string[]): string[] => {
    const request = root.getSide(side).activeRequest;
    if (request && !request.teamPreview && !request.forceSwitch) {
      const reference = rolloutCommand(root, side);
      if (accepted(side, reference)) return [reference];
    }
    const probes: string[] = [];
    for (const command of shuffle(commands, rng)) {
      if (probes.length === settings.rolloutsPerCell) break;
      if (accepted(side, command)) probes.push(command);
    }
    return probes;
  };
  const shortlist = async (
    commands: string[],
    probes: string[],
    score: (command: string) => Promise<number | null>,
    direction: 1 | -1,
  ) => {
    const ranked: Array<[string, number]> = [];
    for (const command of commands) {
      const value = await score(command);
      if (value !== null) ranked.push([command, value]);
    }
    ranked.sort((a, b) => direction * (b[1] - a[1]));
    const kept = ranked.slice(0, settings.shortlistPerSide).map(([command]) => command);
    for (const probe of probes)
      if (!kept.includes(probe) && ranked.some(([command]) => command === probe)) kept.push(probe);
    return kept;
  };

  const ownCommands = candidateCommands(root, pid);
  const replyCommands = contested ? candidateCommands(root, other) : [];
  const ownProbes = references(pid, ownCommands);
  const replyProbes: Array<string | null> = contested ? references(other, replyCommands) : [null];

  const own = await shortlist(
    ownCommands,
    ownProbes,
    (command) => mean(replyProbes.map((reply, sample) => [command, reply, sample])),
    1,
  );
  const replies: Array<string | null> = contested
    ? await shortlist(
        replyCommands,
        replyProbes.flatMap((reply) => (reply === null ? [] : [reply])),
        (reply) => mean(ownProbes.map((command, sample) => [command, reply, sample])),
        -1,
      )
    : [null];
  if (!own.length) throw new Error(`${pid} has no playable action to search`);

  const samples = Array.from({ length: settings.rolloutsPerCell }, (_, sample) => sample);
  const matrix: number[][] = [];
  for (const command of own) {
    const row: number[] = [];
    for (const reply of replies)
      row.push((await mean(samples.map((sample) => [command, reply, sample]))) ?? 0.5);
    matrix.push(row);
  }
  const strategy = solveZeroSum(matrix);
  const weights = strategy.map((weight) => (weight >= MIXING_FLOOR ? weight : 0));
  const mass = weights.reduce((sum, weight) => sum + weight, 0);
  let draw = rng() * mass;
  let chosen = strategy.indexOf(Math.max(...strategy));
  if (mass > 0)
    for (const [index, weight] of weights.entries()) {
      if (weight === 0) continue;
      chosen = index;
      draw -= weight;
      if (draw < 0) break;
    }
  return {
    command: own[chosen]!,
    value: Math.min(...matrix[chosen]!),
    candidates: ownCommands.length,
    rollouts,
  };
}
