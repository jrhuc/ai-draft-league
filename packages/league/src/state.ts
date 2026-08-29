import type {
  CompactMon,
  CompactMonReference,
  MatchupMon,
  ShowdownReference,
} from "./reference.js";
import {
  type MonState,
  MonState as MutableMonState,
  PROTECT_MOVES,
  type ProtectReducedSlots,
  SCREEN_MOVES,
  type SideState,
  SideState as MutableSideState,
  type SideTimers,
  stateKey,
  type TimedEffect,
} from "./state-model.js";
import {
  activeEntries,
  activeEntry,
  compareActionOrder,
  estimateDamage,
  formatRange,
  speedProfile,
} from "./state-tools.js";
import type { BattleRequest, JsonObject, Pid } from "./types.js";

import { afterColon, asRecord, asRecords, asStrings, text } from "./value.js";

export { MonState, PROTECT_MOVES } from "./state-model.js";

const STAT_LABELS = new Map([
  ["atk", "Attack"],
  ["def", "Defense"],
  ["spa", "Special Attack"],
  ["spd", "Special Defense"],
  ["spe", "Speed"],
]);

const CHOICE_ITEMS = new Set(["choiceband", "choicescarf", "choicespecs"]);
const TIMED_SIDE_CONDITIONS = new Map<string, number>([
  ["tailwind", 4],
  ["reflect", 5],
  ["lightscreen", 5],
  ["auroraveil", 5],
  ["safeguard", 5],
  ["mist", 5],
  ["luckychant", 5],
]);

const WEATHER_ROCKS = new Map([
  ["raindance", "damprock"],
  ["sunnyday", "heatrock"],
  ["sandstorm", "smoothrock"],
  ["snow", "icyrock"],
  ["snowscape", "icyrock"],
  ["hail", "icyrock"],
]);

export class BattleState {
  turn = 0;
  private upkeepDone = false;
  weather: TimedEffect | undefined;
  fields = new Map<string, TimedEffect>();
  sides = { p1: new MutableSideState(), p2: new MutableSideState() };
  timers: SideTimers = { p1: undefined, p2: undefined };
  private logClockMs: number | undefined;

  constructor(readonly pid: Pid) {}

  feed(lines: readonly string[]): void {
    for (const line of lines) {
      if (
        !line ||
        line.startsWith("|uhtml|") ||
        line.startsWith("|uhtmlchange|") ||
        line.startsWith("|html|") ||
        line.startsWith("|raw|")
      )
        continue;
      this.feedLine(line);
    }
  }

