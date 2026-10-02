import type {
  EstimateDamageArguments,
  ShowdownReference,
  SpeedProfile,
  SpeedProfileInput,
} from "./reference.js";
import { type PerspectiveStateView, MonState, SCREEN_MOVES, stateKey } from "./state-model.js";
import type { JsonObject, JsonValue, Pid } from "./types.js";
import { z } from "zod";
import { afterColon, count, text } from "./value.js";

interface MonEntry {
  pid: Pid;
  slot: number;
  mon: MonState;
}

interface FoundMon extends MonEntry {
  benched: boolean;
}

/** `Garchomp-Mega-Z` and `Mega Garchomp Z` both reduce to `garchomp`. */
function demega(key: string): string {
  return key.replace(/^mega(.*?)[xyz]?$/, "$1").replace(/mega[xyz]?$/, "");
}

function megaScenario(
  state: PerspectiveStateView,
  entry: FoundMon,
  reference: ShowdownReference,
): FoundMon {
  const { mon, pid } = entry;
  const mega =
    mon.item && !mon.itemConsumed ? reference.megaSpecies(mon.species, mon.item) : undefined;
  if (!mega)
    throw new Error(`${mon.species} has no legal Mega Evolution with its known held item.`);
  if ([...state.sides[pid].mons.values()].some((other) => other.mega))
    throw new Error(`${pid} has already used its Mega Evolution.`);
  if (pid === state.pid && !entry.benched && !mon.canMegaEvo)
    throw new Error(`Showdown does not currently allow ${mon.species} to Mega Evolve.`);
  return {
    ...entry,
    mon: Object.assign(new MonState(mon.ident), mon, {
      species: mega.name,
      ability: mega.abilities[0],
      abilitySuppressed: false,
      stats: reference.formeStats(mon.species, mega.name, mon.stats, mon.nature),
      mega: true,
    }),
  };
}

