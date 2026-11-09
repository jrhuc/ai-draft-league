import type { Battle } from "pokemon-showdown";

import { buildMenus, type TargetNames } from "./choices.js";
import { acceptedLegalActionEntries, openPosition, pendingSides } from "./fork.js";
import { defaultPsDir } from "./paths.js";
import { isBattleLine } from "./replay-log.js";
import { type ReplayPosition, rigDice, usualOutcome } from "./replay-sim.js";
import type { BattleRequest, Pid } from "./types.js";

export interface TurnOption {
  command: string;
  label: string;
}

interface MonAfter {
  name: string;
  hp: number;
  fainted: boolean;
}

interface PlayedTurn {
  lines: string[];
  mons: MonAfter[];
  material: Record<Pid, number>;
}

const SEATS = ["p1", "p2"] as const;
const TABLE_ROWS = 12;
const TABLE_REPLIES = 5;

function opponent(pid: Pid): Pid {
  return pid === "p1" ? "p2" : "p1";
}

function fielded(request: BattleRequest): string[] {
  return (request.side?.pokemon ?? [])
    .filter((pokemon) => pokemon.active)
    .map((pokemon) => (pokemon.details ?? "").split(",", 1)[0]!);
}

/** One turn of a rebuilt game, opened for alternatives: what each side could have chosen, and what
 * the simulator makes of any pair of choices. */
export class TurnFork {
  private readonly battle: Battle;

  constructor(
    private readonly position: ReplayPosition,
    private readonly pov: Pid,
    /** Pokémon the recorded game showed; an unseen one on the bench is a guess at the bring. */
    private readonly seen: ReadonlySet<string>,
    /** The switches each side made in the recorded turn after a pivot, tried before any other. */
    private readonly pivots: Record<Pid, string[]> = { p1: [], p2: [] },
    private readonly psDir = defaultPsDir(),
  ) {
    this.battle = openPosition(position, psDir);
  }

  private names(pid: Pid): TargetNames {
    const numbered = (species: string[]) => ({ 1: species[0] ?? "", 2: species[1] ?? "" });
    return {
      ally: numbered(fielded(this.position.requests[pid])),
      foe: numbered(fielded(this.position.requests[opponent(pid)])),
    };
  }

  /** Every joint choice the simulator accepts for a side, without attacks aimed at an ally and
   * without switches to a Pokémon the recorded game never showed. */
  options(pid: Pid): TurnOption[] {
    const request = this.position.requests[pid];
    const team = request.side?.pokemon ?? [];
    const menus = buildMenus(request, { names: this.names(pid) }).map((menu, slot) =>
      menu.filter((item) => {
        if (item.kind === "forfeit") return false;
        if (item.kind === "switch")
          return this.seen.has(team[Number(item.part.slice(7)) - 1]?.ident ?? "");
        const move = /^move (\d+) -\d/.exec(item.part);
        const id = move ? request.active?.[slot]?.moves[Number(move[1]) - 1]?.id : undefined;
        return !id || this.battle.dex.moves.get(id).category === "Status";
      }),
    );
    let joint: Array<{ parts: string[]; labels: string[] }> = [{ parts: [], labels: [] }];
    for (const menu of menus)
      joint = joint.flatMap(({ parts, labels }) =>
        menu.map((item) => ({ parts: [...parts, item.part], labels: [...labels, item.label] })),
      );
    const actors = fielded(request);
    return acceptedLegalActionEntries(
      this.battle,
      pid,
      joint.map(({ parts, labels }) => ({
        number: -1,
        choices: [],
        command: parts.join(", "),
        label: labels.map((label, slot) => `${actors[slot] ?? "slot"}: ${label}`).join("; "),
      })),
    ).map(({ command, label }) => ({ command, label }));
  }

  /** What was played in the recorded game, as far as the log shows it. */
  played(pid: Pid): string {
    return this.position.actual[pid] ?? "";
  }

