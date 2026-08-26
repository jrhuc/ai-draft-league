import type {
  EstimateDamageArguments,
  ShowdownReference,
  SpeedProfile,
  SpeedProfileInput,
} from "./reference.js";
import { type BattleStateView, type MonState, SCREEN_MOVES, stateKey } from "./state-model.js";
import type { JsonObject, Pid } from "./types.js";
import { afterColon, text } from "./value.js";

interface MonEntry {
  pid: Pid;
  slot: number;
  mon: MonState;
}

interface FoundMon extends MonEntry {
  benched: boolean;
}

interface PriorityContext {
  ability?: string;
  item?: string;
  itemConsumed: boolean;
  fullHp?: boolean;
  grassyTerrain: boolean;
}

interface PriorityInfo {
  priority: number;
  notes: string[];
  unresolved?: string;
}

export function activeEntries(state: BattleStateView): MonEntry[] {
  const entries: MonEntry[] = [];
  for (const pid of ["p1", "p2"] as const) {
    const side = state.sides[pid];
    for (const [slot, letter] of [
      [1, "a"],
      [2, "b"],
    ] as const) {
      const key = side.active[letter];
      const mon = key ? side.mons.get(key) : undefined;
      if (mon && !mon.fainted) entries.push({ pid, slot, mon });
    }
  }
  return entries;
}

export function activeEntry(state: BattleStateView, pid: Pid, slot: number): MonState | undefined {
  const key = state.sides[pid].active[slot === 1 ? "a" : slot === 2 ? "b" : ""];
  const mon = key ? state.sides[pid].mons.get(key) : undefined;
  return mon && !mon.fainted ? mon : undefined;
}

function findMon(state: BattleStateView, query: string): FoundMon | undefined {
  const activeMatch = findActive(state, query);
  if (activeMatch) return { ...activeMatch, benched: false };
  const normalized = stateKey(query);
  const prefixed = /^(ally|foe)(.+)$/.exec(normalized);
  const wanted = prefixed ? prefixed[2]! : normalized;
  const demega = (key: string) => key.replace(/mega[xy]?$/, "").replace(/^mega/, "");
  for (const pid of ["p1", "p2"] as const) {
    if (prefixed && (pid === state.pid) !== (prefixed[1] === "ally")) continue;
    const side = state.sides[pid];
    const activeKeys = new Set(Object.values(side.active));
    for (const [key, mon] of side.mons) {
      if (activeKeys.has(key) || mon.fainted) continue;
      const monKey = stateKey(mon.species);
      if (monKey === wanted || demega(monKey) === wanted || monKey === demega(wanted))
        return { pid, slot: -1, mon, benched: true };
    }
  }
  return undefined;
}

function findActive(state: BattleStateView, query: string): MonEntry | undefined {
  const normalized = stateKey(query);
  const slot = /^(ally|foe)([12])$/.exec(normalized);
  if (slot) {
    const own = slot[1] === "ally";
    const pid = own ? state.pid : state.pid === "p1" ? "p2" : "p1";
    const mon = activeEntry(state, pid, Number(slot[2]));
    return mon ? { pid, slot: Number(slot[2]), mon } : undefined;
  }
  const prefixed = /^(ally|foe)(.+)$/.exec(normalized);
  const candidates = prefixed
    ? activeEntries(state).filter((entry) => (entry.pid === state.pid) === (prefixed[1] === "ally"))
    : activeEntries(state);
  const wanted = prefixed ? prefixed[2]! : normalized;
  const exact = candidates.find(
    (entry) =>
      stateKey(entry.mon.species) === wanted || stateKey(afterColon(entry.mon.ident)) === wanted,
  );
  if (exact) return exact;
  const demega = (key: string) => key.replace(/mega[xy]?$/, "").replace(/^mega/, "");
  const wantedBase = demega(wanted);
  return candidates.find((entry) => {
    const entryKey = stateKey(entry.mon.species);
    return (
      demega(entryKey) === wanted || entryKey === wantedBase || demega(entryKey) === wantedBase
    );
  });
}

export function speedProfile(
  state: BattleStateView,
  pid: Pid,
  mon: MonState,
  reference: ShowdownReference,
): SpeedProfile | undefined {
  const conditions = state.sides[pid].conditions;
  const terrain = [...state.fields.values()].find((effect) => /terrain/i.test(effect.name))?.name;
  const input: SpeedProfileInput = {
    species: mon.species,
    itemConsumed: mon.itemConsumed,
    tailwind: conditions.has("tailwind"),
  };
  if (mon.nature !== undefined) input.nature = mon.nature;
  const speed = mon.stats.spe;
  if (pid === state.pid && speed !== undefined && Number.isInteger(speed)) input.exact = speed;
  if (mon.item !== undefined) input.item = mon.item;
  if (mon.ability !== undefined) input.ability = mon.ability;
  if (mon.status !== undefined) input.status = mon.status;
  if (mon.boosts.spe !== undefined) input.boost = mon.boosts.spe;
  if (state.weather) input.weather = state.weather.name;
  if (terrain !== undefined) input.terrain = terrain;
  return reference.speedProfile(input);
}