function scenarioPair(
  state: PerspectiveStateView,
  first: FoundMon,
  second: FoundMon,
  firstMega: boolean,
  secondMega: boolean,
  reference: ShowdownReference,
): [FoundMon, FoundMon] {
  if (firstMega && secondMega && first.pid === second.pid)
    throw new Error("Only one Pokémon per side can Mega Evolve.");
  return [
    firstMega ? megaScenario(state, first, reference) : first,
    secondMega ? megaScenario(state, second, reference) : second,
  ];
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

export function activeEntries(state: PerspectiveStateView): MonEntry[] {
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

export function activeEntry(
  state: PerspectiveStateView,
  pid: Pid,
  slot: number,
): MonState | undefined {
  const key = state.sides[pid].active[slot === 1 ? "a" : slot === 2 ? "b" : ""];
  const mon = key ? state.sides[pid].mons.get(key) : undefined;
  return mon && !mon.fainted ? mon : undefined;
}

/** A bare species name that both sides field is refused rather than resolved to one of them. */
function findMon(state: PerspectiveStateView, query: string): FoundMon | undefined {
  const normalized = stateKey(query);
  const slot = /^(ally|foe)([12])$/.exec(normalized);
  if (slot) {
    const pid = sideOf(state, slot[1] === "ally");
    const mon = activeEntry(state, pid, Number(slot[2]));
    return mon ? { pid, slot: Number(slot[2]), mon, benched: false } : undefined;
  }
  const prefixed = /^(ally|foe)(.+)$/.exec(normalized);
  const wanted = prefixed ? prefixed[2]! : normalized;
  const sides = prefixed ? [sideOf(state, prefixed[1] === "ally")] : (["p1", "p2"] as const);
  const fielded = activeEntries(state).filter((entry) => sides.includes(entry.pid));
  const named = (mon: MonState) =>
    stateKey(mon.species) === wanted || stateKey(afterColon(mon.ident)) === wanted;
  const sameBase = (mon: MonState) => demega(stateKey(mon.species)) === demega(wanted);
  const benched = sides.flatMap((pid) => {
    const side = state.sides[pid];
    const activeKeys = new Set(Object.values(side.active));
    return [...side.mons]
      .filter(([key, mon]) => !activeKeys.has(key) && !mon.fainted && sameBase(mon))
      .map(([, mon]): FoundMon => ({ pid, slot: -1, mon, benched: true }));
  });
  const groups = [
    fielded.filter((entry) => named(entry.mon)).map((entry) => ({ ...entry, benched: false })),
    fielded.filter((entry) => sameBase(entry.mon)).map((entry) => ({ ...entry, benched: false })),
    benched,
  ];
  const match = groups.find((found) => found.length)?.[0];
  if (match && new Set(groups.flat().map((entry) => entry.pid)).size > 1)
    throw new Error(`Both sides have ${match.mon.species}; say "ally ${query}" or "foe ${query}".`);
  return match;
}

function sideOf(state: PerspectiveStateView, own: boolean): Pid {
  return own ? state.pid : state.pid === "p1" ? "p2" : "p1";
}

function findActive(state: PerspectiveStateView, query: string): MonEntry | undefined {
  const found = findMon(state, query);
  return found && !found.benched ? found : undefined;
}

const stageSchema = z.number().int().min(-6).max(6).optional();
const hypotheticalOrder = z.object({
  first_speed_stage: stageSchema,
  second_speed_stage: stageSchema,
  first_tailwind: z.boolean().optional(),
  second_tailwind: z.boolean().optional(),
  trick_room: z.boolean().optional(),
});
const hypotheticalStages = z
  .strictObject({
    atk: stageSchema,
    def: stageSchema,
    spa: stageSchema,
    spd: stageSchema,
    spe: stageSchema,
  })
  .optional();

const CLEAR_WORDS = new Set(["none", "clear", "off", "no", "nothing"]);

/** `undefined` keeps the live field, `null` clears it, a string names the hypothetical condition. */
function fieldOverride(raw: JsonValue | undefined): string | null | undefined {
  const word = text(raw).trim();
  if (!word) return undefined;
  return CLEAR_WORDS.has(stateKey(word)) ? null : word;
}

export function speedProfile(
  state: PerspectiveStateView,
  pid: Pid,
  mon: MonState,
  reference: ShowdownReference,
  overrides: { weather?: string | null; stage?: number; tailwind?: boolean } = {},
): SpeedProfile | undefined {
  const conditions = state.sides[pid].conditions;
  const terrain = [...state.fields.values()].find((effect) => /terrain/i.test(effect.name))?.name;
  const weather = overrides.weather === undefined ? state.weather?.name : overrides.weather;
  const input: SpeedProfileInput = {
    species: mon.species,
    itemConsumed: mon.itemConsumed,
    tailwind: overrides.tailwind ?? conditions.has("tailwind"),
  };
  if (mon.nature !== undefined) input.nature = mon.nature;
  const speed = mon.stats.spe;
  if (pid === state.pid && speed !== undefined && Number.isInteger(speed)) input.exact = speed;
  if (mon.item !== undefined) input.item = mon.item;
  if (mon.ability !== undefined) input.ability = mon.ability;
  if (mon.status !== undefined) input.status = mon.status;
  const stage = overrides.stage ?? mon.boosts.spe;
  if (stage !== undefined) input.boost = stage;
  if (weather) input.weather = weather;
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
  state: PerspectiveStateView,
  args: JsonObject,
  reference: ShowdownReference,
): string {
  const firstName = text(args.first).trim();
  const secondName = text(args.second).trim();
  if (!firstName || !secondName)
    return "first and second are required active Pokémon names or ally/foe slot labels.";
  let first = findMon(state, firstName);
  let second = findMon(state, secondName);
  const active = activeEntries(state).map(
    (entry) => `${entry.pid === state.pid ? "ally" : "foe"} ${entry.slot}: ${entry.mon.species}`,
  );
  if (!first || !second)
    return `Could not resolve ${!first ? JSON.stringify(firstName) : JSON.stringify(secondName)}. Active Pokémon: ${active.join("; ") || "none"}; benched Pokémon may be named directly.`;
  if (first.mon === second.mon) return "first and second must identify different Pokémon.";

  [first, second] = scenarioPair(
    state,
    first,
    second,
    args.first_mega === true,
    args.second_mega === true,
    reference,
  );

  const weather = fieldOverride(args.weather);
  const hypothetical = hypotheticalOrder.parse(args);
  const speedOverrides = (side: "first" | "second") => {
    const overrides: Parameters<typeof speedProfile>[4] = { weather };
    const stage = hypothetical[`${side}_speed_stage`];
    const tailwind = hypothetical[`${side}_tailwind`];
    if (stage !== undefined) overrides.stage = stage;
    if (tailwind !== undefined) overrides.tailwind = tailwind;
    return overrides;
  };
  const firstProfile = speedProfile(
    state,
    first.pid,
    first.mon,
    reference,
    speedOverrides("first"),
  );
  const secondProfile = speedProfile(
    state,
    second.pid,
    second.mon,
    reference,
    speedOverrides("second"),
  );
  if (!firstProfile || !secondProfile)
    return "Speed data is unavailable for one of the selected Pokémon.";
  const firstMove = text(args.first_move).trim();
  const secondMove = text(args.second_move).trim();
  const switchKeys = new Set(["switch", "switchout", "switching", "swap"]);
  const firstIsSwitch = switchKeys.has(stateKey(firstMove));
  const secondIsSwitch = switchKeys.has(stateKey(secondMove));
  if ((firstIsSwitch && args.first_mega === true) || (secondIsSwitch && args.second_mega === true))
    throw new Error("A Pokémon cannot Mega Evolve while switching out.");
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

  const trickRoom = hypothetical.trick_room ?? state.fields.has("trickroom");
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
  const supposed = [
    ...(["first", "second"] as const).flatMap((side) => {
      const name = (side === "first" ? first : second).mon.species;
      const stage = hypothetical[`${side}_speed_stage`];
      const tailwind = hypothetical[`${side}_tailwind`];
      return [
        ...(stage === undefined ? [] : [`${name} at Speed stage ${stage > 0 ? "+" : ""}${stage}`]),
        ...(tailwind === undefined ? [] : [`Tailwind ${tailwind ? "up" : "down"} for ${name}`]),
      ];
    }),
    ...(hypothetical.trick_room === undefined
      ? []
      : [`Trick Room ${hypothetical.trick_room ? "up" : "down"}`]),
  ];
  if (supposed.length) lines.unshift(`Hypothetical: ${supposed.join("; ")}.`);
  if (weather !== undefined)
    lines.unshift(
      `Hypothetical weather: ${weather ?? "none"} (live: ${state.weather?.name ?? "none"}).`,
    );
  if (args.first_mega === true || args.second_mega === true)
    lines.unshift(
      "Hypothetical Mega Evolution: projected forme, ability, and raw stats; current field and boosts held fixed. Ambiguous stats retain legal ranges.",
    );
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

function definedStages(stages: z.infer<typeof hypotheticalStages>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stages ?? {}).flatMap(([stat, stage]) =>
      stage === undefined ? [] : [[stat, stage]],
    ),
  );
}

const ENTRY_WEATHER = new Map([
  ["drought", "sun"],
  ["drizzle", "rain"],
  ["sandstream", "sand"],
  ["snowwarning", "snow"],
]);
const ENTRY_TERRAIN = new Map([
  ["electricsurge", "electric"],
  ["grassysurge", "grassy"],
  ["mistysurge", "misty"],
  ["psychicsurge", "psychic"],
]);

export function estimateDamage(
  state: PerspectiveStateView,
  args: JsonObject,
  reference: ShowdownReference,
): string {
  const attackerName = text(args.attacker).trim();
  const defenderName = text(args.defender).trim();
  const move = text(args.move).trim();
  if (!attackerName || !defenderName || !move) return "attacker, defender, and move are required.";
  let attacker = findMon(state, attackerName);
  let defender = findMon(state, defenderName);
  const fielded = activeEntries(state);
  const label = (entry: MonEntry) =>
    `${entry.pid === state.pid ? "ally" : "foe"} ${entry.slot}: ${entry.mon.species}`;
  const visible = fielded.map(label);
  if (!attacker || !defender) {
    const missing = !attacker ? attackerName : defenderName;
    return `Could not resolve ${JSON.stringify(missing)} on the visible battle rosters. Active Pokémon: ${visible.join("; ") || "none"}.`;
  }
  if (attacker.mon === defender.mon)
    return "attacker and defender must identify different Pokémon.";

  [attacker, defender] = scenarioPair(
    state,
    attacker,
    defender,
    args.attacker_mega === true,
    args.defender_mega === true,
    reference,
  );
  const pair = [attacker, defender] as const;

  /** A benched Pokémon takes a named slot, an empty one, or, when its side is full and no slot is named, each slot it could take. */
  const outgoingOptions = (
    side: "attacker" | "defender",
    entry: FoundMon,
  ): Array<MonEntry | null> => {
    const replaces = text(args[`${side}_replaces`]).trim();
    if (!entry.benched) {
      if (replaces)
        throw new Error(`${entry.mon.species} is already active; omit ${side}_replaces.`);
      return [null];
    }
    const sameSide = fielded.filter((other) => other.pid === entry.pid);
    if (!replaces && sameSide.length < 2) return [null];
    const free = sameSide.filter((other) =>
      pair.every((party) => party.mon.ident !== other.mon.ident),
    );
    if (!replaces) return free;
    const outgoing = findActive(state, replaces);
    if (!outgoing || outgoing.pid !== entry.pid)
      throw new Error(
        `${side}_replaces must name a same-side active Pokémon or slot: ${sameSide.map(label).join("; ")}.`,
      );
    if (!free.includes(outgoing) && !free.some((other) => other.mon === outgoing.mon))
      throw new Error("A switch-in cannot replace the other Pokémon in the damage calculation.");
    return [outgoing];
  };

  const liveTerrain = [...state.fields.values()].find((effect) => /terrain/i.test(effect.name));
  const weatherOverride = fieldOverride(args.weather);
  const terrainOverride = fieldOverride(args.terrain);
  const megas = pair.filter((_, index) => args[index ? "defender_mega" : "attacker_mega"] === true);
  const entryField = (effects: Map<string, string>) => {
    const brought = megas.flatMap((entry) => effects.get(stateKey(entry.mon.ability ?? "")) ?? []);
    return brought.length === 1 ? brought[0] : undefined;
  };
  const megaWeather = weatherOverride === undefined ? entryField(ENTRY_WEATHER) : undefined;
  const megaTerrain = terrainOverride === undefined ? entryField(ENTRY_TERRAIN) : undefined;
  const weather =
    weatherOverride === undefined ? (megaWeather ?? state.weather?.name) : weatherOverride;
  const terrain =
    terrainOverride === undefined ? (megaTerrain ?? liveTerrain?.name) : terrainOverride;
  const fieldNotes = [
    ...(weatherOverride === undefined
      ? []
      : [`weather ${weatherOverride ?? "none"} (live: ${state.weather?.name ?? "none"})`]),
    ...(terrainOverride === undefined
      ? []
      : [`terrain ${terrainOverride ?? "none"} (live: ${liveTerrain?.name ?? "none"})`]),
    ...(megaWeather ? [`${megaWeather} from the Mega Evolution's ability`] : []),
    ...(megaTerrain ? [`${megaTerrain} terrain from the Mega Evolution's ability`] : []),
  ];

  const supposedStages = {
    attacker: definedStages(hypotheticalStages.parse(args.attacker_boosts)),
    defender: definedStages(hypotheticalStages.parse(args.defender_boosts)),
  };
  for (const side of ["attacker", "defender"] as const) {
    const stages = Object.entries(supposedStages[side]).map(
      ([stat, stage]) => `${stage > 0 ? "+" : ""}${stage} ${stat}`,
    );
    if (stages.length) fieldNotes.push(`${side} at ${stages.join(", ")}`);
  }

  const ability = (mon: MonState) =>
    mon.abilitySuppressed ? undefined : (mon.ability ?? reference.speciesAbility(mon.species));
  const faintedOn = (pid: Pid) =>
    [...state.sides[pid].mons.values()].filter((mon) => mon.fainted).length;
  const fallen = (entry: FoundMon) => {
    if (entry.benched) return faintedOn(entry.pid);
    const volatile = [...entry.mon.volatiles].find((name) => /^fallen\d$/.test(stateKey(name)));
    return volatile ? Number(stateKey(volatile).slice(-1)) : 0;
  };
  const moveTarget = reference.moveTarget(move);

  const estimateWith = (active: readonly MonEntry[]): string => {
    const exactStats = (entry: MonEntry, includeHp: boolean) => {
      if (entry.pid !== state.pid) return {};
      const { transientBase } = entry.mon;
      const stats: Record<string, number> = transientBase
        ? reference.formeStats(transientBase, entry.mon.species, entry.mon.stats, entry.mon.nature)
        : { ...entry.mon.stats };
      if (includeHp) {
        const maximum = /\/(\d+)/.exec(entry.mon.hp ?? "")?.[1];
        if (maximum) stats.hp = Number(maximum);
      }
      return stats;
    };
    const authoritative: EstimateDamageArguments = {
      attacker: attacker.mon.species,
      defender: defender.mon.species,
      move,
      weather: weather ?? "none",
      terrain: terrain ?? "none",
    };
    for (const [side, entry] of [
      ["attacker", attacker],
      ["defender", defender],
    ] as const) {
      const monAbility = ability(entry.mon);
      const stats = exactStats(entry, side === "defender");
      if (monAbility) authoritative[`${side}_ability`] = monAbility;
      if (entry.mon.item && !entry.mon.itemConsumed) authoritative[`${side}_item`] = entry.mon.item;
      if (entry.mon.nature) authoritative[`${side}_nature`] = entry.mon.nature;
      if (entry.mon.status) authoritative[`${side}_status`] = entry.mon.status;
      const boosts = { ...entry.mon.boosts, ...supposedStages[side] };
      if (Object.keys(boosts).length) authoritative[`${side}_boosts`] = boosts;
      if (entry.mon.hpPercent !== undefined)
        authoritative[`${side}_hp_percent`] = entry.mon.hpPercent;
      if (Object.keys(stats).length) authoritative[`${side}_stats`] = stats;
      if (entry.mon.types) authoritative[`${side}_types`] = entry.mon.types;
      const ally = active.find(
        (other) => other.pid === entry.pid && other.mon.ident !== entry.mon.ident,
      );
      if (!ally) continue;
      const allyAbility = ability(ally.mon);
      authoritative[`${side}_ally`] = ally.mon.species;
      if (allyAbility) authoritative[`${side}_ally_ability`] = allyAbility;
      if (ally.mon.item && !ally.mon.itemConsumed)
        authoritative[`${side}_ally_item`] = ally.mon.item;
    }
    authoritative.attacker_fainted_allies = faintedOn(attacker.pid);
    authoritative.attacker_fallen = fallen(attacker);
    authoritative.attacker_hits_taken =
      args.attacker_hits_taken === undefined
        ? attacker.benched
          ? 0
          : attacker.mon.timesAttacked
        : Math.max(0, Math.trunc(count(args.attacker_hits_taken)));
    authoritative.fielded_foes = active.filter((entry) => entry.pid !== attacker.pid).length;
    authoritative.fielded_ally = active.some(
      (entry) => entry.pid === attacker.pid && entry.mon.ident !== attacker.mon.ident,
    );
    const screens = [...state.sides[defender.pid].conditions.keys()].filter((condition) =>
      SCREEN_MOVES.has(condition),
    );
    if (screens.length) authoritative.defender_screens = screens;
    if (args.helping_hand === true) authoritative.helping_hand = true;
    if (args.is_critical_hit === true) authoritative.is_critical_hit = true;
    return reference.lookup("estimate_damage", authoritative);
  };

  const scenarios = outgoingOptions("attacker", attacker).flatMap((attackerOut) =>
    outgoingOptions("defender", defender)
      .filter((defenderOut) => !attackerOut || !defenderOut || attackerOut.mon !== defenderOut.mon)
      .map((defenderOut) => {
        const active = [...fielded];
        const switches: string[] = [];
        for (const [entry, outgoing] of [
          [attacker, attackerOut],
          [defender, defenderOut],
        ] as const) {
          if (!entry.benched) continue;
          if (!outgoing) {
            const taken = active.some((other) => other.pid === entry.pid && other.slot === 1);
            active.push({ ...entry, slot: taken ? 2 : 1 });
            switches.push(`${entry.mon.species} fields into an empty slot`);
            continue;
          }
          active[active.findIndex((other) => other.mon === outgoing.mon)] = {
            ...entry,
            slot: outgoing.slot,
          };
          switches.push(`${entry.mon.species} replaces ${outgoing.mon.species}`);
        }
        const foes = active.filter((entry) => entry.pid !== attacker.pid).length;
        const ally = active.some(
          (entry) => entry.pid === attacker.pid && entry.mon.ident !== attacker.mon.ident,
        );
        const lone =
          (moveTarget === "allAdjacentFoes" && foes < 2) ||
          (moveTarget === "allAdjacent" && foes + Number(ally) < 2);
        return { switches, lone, result: estimateWith(active) };
      }),
  );
  if (!scenarios.length)
    throw new Error("No active slot is free for that switch-in in this damage calculation.");

  if (scenarios[0]!.lone)
    fieldNotes.push("single-target power: only one foe is fielded for this estimate");
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
  const scenario = megas.length
    ? "Hypothetical Mega Evolution: projected forme, ability, and raw stats; boosts held fixed, and the field too unless the Mega's ability sets one. Ambiguous stats retain legal ranges. "
    : "";
  const context = `${scenario}Live battle and known team-sheet state applied: ${known(attacker, "attacker")}; ${known(defender, "defender")}.`;
  const fieldContext = fieldNotes.length ? `Hypothetical: ${fieldNotes.join("; ")}.\n` : "";
  const switchNote =
    "Current weather, terrain and boosts held fixed; switch-in events are not simulated.";
  const same = scenarios.every((entry) => entry.result === scenarios[0]!.result);
  const switchContext = !scenarios[0]!.switches.length
    ? ""
    : same && scenarios.length > 1
      ? `Hypothetical switch-in into either slot (the result is the same for each). ${switchNote}\n`
      : same
        ? `Hypothetical switch-in: ${scenarios[0]!.switches.join("; ")}. ${switchNote}\n`
        : `Hypothetical switch-in; the result depends on which Pokémon leaves. ${switchNote}\n`;
  const body = same
    ? scenarios[0]!.result
    : scenarios.map((entry) => `If ${entry.switches.join(" and ")}: ${entry.result}`).join("\n");
  return `${switchContext}${fieldContext}${context}\n${body}`;
}