  label(pid: Pid, command: string): string {
    const request = this.position.requests[pid];
    const menus = buildMenus(request, { names: this.names(pid) });
    const actors = fielded(request);
    return command
      .split(", ")
      .map((part, slot) => {
        const item = menus[slot]?.find((candidate) => candidate.part === part);
        return `${actors[slot] ?? "slot"}: ${item?.label ?? part}`;
      })
      .join("; ");
  }

  private material(battle: Battle, pid: Pid): number {
    return battle
      .getSide(pid)
      .pokemon.reduce((sum, mon) => sum + (mon.fainted ? 0 : 1 + mon.hp / mon.maxhp), 0);
  }

  /** Plays the turn to its end. `sample` rolls real dice; without one every outcome is the usual
   * one, so the same pair of choices always gives the same turn. */
  play(commands: Record<Pid, string>, sample?: number): PlayedTurn {
    const battle = openPosition(this.position, this.psDir);
    if (sample === undefined) rigDice(battle, usualOutcome);
    else battle.resetRNG(`${sample + 1},${this.position.index + 1},29,31`);
    const from = battle.log.length;
    for (const pid of pendingSides(battle)) {
      if (battle.choose(pid, commands[pid])) continue;
      throw new Error(`${pid} cannot play "${commands[pid]}": ${battle.getSide(pid).choice.error}`);
    }
    const written = () => battle.log.slice(from);
    const pivots = { p1: [...this.pivots.p1], p2: [...this.pivots.p2] };
    while (!battle.ended && battle.requestState === "switch" && !written().includes("|upkeep")) {
      for (const pid of pendingSides(battle)) {
        const recorded = pivots[pid].shift();
        if (!recorded || !battle.choose(pid, recorded)) battle.choose(pid, "default");
      }
    }
    const lines: string[] = [];
    const raw = written();
    for (let index = 0; index < raw.length; index += 1) {
      const split = raw[index]!.startsWith("|split|");
      const line = split ? (raw[index + 2] ?? "") : raw[index]!;
      if (split) index += 2;
      if (isBattleLine(line)) lines.push(line);
    }
    return {
      lines,
      mons: SEATS.flatMap((pid) =>
        battle.getSide(pid).pokemon.map((mon) => ({
          name: `${pid === this.pov ? "your" : "their"} ${mon.species.name}`,
          hp: (100 * mon.hp) / mon.maxhp,
          fainted: mon.fainted,
        })),
      ),
      material: { p1: this.material(battle, "p1"), p2: this.material(battle, "p2") },
    };
  }

  private swing(played: PlayedTurn): number {
    const foe = opponent(this.pov);
    const before = this.material(this.battle, this.pov) - this.material(this.battle, foe);
    return played.material[this.pov] - played.material[foe] - before;
  }

  private commands(mine: string, theirs: string): Record<Pid, string> {
    return this.pov === "p1" ? { p1: mine, p2: theirs } : { p1: theirs, p2: mine };
  }

  renderOptions(): string {
    const foe = opponent(this.pov);
    const side = (pid: Pid, title: string) => [
      `${title} (played: ${this.played(pid)})`,
      ...this.options(pid).map((option) => `  ${option.command.padEnd(28)} ${option.label}`),
    ];
    return [...side(this.pov, "Your options"), ...side(foe, "Their options")].join("\n");
  }

