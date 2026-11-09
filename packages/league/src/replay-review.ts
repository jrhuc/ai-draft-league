import type { Battle } from "pokemon-showdown";
import { z } from "zod";

import { ACTION_ORDER_TOOL } from "./llm-engine-support.js";
import { defaultPsDir } from "./paths.js";
import { PerspectiveState } from "./perspective-state.js";
import { ShowdownReference } from "./reference.js";
import { TurnFork } from "./replay-fork.js";
import { playerSide, type ReplayGame } from "./replay-log.js";
import { ReplaySimulator, type ReplaySimulation } from "./replay-sim.js";
import { loadShowdown } from "./showdown.js";
import { stateKey } from "./state-model.js";
import { estimateDamage } from "./state-tools.js";
import { packTeam } from "./teams.js";
import type { Pid } from "./types.js";

export const replayCallSchema = z.object({
  turn: z.int().min(0),
  tool: z.string(),
  args: z.record(z.string(), z.json()).default({}),
});
export type ReplayCall = z.infer<typeof replayCallSchema>;

export const replayForkSchema = z.object({
  turn: z.int().min(1),
  do: z.enum(["options", "play", "table"]),
  you: z.string().optional(),
  they: z.string().optional(),
  samples: z.int().min(1).max(2000).default(200),
});
export type ReplayFork = z.infer<typeof replayForkSchema>;

const STAT_ORDER = ["hp", "atk", "def", "spa", "spd", "spe"] as const;

function opponent(pid: Pid): Pid {
  return pid === "p1" ? "p2" : "p1";
}

/** The reviewed player's own team export. A public replay carries neither side's stat points, so
 * this is the only source of exact stats. */
class OwnSheet {
  private readonly battle: Battle;
  private readonly sets = new Map<string, Battle["sides"][number]["pokemon"][number]["set"]>();

  constructor(paste: string, format: string, psDir: string) {
    const { Battle: BattleClass } = loadShowdown(psDir);
    this.battle = new BattleClass({ formatid: format });
    this.battle.setPlayer("p1", { name: "sheet", team: packTeam(paste, psDir, format) });
    for (const pokemon of this.battle.getSide("p1").pokemon)
      this.sets.set(stateKey(pokemon.baseSpecies.baseSpecies), pokemon.set);
  }

  species(): string[] {
    return [...this.sets.keys()].sort();
  }

  teamSets(): Battle["sides"][number]["pokemon"][number]["set"][] {
    return [...this.sets.values()];
  }

  stats(species: string): Record<string, number> | undefined {
    const forme = this.battle.dex.species.get(species);
    const set = this.sets.get(stateKey(forme.baseSpecies));
    return set && forme.exists ? { ...this.battle.spreadModify(forme.baseStats, set) } : undefined;
  }
}

function previewSpecies(game: ReplayGame, pid: Pid, base: (species: string) => string): string[] {
  return game.preview
    .flatMap((line) => {
      const [, kind, side, details] = line.split("|");
      return kind === "poke" && side === pid && details
        ? [base(details.split(",", 1)[0]!.replace(/-\*$/, ""))]
        : [];
    })
    .sort();
}

/** One public replay seen from one player's seat: the state the league's coaches are shown at every
 * decision, and the same calculators run against it. */
export class ReplayReview {
  readonly pov: Pid;
  private readonly reference: ShowdownReference;
  private readonly own: OwnSheet | undefined;
  private readonly brought: Set<string>;
  private readonly base: (species: string) => string;
  private rebuilt: ReplaySimulation | undefined;

  constructor(
    readonly game: ReplayGame,
    options: { as?: string; paste?: string } = {},
    private readonly psDir = defaultPsDir(),
  ) {
    const { Dex } = loadShowdown(psDir);
    if (!Dex.formats.get(game.formatId).exists)
      throw new Error(`the pinned Showdown has no format ${game.formatId}`);
    const dex = Dex.forFormat(game.formatId);
    this.base = (species) => stateKey(dex.species.get(species).baseSpecies || species);
    this.reference = new ShowdownReference(game.formatId, psDir);
    this.own =
      options.paste === undefined ? undefined : new OwnSheet(options.paste, game.formatId, psDir);
    this.pov = this.viewpoint(options.as);
    this.brought = new Set(
      [...game.leads, ...game.turns.flatMap((turn) => turn.lines)].flatMap((line) => {
        const [, kind, ident, details] = line.split("|");
        return (kind === "switch" || kind === "drag" || kind === "replace") &&
          ident?.startsWith(this.pov) &&
          details
          ? [this.base(details.split(",", 1)[0]!)]
          : [];
      }),
    );
  }