export function formatRange(range: [number, number]): string {
  return range[0] === range[1] ? String(range[0]) : `${range[0]}–${range[1]}`;
}

function speedOrder(
  first: SpeedProfile,
  second: SpeedProfile,
  trickRoom: boolean,
): "first" | "second" | "tie" | "uncertain" {
  if (
    first.effective[0] === first.effective[1] &&
    first.effective[0] === second.effective[0] &&
    second.effective[0] === second.effective[1]
  )
    return "tie";
  if (trickRoom) {
    if (first.effective[1] < second.effective[0]) return "first";
    if (second.effective[1] < first.effective[0]) return "second";
  } else {
    if (first.effective[0] > second.effective[1]) return "first";
    if (second.effective[0] > first.effective[1]) return "second";
  }
  return "uncertain";
}

export function compareActionOrder(
  state: BattleStateView,
  args: JsonObject,
  reference: ShowdownReference,
): string {
  const firstName = text(args.first).trim();
  const secondName = text(args.second).trim();
  if (!firstName || !secondName)
    return "first and second are required active Pokémon names or ally/foe slot labels.";
  const first = findMon(state, firstName);
  const second = findMon(state, secondName);
  const active = activeEntries(state).map(
    (entry) => `${entry.pid === state.pid ? "ally" : "foe"} ${entry.slot}: ${entry.mon.species}`,
  );
  if (!first || !second)
    return `Could not resolve ${!first ? JSON.stringify(firstName) : JSON.stringify(secondName)}. Active Pokémon: ${active.join("; ") || "none"}; benched Pokémon may be named directly.`;
  if (first.mon === second.mon) return "first and second must identify different Pokémon.";

  const firstProfile = speedProfile(state, first.pid, first.mon, reference);
  const secondProfile = speedProfile(state, second.pid, second.mon, reference);
  if (!firstProfile || !secondProfile)
    return "Speed data is unavailable for one of the selected Pokémon.";
  const firstMove = text(args.first_move).trim();
  const secondMove = text(args.second_move).trim();
  const switchKeys = new Set(["switch", "switchout", "switching", "swap"]);
  const firstIsSwitch = switchKeys.has(stateKey(firstMove));
  const secondIsSwitch = switchKeys.has(stateKey(secondMove));
  const grassyTerrain = [...state.fields.values()].some((effect) => /grassy/i.test(effect.name));
  const contextFor = (mon: MonState): PriorityContext => {
    const context: PriorityContext = { itemConsumed: mon.itemConsumed, grassyTerrain };
    if (mon.ability !== undefined) context.ability = mon.ability;
    if (mon.item !== undefined) context.item = mon.item;
    if (mon.hpPercent !== undefined) context.fullHp = mon.hpPercent >= 99.5;
    return context;
  };
  const emptyInfo: PriorityInfo = { priority: 0, notes: [] };
  const firstInfo =
    firstMove && !firstIsSwitch
      ? reference.priorityProfile(firstMove, contextFor(first.mon))
      : emptyInfo;
  const secondInfo =
    secondMove && !secondIsSwitch
      ? reference.priorityProfile(secondMove, contextFor(second.mon))
      : emptyInfo;
  if (!firstInfo) return `No move data for ${JSON.stringify(firstMove)}.`;
  if (!secondInfo) return `No move data for ${JSON.stringify(secondMove)}.`;
  const firstPriority = firstInfo.priority;
  const secondPriority = secondInfo.priority;

  const trickRoom = state.fields.has("trickroom");
  const bracketLast = (info: { notes: string[] }) =>
    info.notes.some((note) => note.includes("acts last within its bracket"));
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
  let order: "first" | "second" | "tie" | "uncertain";
  let reason: string;
  if (firstIsSwitch !== secondIsSwitch) {
    order = firstIsSwitch ? "first" : "second";
    reason = "switches resolve before moves";
  } else if (firstIsSwitch && secondIsSwitch) {
    order = speedOrder(firstProfile, secondProfile, trickRoom);
    reason = trickRoom
      ? "both switching; switch order follows Speed under Trick Room"
      : "both switching; switch order follows Speed";
  } else if (firstInfo.unresolved || secondInfo.unresolved) {
    order = "uncertain";
    reason = [firstInfo.unresolved, secondInfo.unresolved].filter(Boolean).join("; ");
  } else if (firstPriority !== secondPriority) {
    order = firstPriority > secondPriority ? "first" : "second";
    reason = `move priority ${signed(firstPriority)} vs ${signed(secondPriority)}`;
  } else if (bracketLast(firstInfo) !== bracketLast(secondInfo)) {
    order = bracketLast(firstInfo) ? "second" : "first";
    reason = [...firstInfo.notes, ...secondInfo.notes].find((note) =>
      note.includes("acts last within its bracket"),
    )!;
  } else {
    order = speedOrder(firstProfile, secondProfile, trickRoom);
    reason = trickRoom ? "equal priority under Trick Room" : "equal priority";
  }
  const quickClaw = (info: { notes: string[] }) =>
    info.notes.some((note) => note.startsWith("Quick Claw"));
  const sameBracket = !firstIsSwitch && !secondIsSwitch && firstPriority === secondPriority;
  const orderText =
    order === "first"
      ? sameBracket && quickClaw(secondInfo)
        ? `${first.mon.species} acts first unless ${second.mon.species}'s Quick Claw triggers (20%)`
        : `${first.mon.species} is guaranteed to act first`
      : order === "second"
        ? sameBracket && quickClaw(firstInfo)
          ? `${second.mon.species} acts first unless ${first.mon.species}'s Quick Claw triggers (20%)`
          : `${second.mon.species} is guaranteed to act first`
        : order === "tie"
          ? "The Pokémon speed-tie"
          : "Their order is uncertain across the legal hidden Speed range";
  const describe = (name: string, profile: SpeedProfile) => {
    const raw = formatRange(profile.raw);
    const effective = formatRange(profile.effective);
    return `${name}: raw Speed ${raw}; effective Speed ${effective}${
      profile.modifiers.length ? ` (${profile.modifiers.join(", ")})` : ""
    }`;
  };
  const lines = [
    describe(`${first.mon.species}${first.benched ? " (benched)" : ""}`, firstProfile),
    describe(`${second.mon.species}${second.benched ? " (benched)" : ""}`, secondProfile),
    `${orderText} (${reason}).`,
  ];
  const notes = [
    ...firstInfo.notes.map((note) => `${first.mon.species}: ${note}`),
    ...secondInfo.notes.map((note) => `${second.mon.species}: ${note}`),
  ];
  if (notes.length) lines.push(`Priority modifiers applied: ${notes.join("; ")}.`);
  if (first.benched || second.benched)
    lines.push(
      "Benched Pokémon are compared as if already on the field (entry boosts not included).",
    );
  if (stateKey(firstMove) === "encore") {
    const alreadyEncored = [...second.mon.volatiles].some(
      (volatile) => stateKey(volatile) === "encore",
    );
    if (alreadyEncored) lines.push(`Encore fails: ${second.mon.species} is already Encored.`);
    else if (second.mon.choiceLock)
      lines.push(
        `Encore is redundant: ${second.mon.species} is already Choice-locked into ${second.mon.choiceLock}.`,
      );
    else if (order === "first")
      lines.push(
        second.mon.lastMove
          ? `Encore acts before the target and attempts to lock its prior move, ${second.mon.lastMove.name}.`
          : "Encore acts before the target and fails because it has no prior move.",
      );
    else if (order === "second")
      lines.push(
        `Encore acts after the target and attempts to lock the move used this turn${
          secondMove ? `, ${secondMove}` : ""
        }.`,
      );
    else
      lines.push(
        "Encore timing depends on the unresolved order; it may lock the prior move or the move used this turn.",
      );
  }
  return lines.join("\n");
}