  private feedLine(line: string): void {
    if (!line.startsWith("|")) return;
    const [, kind = "", ...args] = line.split("|");
    if (kind === "turn" && args[0]) {
      this.turn = Number(args[0]);
      this.upkeepDone = false;
    } else if (kind === "upkeep") this.upkeepDone = true;
    else if ((kind === "switch" || kind === "drag" || kind === "replace") && args.length >= 3) {
      const mon = this.mon(args[0]!);
      this.setDetails(mon, args[1]!);
      this.setHp(mon, args[2]!);
      const [side, slot] = this.identParts(args[0]!);
      if (side) {
        if (kind !== "replace") {
          mon.ability = undefined;
          mon.abilitySuppressed = false;
        }
        this.mergeSheetMon(mon, this.sides[side]);
        const previous = this.sides[side].active[slot];
        const previousMon = previous ? this.sides[side].mons.get(previous) : undefined;
        if (previousMon) {
          previousMon.boosts = {};
          previousMon.volatiles.clear();
          previousMon.choiceLock = undefined;
        }
        if (kind !== "replace") {
          mon.boosts = {};
          mon.volatiles.clear();
          mon.protectSuccessStreak = 0;
          mon.choiceLock = undefined;
        }
        this.sides[side].active[slot] = this.monKey(args[0]!);
      }
    } else if (kind === "detailschange" && args.length >= 2) {
      const mon = this.mon(args[0]!);
      const previous = mon.species;
      this.setDetails(mon, args[1]!);
      if (this.speciesKey(previous) !== this.speciesKey(mon.species)) {
        mon.ability = undefined;
        mon.abilitySuppressed = false;
      }
    } else if (kind === "poke" && args.length >= 2 && (args[0] === "p1" || args[0] === "p2")) {
      const species = args[1]!.split(",", 1)[0]!.trim();
      const mon = this.mon(`${args[0]}: ${species}`);
      this.setDetails(mon, args[1]!);
      mon.preview = true;
    } else if (kind === "move" && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.recordMove(args[1]!, 1);
      mon.lastMove = args[2]
        ? { name: args[1]!, target: args[2], turn: this.turn }
        : { name: args[1]!, turn: this.turn };
      if (!mon.itemConsumed && CHOICE_ITEMS.has(this.speciesKey(mon.item ?? "")))
        mon.choiceLock = args[1]!;
      const moveId = this.speciesKey(args[1]!);
      if (!PROTECT_MOVES.has(moveId)) mon.protectSuccessStreak = 0;
    } else if (kind === "-singleturn" && args.length >= 2) {
      if (PROTECT_MOVES.has(this.speciesKey(this.effect(args[1]!))))
        this.mon(args[0]!).protectSuccessStreak += 1;
    } else if (kind === "-fail" && args[0]) {
      const mon = this.mon(args[0]!);
      if (
        mon.lastMove &&
        PROTECT_MOVES.has(this.speciesKey(mon.lastMove.name)) &&
        mon.lastMove.turn === this.turn
      )
        mon.protectSuccessStreak = 0;
    } else if (kind === "faint" && args[0]) {
      const mon = this.mon(args[0]);
      mon.hp = "0 fnt";
      mon.hpPercent = 0;
      mon.fainted = true;
      mon.boosts = {};
      mon.volatiles.clear();
    } else if ((kind === "-damage" || kind === "-heal") && args.length >= 2)
      this.setHp(this.mon(args[0]!), args[1]!);
    else if (kind === "-sethp") {
      for (let index = 0; index < args.length - 1; index += 2) {
        if (args[index]!.startsWith("p")) this.setHp(this.mon(args[index]!), args[index + 1]!);
      }
    } else if (kind === "-status" && args.length >= 2) this.mon(args[0]!).status = args[1];
    else if (kind === "-curestatus" && args[0]) this.mon(args[0]).status = undefined;
    else if (
      (kind === "-boost" || kind === "-unboost" || kind === "-setboost") &&
      args.length >= 3
    ) {
      const mon = this.mon(args[0]!);
      const stat = args[1]!;
      const amount = Number(args[2]);
      mon.boosts[stat] =
        kind === "-setboost"
          ? amount
          : (mon.boosts[stat] ?? 0) + (kind === "-boost" ? amount : -amount);
    } else if (kind === "-clearboost" && args[0]) this.mon(args[0]).boosts = {};
    else if (kind === "-clearallboost") {
      for (const side of Object.values(this.sides))
        for (const mon of side.mons.values()) mon.boosts = {};
    } else if (kind === "-clearnegativeboost" && args[0]) {
      const mon = this.mon(args[0]);
      mon.boosts = Object.fromEntries(Object.entries(mon.boosts).filter(([, value]) => value > 0));
    } else if ((kind === "-start" || kind === "-end") && args.length >= 2) {
      const mon = this.mon(args[0]!);
      const effect = this.effect(args[1]!);
      if (kind === "-start") {
        if (/^perish\d$/.test(this.speciesKey(effect))) {
          for (const volatile of mon.volatiles) {
            if (/^perish\d$/.test(this.speciesKey(volatile))) mon.volatiles.delete(volatile);
          }
        }
        mon.volatiles.add(effect);
      } else mon.volatiles.delete(effect);
    } else if (kind === "-weather" && args[0] !== undefined) {
      if (args[0] === "none" || !args[0]) this.weather = undefined;
      else if (
        !args.includes("[upkeep]") ||
        !this.weather ||
        this.speciesKey(this.weather.name) !== this.speciesKey(args[0])
      ) {
        const name = this.effect(args[0]);
        const rock = WEATHER_ROCKS.get(this.speciesKey(name));
        const setter = this.effectSource(args) ?? this.lastMoveUserThisTurn(this.speciesKey(name));
        const extended =
          rock !== undefined && setter?.item !== undefined && this.speciesKey(setter.item) === rock;
        this.weather = { name, startedTurn: this.effectStartTurn(), duration: extended ? 8 : 5 };
      }
    } else if (kind === "-fieldstart" && args[0]) {
      const name = this.effect(args[0]);
      this.fields.set(this.speciesKey(name), {
        name,
        startedTurn: this.effectStartTurn(),
        duration: 5,
      });
    } else if (kind === "-fieldend" && args[0])
      this.fields.delete(this.speciesKey(this.effect(args[0]!)));
    else if ((kind === "-sidestart" || kind === "-sideend") && args.length >= 2) {
      const side = args[0]!.split(":")[0]!;
      if (side === "p1" || side === "p2") {
        const effect = this.effect(args[1]!);
        const key = this.speciesKey(effect);
        if (kind === "-sidestart") {
          let duration = TIMED_SIDE_CONDITIONS.get(key);
          if (SCREEN_MOVES.has(key)) {
            const setter =
              this.lastMoveUserThisTurn(key, side) ??
              [...this.sides[side].mons.values()].find(
                (mon) => mon.item && this.speciesKey(mon.item) === "lightclay",
              );
            if (setter?.item && this.speciesKey(setter.item) === "lightclay") duration = 8;
          }
          const condition: TimedEffect = {
            name: effect,
            startedTurn: Math.max(1, this.turn),
          };
          if (duration !== undefined) condition.duration = duration;
          this.sides[side].conditions.set(key, condition);
        } else this.sides[side].conditions.delete(key);
      }
    } else if (kind === "-item" && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.item = args[1];
      mon.itemConsumed = false;
      mon.choiceLock = undefined;
    } else if (kind === "-enditem" && args[0]) {
      const mon = this.mon(args[0]);
      if (args[1]) mon.item = args[1];
      mon.itemConsumed = true;
      mon.choiceLock = undefined;
    } else if (kind === "-ability" && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.ability = args[1];
      mon.abilitySuppressed = false;
    } else if (kind === "-endability" && args[0]) {
      const mon = this.mon(args[0]);
      mon.ability = undefined;
      mon.abilitySuppressed = true;
    } else if (kind === "-mega" && args[0]) {
      const mon = this.mon(args[0]);
      mon.mega = true;
      mon.ability = undefined;
      mon.abilitySuppressed = false;
    } else if (kind === "-formechange" && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.species = args[1]!;
      mon.formes.add(this.speciesKey(args[1]!));
      mon.ability = undefined;
      mon.abilitySuppressed = false;
    } else if (kind === "showteam" && args.length >= 2)
      this.showTeam(args[0]!, args.slice(1).join("|"));
    else if (kind === "t:" && Number.isFinite(Number(args[0])))
      this.logClockMs = Number(args[0]) * 1000;
    else if (kind === "-vgctimer" && (args[0] === "p1" || args[0] === "p2")) {
      const parse = (value: string | undefined) =>
        value && Number.isFinite(Number(value)) ? Number(value) : null;
      this.timers[args[0]] = {
        seconds: parse(args[1]),
        turnSeconds: parse(args[2]),
        at: this.logClockMs ?? Date.now(),
        running: true,
      };
    } else if (kind === "-vgcdeciding" && (args[0] === "p1" || args[0] === "p2")) {
      this.timers[args[0]] = {
        seconds: null,
        turnSeconds: null,
        at: this.logClockMs ?? Date.now(),
        running: true,
      };
    } else if (
      (kind === "-vgctimerstop" || kind === "-vgctimeout") &&
      (args[0] === "p1" || args[0] === "p2")
    ) {
      this.stopTimer(args[0]);
    } else if (kind === "win" || kind === "tie") {
      this.stopTimer("p1");
      this.stopTimer("p2");
    }
  }