  private viewpoint(as: string | undefined): Pid {
    if (as !== undefined) {
      const named = playerSide(this.game, as);
      if (!named)
        throw new Error(
          `${as} did not play ${this.game.id}; the players are ${this.game.players.p1} and ${this.game.players.p2}`,
        );
      return named;
    }
    if (this.own) {
      const wanted = this.own.species().join();
      const matching = (["p1", "p2"] as const).filter(
        (pid) => previewSpecies(this.game, pid, this.base).join() === wanted,
      );
      if (matching.length === 1) return matching[0]!;
      throw new Error(
        matching.length
          ? `both players of ${this.game.id} brought the six Pokémon in the team file; name the player with --as`
          : `neither player of ${this.game.id} brought the six Pokémon in the team file`,
      );
    }
    if (this.game.viewpoint) return this.game.viewpoint;
    throw new Error(
      `whose game is ${this.game.id}? Name the player with --as (${this.game.players.p1} or ${this.game.players.p2}) or pass their team with --team`,
    );
  }

  /** The state at the start of a turn, before either side has chosen; turn 0 is team preview. */
  stateAt(turn: number): PerspectiveState {
    const state = new PerspectiveState(this.pov);
    this.feed(state, this.game.preview);
    if (turn === 0) return state;
    this.feed(state, this.game.leads);
    for (const played of this.game.turns) {
      this.feed(state, [`|turn|${played.turn}`]);
      if (played.turn === turn) return state;
      this.feed(state, played.lines);
    }
    throw new Error(`${this.game.id} has no turn ${turn}`);
  }

  private feed(state: PerspectiveState, lines: readonly string[]): void {
    state.feed(lines);
    const side = state.sides[this.pov];
    const knownBring = this.brought.size === this.game.teamSize[this.pov];
    const megaUsed = [...side.mons.values()].some((mon) => mon.mega);
    const active = new Set(Object.values(side.active));
    for (const [key, mon] of side.mons) {
      if (knownBring) mon.brought = this.brought.has(this.base(mon.species));
      mon.hpPercent ??= 100;
      mon.canMegaEvo =
        active.has(key) &&
        !megaUsed &&
        Boolean(mon.item && !mon.itemConsumed && this.reference.megaSpecies(mon.species, mon.item));
      const stats = this.own?.stats(mon.species);
      if (!stats) {
        mon.hp ??= "100/100";
        continue;
      }
      const { hp: maximum = 0, ...rest } = stats;
      mon.stats = rest;
      const status = mon.hp?.split(" ")[1];
      const current =
        mon.hpPercent === 0 ? 0 : Math.max(1, Math.ceil((mon.hpPercent * maximum) / 100));
      mon.hp = `${current}/${maximum}${status ? ` ${status}` : ""}`;
    }
  }