export function estimateDamage(
  state: BattleStateView,
  args: JsonObject,
  reference: ShowdownReference,
): string {
  const attackerName = text(args.attacker).trim();
  const defenderName = text(args.defender).trim();
  const move = text(args.move).trim();
  if (!attackerName || !defenderName || !move) return "attacker, defender, and move are required.";
  const attacker = findMon(state, attackerName);
  const defender = findMon(state, defenderName);
  const visible = activeEntries(state).map(
    (entry) => `${entry.pid === state.pid ? "ally" : "foe"} ${entry.slot}: ${entry.mon.species}`,
  );
  if (!attacker || !defender) {
    const missing = !attacker ? attackerName : defenderName;
    return `Could not resolve ${JSON.stringify(missing)} on the visible battle rosters. Active Pokémon: ${visible.join("; ") || "none"}.`;
  }
  if (attacker.mon === defender.mon)
    return "attacker and defender must identify different Pokémon.";

  const exactStats = (entry: MonEntry, includeHp: boolean) => {
    if (entry.pid !== state.pid) return {};
    const stats = { ...entry.mon.stats };
    if (includeHp) {
      const maximum = /\/(\d+)/.exec(entry.mon.hp ?? "")?.[1];
      if (maximum) stats.hp = Number(maximum);
    }
    return stats;
  };
  const ability = (mon: MonState) =>
    mon.abilitySuppressed ? undefined : (mon.ability ?? reference.speciesAbility(mon.species));
  const authoritative: EstimateDamageArguments = {
    attacker: attacker.mon.species,
    defender: defender.mon.species,
    move,
  };
  const setMon = (side: "attacker" | "defender", entry: MonEntry): void => {
    const monAbility = ability(entry.mon);
    const stats = exactStats(entry, side === "defender");
    if (side === "attacker") {
      if (monAbility) authoritative.attacker_ability = monAbility;
      if (entry.mon.item && !entry.mon.itemConsumed) authoritative.attacker_item = entry.mon.item;
      if (entry.mon.nature) authoritative.attacker_nature = entry.mon.nature;
      if (entry.mon.status) authoritative.attacker_status = entry.mon.status;
      if (Object.keys(entry.mon.boosts).length)
        authoritative.attacker_boosts = { ...entry.mon.boosts };
      if (entry.mon.hpPercent !== undefined)
        authoritative.attacker_hp_percent = entry.mon.hpPercent;
      if (Object.keys(stats).length) authoritative.attacker_stats = stats;
    } else {
      if (monAbility) authoritative.defender_ability = monAbility;
      if (entry.mon.item && !entry.mon.itemConsumed) authoritative.defender_item = entry.mon.item;
      if (entry.mon.nature) authoritative.defender_nature = entry.mon.nature;
      if (entry.mon.status) authoritative.defender_status = entry.mon.status;
      if (Object.keys(entry.mon.boosts).length)
        authoritative.defender_boosts = { ...entry.mon.boosts };
      if (entry.mon.hpPercent !== undefined)
        authoritative.defender_hp_percent = entry.mon.hpPercent;
      if (Object.keys(stats).length) authoritative.defender_stats = stats;
    }
  };
  setMon("attacker", attacker);
  setMon("defender", defender);
  authoritative.attacker_fainted_allies = [...state.sides[attacker.pid].mons.values()].filter(
    (mon) => mon.fainted,
  ).length;
  const active = activeEntries(state);
  const moveTarget = reference.moveTarget(move);
  const liveFoes = active.filter((entry) => entry.pid !== attacker.pid).length;
  const hasLiveAlly = active.some(
    (entry) => entry.pid === attacker.pid && entry.mon !== attacker.mon,
  );
  authoritative.is_spread_hit =
    moveTarget === "allAdjacentFoes"
      ? liveFoes === 2
      : moveTarget === "allAdjacent"
        ? liveFoes + Number(hasLiveAlly) > 1
        : false;
  for (const [side, entry] of [
    ["attacker", attacker],
    ["defender", defender],
  ] as const) {
    const ally = active.find((other) => other.pid === entry.pid && other.mon !== entry.mon);
    if (!ally) continue;
    const allyAbility = ability(ally.mon);
    if (side === "attacker") {
      authoritative.attacker_ally = ally.mon.species;
      if (allyAbility) authoritative.attacker_ally_ability = allyAbility;
      if (ally.mon.item && !ally.mon.itemConsumed) authoritative.attacker_ally_item = ally.mon.item;
    } else {
      authoritative.defender_ally = ally.mon.species;
      if (allyAbility) authoritative.defender_ally_ability = allyAbility;
      if (ally.mon.item && !ally.mon.itemConsumed) authoritative.defender_ally_item = ally.mon.item;
    }
  }
  const screens = [...state.sides[defender.pid].conditions.keys()].filter((condition) =>
    SCREEN_MOVES.has(condition),
  );
  if (screens.length) authoritative.defender_screens = screens;
  if (state.weather) authoritative.weather = state.weather.name;
  const terrain = [...state.fields.values()].find((effect) => /terrain/i.test(effect.name));
  if (terrain) authoritative.terrain = terrain.name;
  if (args.helping_hand === true) authoritative.helping_hand = true;
  if (args.is_critical_hit === true) authoritative.is_critical_hit = true;

  const known = (entry: MonEntry, side: string) => {
    const monAbility = ability(entry.mon);
    return `${side} ${entry.mon.species}${
      monAbility
        ? ` (${monAbility})`
        : entry.mon.abilitySuppressed
          ? " (ability suppressed)"
          : " (ability unknown)"
    }`;
  };
  const context = `Live battle and known team-sheet state applied: ${known(attacker, "attacker")}; ${known(defender, "defender")}.`;
  return `${context}\n${reference.lookup("estimate_damage", authoritative)}`;
}