  render(
    request: BattleRequest,
    referenceFor?: (mon: CompactMon) => CompactMonReference | undefined,
  ): string {
    this.updateOwnRequest(request);
    const foe: Pid = this.pid === "p1" ? "p2" : "p1";
    return [
      `Turn: ${this.turn}`,
      `Weather: ${this.weatherLabel()}`,
      `Field: ${this.fieldLabels().join(", ") || "none"}`,
      ...this.renderSide(this.pid, true, request.teamPreview === true, referenceFor),
      ...this.renderSide(foe, false, request.teamPreview === true, referenceFor),
    ].join("\n");
  }

  renderReview(referenceFor?: (mon: CompactMon) => CompactMonReference | undefined): string {
    const foe: Pid = this.pid === "p1" ? "p2" : "p1";
    return [
      `Turn: ${this.turn}`,
      `Weather: ${this.weatherLabel()}`,
      `Field: ${this.fieldLabels().join(", ") || "none"}`,
      ...this.renderSide(this.pid, true, false, referenceFor, true),
      ...this.renderSide(foe, false, false, referenceFor),
    ].join("\n");
  }

  slotName(slot: number, request: BattleRequest): string {
    if (request.teamPreview) return `team preview pick ${slot + 1}`;
    const key = this.sides[this.pid].active[String.fromCharCode("a".charCodeAt(0) + slot)];
    const mon = key ? this.sides[this.pid].mons.get(key) : undefined;
    if (mon) return mon.species;
    const active = (request.side?.pokemon ?? []).filter((item) => item.active);
    return active[slot] ? BattleState.requestName(active[slot]) : "Pokémon";
  }