  /** One pair of choices over many dice: how often each Pokémon is knocked out, where its HP
   * lands, and the turn as it goes when nothing unusual happens. */
  renderPlay(mine: string, theirs: string, samples: number): string {
    const foe = opponent(this.pov);
    const commands = this.commands(mine, theirs);
    const turns = Array.from({ length: samples }, (_, sample) => this.play(commands, sample));
    const usual = this.play(commands);
    const down = SEATS.flatMap((pid) => this.battle.getSide(pid).pokemon.map((mon) => mon.fainted));
    const outcomes = new Map<string, number>();
    for (const turn of turns) {
      const fallen = turn.mons.filter((mon, index) => mon.fainted && !down[index]);
      const key = fallen.length
        ? `${fallen.map((mon) => mon.name).join(" and ")} knocked out`
        : "no knockout";
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
    const share = (count: number) => `${Math.round((100 * count) / samples)}%`;
    const lines = [
      `You: ${this.label(this.pov, mine)}${mine === this.played(this.pov) ? " (as played)" : ""}`,
      `They: ${this.label(foe, theirs)}${theirs === this.played(foe) ? " (as played)" : ""}`,
      `Over ${samples} rolls of the dice: ${[...outcomes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key} ${share(count)}`)
        .join("; ")}.`,
      "HP after the turn across those rolls:",
    ];
    for (const [index, mon] of usual.mons.entries()) {
      if (down[index]) continue;
      const alive = turns
        .map((turn) => turn.mons[index]!)
        .filter((after) => !after.fainted)
        .map((after) => Math.round(after.hp))
        .sort((a, b) => a - b);
      const low = alive[0];
      const high = alive.at(-1);
      const range = low === undefined ? "" : low === high ? `${low}%` : `${low}-${high}%`;
      const out = samples - alive.length;
      lines.push(
        `  ${mon.name}: ${[range, out ? `knocked out ${share(out)}` : ""].filter(Boolean).join(", ")}`,
      );
    }
    lines.push(
      `The turn with every roll at its usual value (swing ${this.swing(usual).toFixed(2)}):`,
      ...usual.lines.map((line) => `  ${line}`),
    );
    return lines.join("\n");
  }

  /** Every choice of yours against every reply of theirs, each played once with the usual dice.
   * A choice is ranked by its worst reply: the line that loses the least to their best answer. */
  renderTable(): string {
    const foe = opponent(this.pov);
    const mine = this.options(this.pov);
    const theirs = this.options(foe);
    const replied = theirs.findIndex((option) => option.command === this.played(foe));
    const rows = mine.map((option) => {
      const swings = theirs.map((reply) =>
        this.swing(this.play(this.commands(option.command, reply.command))),
      );
      const worst = swings.indexOf(Math.min(...swings));
      return {
        option,
        swings,
        worst,
        mean: swings.reduce((sum, value) => sum + value, 0) / (swings.length || 1),
      };
    });
    rows.sort((a, b) => a.swings[a.worst]! - b.swings[b.worst]!).reverse();
    const signed = (value: number | undefined) =>
      value === undefined ? "    ?" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`.padStart(5);
    const line = (row: (typeof rows)[number], rank: number) =>
      `${String(rank + 1).padStart(3)}. worst ${signed(row.swings[row.worst])}  average ${signed(row.mean)}  against what they played ${signed(row.swings[replied])}  ${row.option.label}${
        row.option.command === this.played(this.pov) ? "  <- played" : ""
      }\n       worst reply: ${theirs[row.worst]?.label ?? "none"}`;
    const playedRank = rows.findIndex((row) => row.option.command === this.played(this.pov));
    const shown = rows.slice(0, TABLE_ROWS).map(line);
    if (playedRank >= TABLE_ROWS) shown.push(line(rows[playedRank]!, playedRank));
    const out = [
      `${mine.length} choices of yours against ${theirs.length} replies, each played once with every roll at its usual value: likelier side of each chance, middling damage, no added effects.`,
      "Swing is material gained less material lost over the turn, in Pokémon: a knockout is 1 plus the HP it removed. Unrevealed bench Pokémon are not offered as switches for either side.",
      "",
      "Your choices by the worst reply to each:",
      ...shown,
    ];
    const played = rows[playedRank];
    if (played) {
      const order = played.swings
        .map((_, index) => index)
        .sort((a, b) => played.swings[a]! - played.swings[b]!);
      out.push(
        "",
        "Their replies that hurt what you played the most:",
        ...order
          .slice(0, TABLE_REPLIES)
          .map((index) => `  ${signed(played.swings[index])}  ${theirs[index]!.label}`),
      );
    }
    if (replied >= 0) {
      const best = [...rows].sort((a, b) => b.swings[replied]! - a.swings[replied]!);
      out.push(
        "",
        "In hindsight, your best choices against what they played:",
        ...best
          .slice(0, TABLE_REPLIES)
          .map((row) => `  ${signed(row.swings[replied])}  ${row.option.label}`),
      );
    }
    return out.join("\n");
  }
}