  private renderState(state: PerspectiveState): string {
    const sides = state.activeMatchupSides(this.reference);
    return [
      state.renderReview((mon) => this.reference.describeCompact(mon)),
      state.renderEffectiveSpeeds(this.reference),
      ...this.reference.renderActiveMatchups(
        [...sides.allies, ...sides.foes],
        [...sides.foes, ...sides.allies],
        state.weather?.name ?? "",
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** The game rebuilt inside the simulator, which every what-if starts from. */
  simulation(): ReplaySimulation {
    this.rebuilt ??= new ReplaySimulator(
      this.game,
      this.own ? { [this.pov]: this.own.teamSets() } : {},
      this.psDir,
    ).run();
    return this.rebuilt;
  }

  private renderSimulation(): string[] {
    let simulation: ReplaySimulation;
    try {
      simulation = this.simulation();
    } catch (error) {
      return [
        `Simulator: cannot rebuild this game (${error instanceof Error ? error.message : String(error)}), so there are no what-ifs.`,
      ];
    }
    const stop = simulation.divergence;
    const { Teams } = loadShowdown(this.psDir);
    const guessed = (["p1", "p2"] as const).filter((pid) => pid !== this.pov || !this.own);
    return [
      stop
        ? `Simulator: follows the log to turn ${stop.turn}, where the log has ${stop.want ?? "nothing"} and the simulator wrote ${stop.got ?? "nothing"}; what-ifs work before that turn.`
        : `Simulator: rebuilt all ${this.game.turns.length} turns line for line; what-ifs work on every turn.`,
      ...guessed.map(
        (pid) =>
          `Assumed stat points for ${pid === this.pov ? "your" : "their"} team (HP/Atk/Def/SpA/SpD/Spe), from nature alone unless noted: ${(
            Teams.unpack(simulation.teams[pid]) ?? []
          )
            .map((set) => `${set.species} ${STAT_ORDER.map((stat) => set.evs[stat]).join("/")}`)
            .join("; ")}.`,
      ),
      ...simulation.notes.map((note) => `Speed read from turn order: ${note}.`),
    ];
  }

  fork(request: ReplayFork): string {
    const simulation = this.simulation();
    const position = simulation.positions.find(
      (candidate) =>
        candidate.turn === request.turn &&
        candidate.pending.includes(this.pov) &&
        !candidate.requests[this.pov].forceSwitch &&
        !candidate.requests[this.pov].teamPreview,
    );
    const stop = simulation.divergence;
    if (!position)
      throw new Error(
        stop && stop.turn <= request.turn
          ? `the simulator follows ${this.game.id} only to turn ${stop.turn}`
          : `${this.game.id} has no decision of yours at the start of turn ${request.turn}`,
      );
    const seen = new Set(
      [...this.game.leads, ...this.game.turns.flatMap((turn) => turn.lines)].flatMap((line) => {
        const entry = /^\|(?:switch|drag|replace)\|(p[12])[ab]: ([^|]+)/.exec(line);
        return entry ? [`${entry[1]}: ${entry[2]}`] : [];
      }),
    );
    const pivots = { p1: new Array<string>(), p2: new Array<string>() };
    for (const later of simulation.positions.slice(position.index + 1)) {
      if (later.turn !== position.turn) break;
      for (const pid of later.pending)
        if (later.requests[pid].forceSwitch) pivots[pid].push(later.actual[pid] ?? "");
    }
    const fork = new TurnFork(position, this.pov, seen, pivots, this.psDir);
    if (request.do === "options") return fork.renderOptions();
    if (request.do === "table") return fork.renderTable();
    return fork.renderPlay(
      request.you ?? fork.played(this.pov),
      request.they ?? fork.played(opponent(this.pov)),
      request.samples,
    );
  }

  render(): string {
    const { game, pov } = this;
    const foe = opponent(pov);
    const seat = (pid: Pid) =>
      `${pid} (${game.players[pid]}${game.ratings[pid] === null ? "" : `, rated ${game.ratings[pid]}`})`;
    const series = game.series
      ? `, game ${game.series.game} of a best-of-${game.series.bestOf}`
      : "";
    const result =
      game.winner === null ? "no winner recorded" : game.winner === pov ? "you won" : "you lost";
    const state = new PerspectiveState(pov);
    this.feed(state, game.preview);
    const out = [
      `# ${game.tier}${series}: ${game.id}`,
      `You are ${seat(pov)}; the opponent is ${seat(foe)}. Result: ${result} after ${game.turns.length} turns.`,
      this.own
        ? "Your stats are exact, from your team file. The opponent's stat points are hidden, so their stats are ranges under the nature on their sheet."
        : "Neither side's stat points are known, so every stat is a range under the nature on the sheet.",
      ...this.renderSimulation(),
      "",
      "## Team preview",
      this.renderState(state),
      "",
      "## Leads",
      ...game.leads,
    ];
    this.feed(state, game.leads);
    for (const turn of game.turns) {
      this.feed(state, [`|turn|${turn.turn}`]);
      out.push(
        "",
        `## Turn ${turn.turn}`,
        "State at the decision:",
        this.renderState(state),
        "",
        "What happened:",
        ...turn.lines,
      );
      this.feed(state, turn.lines);
    }
    return out.join("\n");
  }

  call(call: ReplayCall): string {
    const state = this.stateAt(call.turn);
    if (call.tool === "estimate_damage") return estimateDamage(state, call.args, this.reference);
    if (call.tool === ACTION_ORDER_TOOL.name)
      return state.compareActionOrder(call.args, this.reference);
    return this.reference.lookup(call.tool, call.args);
  }
}