  compactMons(): CompactMon[] {
    const out: CompactMon[] = [];
    for (const pid of ["p1", "p2"] as const) {
      const side = this.sides[pid];
      const own = pid === this.pid;
      const activeKeys = new Set(Object.values(side.active));
      const mons = [...side.mons.values()].filter((mon) => {
        if (mon.fainted) return false;
        if (own && mon.brought === false) return false;
        if (activeKeys.has(this.monKey(mon.ident))) return true;
        if (own) return mon.brought !== false;
        return Boolean(mon.hp !== undefined || mon.moves.size || side.showteam);
      });
      if (!own && side.showteam) {
        const known = new Set(mons.map((mon) => this.speciesKey(mon.species)));
        for (const sheetMon of side.sheet) {
          if (!known.has(this.speciesKey(sheetMon.species))) mons.push(sheetMon);
        }
      }
      for (const mon of mons) {
        out.push({
          species: mon.species,
          item: mon.item ?? null,
          nature: mon.nature ?? null,
          moves: [...mon.moves.values()].map((move) => move.name),
          active: activeKeys.has(this.monKey(mon.ident)),
        });
      }
    }
    return out;
  }

  protectReducedSlots(): ProtectReducedSlots {
    const reduced: ProtectReducedSlots = {};
    const side = this.sides[this.pid];
    for (const [number, slot] of [
      [1, "a"],
      [2, "b"],
    ] as const) {
      const key = side.active[slot];
      const mon = key ? side.mons.get(key) : undefined;
      if (mon && !mon.fainted && mon.protectSuccessStreak > 0) reduced[number] = true;
    }
    return reduced;
  }

  activeMatchupSides(reference?: ShowdownReference) {
    const collect = (pid: Pid, ally: boolean): MatchupMon[] => {
      const side = this.sides[pid];
      return (["a", "b"] as const).flatMap((slot) => {
        const key = side.active[slot];
        const mon = key ? side.mons.get(key) : undefined;
        if (!mon || mon.fainted) return [];
        const ability = mon.abilitySuppressed
          ? undefined
          : (mon.ability ?? reference?.speciesAbility(mon.species));
        const matchup: MatchupMon = {
          species: mon.species,
          moves: [...mon.moves.values()].map((move) => move.name),
          ally,
        };
        if (ability !== undefined) matchup.ability = ability;
        if (mon.item !== undefined) matchup.item = mon.item;
        matchup.itemConsumed = mon.itemConsumed;
        return [matchup];
      });
    };
    const foe: Pid = this.pid === "p1" ? "p2" : "p1";
    return { allies: collect(this.pid, true), foes: collect(foe, false) };
  }

  renderEffectiveSpeeds(reference: ShowdownReference): string {
    const entries = activeEntries(this).flatMap((entry) => {
      const profile = speedProfile(this, entry.pid, entry.mon, reference);
      if (!profile) return [];
      const role = entry.pid === this.pid ? "your" : "foe";
      const effective = formatRange(profile.effective);
      const modifiers = profile.modifiers.length ? ` (${profile.modifiers.join(", ")})` : "";
      return [`${role} ${entry.mon.species} ${effective}${modifiers}`];
    });
    if (!entries.length) return "";
    const trickRoom = this.fields.has("trickroom")
      ? " Trick Room reverses order within equal priority."
      : "";
    return `Effective Speed before move priority (foe values preserve hidden EV ranges): ${entries.join("; ")}.${trickRoom}`;
  }

