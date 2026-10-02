import type { Battle } from "pokemon-showdown";

import { BaseEngine, type DecisionLog, type GameStart, RandomEngine } from "./battle-agent.js";
import type { SlotMenu } from "./choices.js";
import { acceptedBattleActionEntries, cloneBattle, requestActionCandidateEntries } from "./fork.js";
import { greedyCommand } from "./playout.js";
import { type Rng, seededRng } from "./random.js";
import { SEARCH_LEVELS, searchAction, type SearchSettings } from "./search.js";
import type { BattleRequest, Pid, SubmissionSource } from "./types.js";

abstract class SimulatorEngine extends BaseEngine {
  protected random: Rng;
  private live: (() => Battle | null) | undefined;

  constructor(
    pid: Pid,
    private readonly seed: string | number,
    decisionLog?: DecisionLog,
  ) {
    super(pid, decisionLog);
    this.random = seededRng(seed);
  }

  override beginGame(context: GameStart): void {
    super.beginGame(context);
    this.random = seededRng(`${this.seed}:game:${context.gameNumber}`);
  }

  attachSimulator(battle: () => Battle | null): void {
    this.live = battle;
  }

  protected override submissionSource(automatic: boolean): SubmissionSource {
    return automatic ? "automatic" : "policy";
  }

  protected decideJoint(_menus: SlotMenu[], request: BattleRequest): number[] {
    const battle = this.live?.();
    if (!battle) throw new Error(`${this.pid} plays from the live simulator and has none attached`);
    const command = this.command(battle);
    const entry = requestActionCandidateEntries(request).find(
      (candidate) => candidate.command === command,
    );
    if (!entry) throw new Error(`${this.pid} chose "${command}", which its request does not offer`);
    return entry.choices;
  }

  protected abstract command(battle: Battle): string;
}

export class GreedyEngine extends SimulatorEngine {
  protected command(battle: Battle): string {
    const command = greedyCommand(battle, this.pid, this.random);
    if (cloneBattle(battle).getSide(this.pid).choose(command)) return command;
    const accepted = acceptedBattleActionEntries(battle, this.pid);
    return accepted[Math.floor(this.random() * accepted.length)]?.command ?? command;
  }
}

export class SearchEngine extends SimulatorEngine {
  constructor(
    pid: Pid,
    seed: string | number,
    private readonly settings: SearchSettings = SEARCH_LEVELS.standard,
    decisionLog?: DecisionLog,
  ) {
    super(pid, seed, decisionLog);
  }

  protected command(battle: Battle): string {
    return searchAction(battle, this.pid, this.settings, this.random).command;
  }
}

type PolicyFactory = (pid: Pid, seed: string | number, decisionLog?: DecisionLog) => BaseEngine;

const POLICIES = new Map<string, PolicyFactory>([
  ["random", (pid, seed, log) => new RandomEngine(pid, seed, log)],
  ["greedy", (pid, seed, log) => new GreedyEngine(pid, seed, log)],
  ["search", (pid, seed, log) => new SearchEngine(pid, seed, SEARCH_LEVELS.standard, log)],
  ...Object.entries(SEARCH_LEVELS).map(([level, settings]): [string, PolicyFactory] => [
    `search:${level}`,
    (pid, seed, log) => new SearchEngine(pid, seed, settings, log),
  ]),
]);

export const POLICY_SPECS: readonly string[] = [...POLICIES.keys()];

export function policyEngine(
  spec: string,
  pid: Pid,
  seed: string | number,
  decisionLog?: DecisionLog,
): BaseEngine | undefined {
  return POLICIES.get(spec)?.(pid, seed, decisionLog);
}
