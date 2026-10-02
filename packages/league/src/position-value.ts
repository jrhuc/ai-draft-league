import readline from "node:readline";

import type { Battle } from "pokemon-showdown";
import { z } from "zod";

import {
  acceptedBattleActionEntries,
  type GameSource,
  openPosition,
  pendingSides,
  type Position,
  replayGame,
} from "./fork.js";
import { greedyCommand, opposing, playOut } from "./playout.js";
import { seededRng } from "./random.js";
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

function hiddenOpponents(battle: Battle, focal: Pid): number {
  return battle
    .getSide(opposing(focal))
    .pokemon.filter((mon) => !mon.fainted && !mon.isActive && mon.previouslySwitchedIn === 0)
    .length;
}

/** Win rate of every accepted focal action at a simultaneous turn decision, conditional on the
 * greedy continuation. The simulator sees both full teams, so `hidden_opponents` reports how much
 * of that the focal player could not. Forced switches and team preview are not valued. */
export function valuePosition(
  position: Position,
  focal: Pid,
  settings: ValueSettings = DEFAULT_VALUE_SETTINGS,
  psDir?: string,
  commands?: readonly string[],
): PositionValue | null {
  const other = opposing(focal);
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
    const winner = playOut(
      battle,
      seededRng(`rollout:${settings.salt}:${position.index}:${sample}:${epsilon}`),
      settings.maxTurns,
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
          `${JSON.stringify({ kind: "position", id: game.id, index: position.index, choice_index: choiceIndex, opponent_choice_index: position.choiceIndex[opposing(pid)] ?? null, ...value })}\n`,
        );
      }
    }
  }
}