  moveAnnotation(
    moveName: string,
    targetSide: "foe" | "ally",
    targetNumber: number,
  ): string | undefined {
    if (this.speciesKey(moveName) !== "encore") return undefined;
    const pid = targetSide === "ally" ? this.pid : this.pid === "p1" ? "p2" : "p1";
    const target = activeEntry(this, pid, targetNumber);
    if (!target) return undefined;
    if ([...target.volatiles].some((volatile) => this.speciesKey(volatile) === "encore"))
      return "fails: target already Encored";
    if (target.choiceLock) return `redundant: target is Choice-locked into ${target.choiceLock}`;
    return undefined;
  }

  compareActionOrder(args: JsonObject, reference: ShowdownReference): string {
    return compareActionOrder(this, args, reference);
  }

  estimateDamage(args: JsonObject, request: BattleRequest, reference: ShowdownReference): string {
    this.updateOwnRequest(request);
    return estimateDamage(this, args, reference);
  }

  private stopTimer(pid: Pid): void {
    const timer = this.timers[pid];
    if (!timer?.running) return;
    const now = Date.now();
    const drained = (now - timer.at) / 1000;
    this.timers[pid] = {
      seconds: timer.seconds === null ? null : Math.max(0, timer.seconds - drained),
      turnSeconds: timer.turnSeconds === null ? null : Math.max(0, timer.turnSeconds - drained),
      at: now,
      running: false,
    };
  }

  weatherLabel(): string {
    return this.formatTimed(this.weather);
  }

  fieldLabels(): string[] {
    return [...this.fields.values()].map((effect) => this.formatTimed(effect)).sort();
  }

  conditionLabels(pid: Pid): string[] {
    return [...this.sides[pid].conditions.values()]
      .map((effect) => this.formatTimed(effect))
      .sort();
  }

  /** Mons a spectator should see: team-preview ghosts are dropped once a richer entry covers the species. */
  visibleMons(pid: Pid): MonState[] {
    const side = this.sides[pid];
    return this.withoutPreviewGhosts(side, [...side.mons.values()]);
  }

  activeSlot(pid: Pid, mon: MonState): string | undefined {
    const key = this.monKey(mon.ident);
    return Object.entries(this.sides[pid].active).find(([, active]) => active === key)?.[0];
  }

  private withoutPreviewGhosts(side: SideState, mons: MonState[]): MonState[] {
    const rich = new Set(
      mons
        .filter((mon) => mon.hp !== undefined || mon.moves.size || mon.item || mon.ability)
        .flatMap((mon) => [this.speciesKey(mon.species), ...mon.formes]),
    );
    for (const mon of mons) {
      if (mon.hp === undefined && !mon.moves.size) continue;
      const sheetMon = side.sheet.find(
        (candidate) => this.monKey(candidate.ident) === this.monKey(mon.ident),
      );
      if (sheetMon) rich.add(this.speciesKey(sheetMon.species));
    }
    return mons.filter(
      (mon) => !(mon.preview && mon.hp === undefined && rich.has(this.speciesKey(mon.species))),
    );
  }

  private effectStartTurn(): number {
    return Math.max(1, this.turn + (this.upkeepDone ? 1 : 0));
  }

  private formatTimed(effect: TimedEffect | undefined): string {
    if (!effect) return "none";
    if (effect.duration === undefined) return effect.name;
    const elapsed = Math.max(0, this.turn - effect.startedTurn);
    const remaining = Math.max(0, effect.duration - elapsed);
    return `${effect.name} (${remaining} turn${remaining === 1 ? "" : "s"} left)`;
  }

  private effectSource(args: string[]): MonState | undefined {
    const of = args.find((arg) => arg.startsWith("[of] "));
    if (!of) return undefined;
    const ident = of.slice(5);
    const side = this.identParts(ident)[0];
    return side ? this.sides[side].mons.get(this.monKey(ident)) : undefined;
  }

  private lastMoveUserThisTurn(moveId: string, pid?: Pid): MonState | undefined {
    for (const side of pid ? [this.sides[pid]] : Object.values(this.sides)) {
      for (const key of Object.values(side.active)) {
        const mon = side.mons.get(key);
        if (
          mon?.lastMove &&
          mon.lastMove.turn === this.turn &&
          this.speciesKey(mon.lastMove.name) === moveId
        )
          return mon;
      }
    }
    return undefined;
  }

  private renderSide(
    pid: Pid,
    own: boolean,
    expandedRoster: boolean,
    referenceFor?: (mon: CompactMon) => CompactMonReference | undefined,
    includeOwnBench = false,
  ): string[] {
    const side = this.sides[pid];
    const title = own ? "Your side" : "Opponent side";
    const conditions = this.conditionLabels(pid);
    const lines = [`${title} conditions: ${conditions.length ? conditions.join(", ") : "none"}`];
    const mons = this.withoutPreviewGhosts(
      side,
      [...side.mons.values()].filter((mon) => !own || includeOwnBench || mon.brought !== false),
    );
    const broughtCount = [...this.sides[this.pid].mons.values()].filter(
      (mon) => mon.brought === true,
    ).length;
    const revealedCount = mons.filter((mon) => mon.hpPercent !== undefined).length;
    const foesResolved = !own && broughtCount > 0 && revealedCount >= broughtCount;
    if (!own && broughtCount > 0 && !foesResolved)
      lines.push(
        `Opponent brought ${broughtCount} this game; ${revealedCount} revealed so far, so only ${
          broughtCount - revealedCount
        } of the "HP ?" Pokémon below ${broughtCount - revealedCount === 1 ? "is" : "are"} actually in this game.`,
      );
    if (!own && side.showteam) {
      const knownSpecies = new Set(
        mons.flatMap((mon) => [this.speciesKey(mon.species), ...mon.formes]),
      );
      const knownIdentities = new Set(mons.map((mon) => this.monKey(mon.ident)));
      mons.push(
        ...side.sheet.filter(
          (mon) =>
            !knownSpecies.has(this.speciesKey(mon.species)) &&
            !knownIdentities.has(this.monKey(mon.ident)),
        ),
      );
    }
    for (const mon of mons) {
      if (
        !own &&
        !side.showteam &&
        !mon.preview &&
        mon.hp === undefined &&
        !mon.moves.size &&
        !mon.item &&
        !mon.ability
      )
        continue;
      const activeSlots = Object.entries(side.active).flatMap(([slot, key]) =>
        key === this.monKey(mon.ident) ? [slot] : [],
      );
      const reference = referenceFor?.({
        species: mon.species,
        item: mon.item ?? null,
        nature: mon.nature ?? null,
        moves: [...mon.moves.values()].map((move) => move.name),
        active: activeSlots.length > 0,
      });
      const attrs = [mon.species];
      if (reference?.types) attrs.push(`types ${reference.types}`);
      if (activeSlots.length) attrs.push(`active slot ${activeSlots.join("/")}`);
      if ((own && mon.brought === false) || (foesResolved && mon.hpPercent === undefined))
        attrs.push("not brought this game");
      else attrs.push(`HP ${mon.hpPercent === undefined ? "?" : `${Math.round(mon.hpPercent)}%`}`);
      if (mon.status) attrs.push(mon.status);
      if (mon.fainted) attrs.push("fainted");
      if (!expandedRoster && !activeSlots.length) {
        if (mon.moves.size)
          attrs.push(`moves ${[...mon.moves.values()].map((entry) => entry.name).join(", ")}`);
        const speed = own ? mon.stats.spe : undefined;
        if (speed !== undefined) attrs.push(`Speed ${speed}`);
        else if (reference?.speed) attrs.push(`raw Speed range ${reference.speed}`);
        if (mon.item) attrs.push(`item ${mon.item}${mon.itemConsumed ? " (consumed)" : ""}`);
        if (mon.ability) attrs.push(`ability ${mon.ability}`);
        else if (mon.abilitySuppressed) attrs.push("ability suppressed");
        if (mon.nature) attrs.push(`stat alignment ${mon.nature}`);
        if (mon.mega) attrs.push("Mega Evolved");
        if (!mon.mega && reference?.mega) attrs.push(reference.mega);
        lines.push(`- ${attrs.join("; ")}`);
        continue;
      }
      const boosts = Object.entries(mon.boosts)
        .filter(([, value]) => value)
        .sort(([a], [b]) => a.localeCompare(b));
      if (boosts.length)
        attrs.push(
          `boosts ${boosts.map(([stat, value]) => `${STAT_LABELS.get(stat) ?? stat} ${value >= 0 ? "+" : ""}${value}`).join(", ")}`,
        );
      if (mon.volatiles.size) attrs.push(`volatile ${[...mon.volatiles].sort().join(", ")}`);
      if (mon.moves.size)
        attrs.push(
          `moves ${[...mon.moves.values()]
            .map((entry) => {
              const details = [
                ...(entry.pp !== undefined ? [`PP ${entry.pp}/${entry.maxpp ?? "?"}`] : []),
                ...(entry.used ? [`used ${entry.used}`] : []),
              ];
              const referenceDetail = reference?.moves[this.speciesKey(entry.name)];
              return `${entry.name}${referenceDetail ? ` [${referenceDetail}]` : ""}${
                details.length ? ` (${details.join("; ")})` : ""
              }`;
            })
            .join(", ")}`,
        );
      if (mon.protectSuccessStreak > 0)
        attrs.push(
          mon.protectSuccessStreak === 1
            ? "Protect success rate reduced next use"
            : `Protect success rate heavily reduced (streak ${mon.protectSuccessStreak})`,
        );
      if (mon.lastMove) {
        const target = mon.lastMove.target
          ? ` into ${this.targetSpecies(mon.lastMove.target)}`
          : "";
        attrs.push(`last move ${mon.lastMove.name}${target} (turn ${mon.lastMove.turn})`);
      }
      if (mon.choiceLock) attrs.push(`Choice-locked into ${mon.choiceLock}`);
      if (own && Object.keys(mon.stats).length) {
        const maxHp = /\/(\d+)/.exec(mon.hp ?? "")?.[1];
        attrs.push(
          `stats ${maxHp ? `Max HP ${maxHp}, ` : ""}${Object.entries(mon.stats)
            .map(([stat, value]) => `${STAT_LABELS.get(stat) ?? stat} ${value}`)
            .join(", ")}`,
        );
      } else if (reference?.speed) attrs.push(`raw Speed range ${reference.speed}`);
      if (mon.item) attrs.push(`item ${mon.item}${mon.itemConsumed ? " (consumed)" : ""}`);
      if (mon.ability) attrs.push(`ability ${mon.ability}`);
      else if (mon.abilitySuppressed) attrs.push("ability suppressed");
      if (mon.nature) attrs.push(`stat alignment ${mon.nature}`);
      if (mon.mega) attrs.push("Mega Evolved");
      if (!mon.mega && reference?.mega) attrs.push(reference.mega);
      lines.push(`- ${attrs.join("; ")}`);
    }
    if (lines.length === 1) lines.push("- no Pokémon revealed");
    return lines;
  }

  private updateOwnRequest(request: BattleRequest): void {
    const requested = request.side?.pokemon ?? [];
    if (!request.teamPreview && requested.length) {
      const brought = new Set(
        requested
          .map((pokemon) => this.monKey(text(pokemon.ident)))
          .filter((key) => key !== `${this.pid}:pokémon`),
      );
      for (const [key, mon] of this.sides[this.pid].mons) mon.brought = brought.has(key);
      if (request.active) this.sides[this.pid].active = {};
    }
    let activeIndex = 0;
    for (const pokemon of requested) {
      const ident = text(pokemon.ident);
      if (!ident) continue;
      const mon = this.mon(ident);
      if (!request.teamPreview) mon.brought = true;
      this.setDetails(mon, text(pokemon.details));
      const condition = text(pokemon.condition);
      this.setHp(mon, condition);
      const conditionParts = condition.split(" ");
      mon.status = conditionParts[1] && conditionParts[1] !== "fnt" ? conditionParts[1] : undefined;
      mon.item = text(pokemon.item) || mon.item;
      mon.ability = text(pokemon.ability) || text(pokemon.baseAbility) || mon.ability;
      if (text(pokemon.ability) || text(pokemon.baseAbility)) mon.abilitySuppressed = false;
      const stats = asRecord(pokemon.stats);
      mon.stats = {};
      for (const [stat, value] of Object.entries(stats)) {
        if (Number.isInteger(value)) mon.stats[stat] = Number(value);
      }
      for (const move of asStrings(pokemon.moves)) if (move) mon.recordMove(move);
      if (!pokemon.active) continue;
      const slot = activeIndex++;
      this.sides[this.pid].active[String.fromCharCode("a".charCodeAt(0) + slot)] =
        this.monKey(ident);
      const active = request.active?.[slot];
      if (!active) continue;
      for (const move of asRecords(active.moves)) {
        const name = text(move.move) || text(move.id);
        if (!name) continue;
        const entry = mon.recordMove(name);
        if (Number.isInteger(move.pp)) entry.pp = Number(move.pp);
        if (Number.isInteger(move.maxpp)) entry.maxpp = Number(move.maxpp);
      }
    }
  }

  private mon(ident: string): MonState {
    const [parsedSide] = this.identParts(ident);
    const side = parsedSide ?? this.pid;
    const key = this.monKey(ident);
    const mon = this.sides[side].mons.get(key) ?? new MutableMonState(ident);
    if (mon.species === "Pokémon") mon.species = this.nickname(ident);
    mon.ident = ident;
    this.sides[side].mons.set(key, mon);
    return mon;
  }

  private setDetails(mon: MonState, details: string): void {
    if (!details) return;
    const [species] = details.split(",").map((value) => value.trim());
    if (species) {
      mon.species = species;
      mon.formes.add(this.speciesKey(species));
    }
  }

  private setHp(mon: MonState, hp: string): void {
    if (!hp) return;
    const [rawFirst = "", status] = hp.trim().split(/\s+/);
    const match = /^(\d+)\/(\d+)[a-z]*$/i.exec(rawFirst);
    const first = match ? `${match[1]}/${match[2]}` : rawFirst;
    mon.hp = status ? `${first} ${status}` : first;
    if (match) {
      const current = Number(match[1]);
      const maximum = Number(match[2]);
      if (maximum) mon.hpPercent = (100 * current!) / maximum;
    } else if (first === "0") mon.hpPercent = 0;
    mon.fainted = status === "fnt" || mon.hpPercent === 0;
    if (status && status !== "fnt") mon.status = status;
  }

  private showTeam(pidValue: string, packed: string): void {
    if (pidValue !== "p1" && pidValue !== "p2") return;
    const sheet = packed
      .split("]")
      .filter(Boolean)
      .map((entry) => {
        const fields = entry.split("|");
        const nickname = fields[0] || "Pokémon";
        const mon = new MutableMonState(`${pidValue}: ${nickname}`);
        mon.species = fields[1] || nickname;
        mon.item = fields[2] || undefined;
        mon.ability = fields[3] || undefined;
        for (const move of fields[4]?.split(",") ?? []) if (move) mon.recordMove(move);
        mon.nature = fields[5] || undefined;
        return mon;
      });
    const side = this.sides[pidValue];
    side.sheet = sheet;
    side.showteam = true;
    const bySpecies = new Map(
      [...side.mons.values()].map((mon) => [this.speciesKey(mon.species), mon]),
    );
    for (const sheetMon of sheet) {
      const mon = bySpecies.get(this.speciesKey(sheetMon.species));
      if (mon) this.mergeMon(mon, sheetMon);
    }
  }

  private mergeSheetMon(mon: MonState, side: SideState): void {
    const sheetMon = side.sheet.find(
      (candidate) => this.speciesKey(candidate.species) === this.speciesKey(mon.species),
    );
    if (sheetMon) this.mergeMon(mon, sheetMon);
  }

  private mergeMon(mon: MonState, sheet: MonState): void {
    mon.item ||= sheet.item;
    mon.ability ||= sheet.ability;
    mon.nature ||= sheet.nature;
    for (const move of sheet.moves.values()) mon.recordMove(move.name);
  }

  private identParts(ident: string): [Pid | undefined, string] {
    const head = ident.split(":")[0]!;
    if (head.startsWith("p1")) return ["p1", head.slice(2, 3) || "a"];
    if (head.startsWith("p2")) return ["p2", head.slice(2, 3) || "a"];
    return [undefined, "a"];
  }

  private monKey(ident: string): string {
    const side = ident.startsWith("p1") || ident.startsWith("p2") ? ident.slice(0, 2) : "";
    return `${side}:${this.nickname(ident).toLowerCase()}`;
  }

  private nickname(ident: string): string {
    return afterColon(ident) || "Pokémon";
  }

  private speciesKey(species: string): string {
    return stateKey(species);
  }

  private effect(value: string): string {
    return afterColon(value);
  }

  static requestName(pokemon: JsonObject): string {
    const fromDetails = text(pokemon.details).split(",", 1)[0]?.trim();
    if (fromDetails) return fromDetails;
    return afterColon(text(pokemon.ident)) || "Pokémon";
  }

  private targetSpecies(ident: string): string {
    const side = this.identParts(ident)[0];
    if (side) {
      const mon = this.sides[side].mons.get(this.monKey(ident));
      if (mon?.species && mon.species !== "Pokémon") return mon.species;
    }
    return this.nickname(ident);
  }
}
