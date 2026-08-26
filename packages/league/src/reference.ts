import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Battle, Dex } from "pokemon-showdown";

import { defaultPsDir } from "./paths.js";
import {
  calculateStats,
  calculateStatsArgumentsSchema,
  estimateDamage,
  estimateDamageArgumentsSchema,
  lookupSpeciesArgumentsSchema,
  matchupArgumentsSchema,
  type MatchupArguments,
  type ReferenceCalculationContext,
} from "./reference-calculations.js";
import type {
  CompactMon,
  CompactMonReference,
  MatchupMon,
  ReferenceQuery,
  SpeciesSet,
  SpeedProfile,
  SpeedProfileInput,
} from "./reference-contracts.js";
import {
  baseStats,
  canonicalWeather,
  cleanDescription,
  effectivenessDetail,
  effectivenessLabel,
  id,
  investmentLimits,
  modifyRange,
  SPEED_HALVING_ITEMS,
  speciesMoveType,
  statRange,
  TARGET_TAGS,
  typeModifier,
  uniqueNames,
  visibleDamageBlock,
  weatherBallOverride,
} from "./reference-mechanics.js";
import { loadShowdown, type ShowdownApi, showdownCommit } from "./showdown.js";
import type { JsonObject } from "./types.js";

export { DEX_TOOLS } from "./reference-contracts.js";
export type {
  CompactMon,
  CompactMonReference,
  MatchupMon,
  ReferenceQuery,
  SpeedProfile,
  SpeedProfileInput,
} from "./reference-contracts.js";
export type { EstimateDamageArguments } from "./reference-calculations.js";

const REFERENCE_RENDER_DIGEST_PROTOCOL = "showdown-reference-render-v1";

type FormatDataKind = "move" | "item";

export class ShowdownReference {
  private readonly dex;
  private readonly battle: Battle;
  private readonly showdown: ShowdownApi;
  private readonly resolvedFormat: ReturnType<ShowdownApi["Dex"]["formats"]["get"]>;

  constructor(
    readonly format: string,
    readonly psDir = defaultPsDir(),
  ) {
    this.showdown = loadShowdown(psDir);
    this.resolvedFormat = this.showdown.Dex.formats.get(format);
    this.dex = this.showdown.Dex.forFormat(this.resolvedFormat);
    this.battle = new this.showdown.Battle({
      formatid: this.resolvedFormat.id,
      format: this.resolvedFormat,
    });
  }

  get revision(): string {
    return showdownCommit(this.psDir).slice(0, 12);
  }

  speciesAbility(name: string): string | undefined {
    const species = this.getSpecies(name);
    if (!species.exists) return undefined;
    const abilities = uniqueNames(Object.values(species.abilities));
    return abilities.length === 1 ? abilities[0] : undefined;
  }

  moveTarget(name: string): string | undefined {
    const move = this.dex.moves.get(name);
    return move.exists ? move.target : undefined;
  }

  static renderRevision(): string {
    return createHash("sha256")
      .update(REFERENCE_RENDER_DIGEST_PROTOCOL)
      .update("\0")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex")
      .slice(0, 12);
  }

  renderCompact(mons: CompactMon[]): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const mon of mons) {
      const species = this.dex.species.get(mon.species);
      if (!species.exists) continue;
      const key = `${species.id}|${id(mon.nature ?? "")}|${id(mon.item ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reference = this.describeCompact(mon);
      if (!reference) continue;
      const moves = uniqueNames(mon.moves ?? []).flatMap((moveName) => {
        const detail = reference.moves[id(moveName)];
        return detail ? [`${moveName} ${detail}`] : [];
      });
      const active = mon.active ? "active; " : "";
      lines.push(
        `- ${species.name}: ${reference.types}; ${active}raw Speed ${reference.speed}${mon.item ? `; item ${mon.item}` : ""}${
          reference.mega ? ` (${reference.mega})` : ""
        }${moves.length ? `; moves ${moves.join(", ")}` : ""}`,
      );
    }
    return lines.length
      ? [`Compact Showdown reference (${this.format}, commit ${this.revision}):`, ...lines]
      : [];
  }

  describeCompact(mon: CompactMon): CompactMonReference | undefined {
    const species = this.dex.species.get(mon.species);
    if (!species.exists) return undefined;
    const nature = mon.nature ? this.dex.natures.get(mon.nature) : undefined;
    const knownNature = nature?.exists ? nature : undefined;
    const [low, high] = statRange(this.battle, species.baseStats, knownNature, "spe");
    const moves = Object.fromEntries(
      uniqueNames(mon.moves ?? []).flatMap((moveName) => {
        const move = this.dex.moves.get(moveName);
        if (!move.exists) return [];
        const power = move.basePower ? String(move.basePower) : "no power";
        const moveType = speciesMoveType(move.id, move.type, species.name);
        const details = [`${moveType}/${move.category}/${power}`];
        if (move.target !== "normal") details.push(TARGET_TAGS.get(move.target) ?? move.target);
        if (move.priority) details.push(`priority ${move.priority > 0 ? "+" : ""}${move.priority}`);
        if (move.accuracy !== true && move.accuracy < 100)
          details.push(`accuracy ${move.accuracy}%`);
        if (move.flags.powder)
          details.push(
            "powder: fails on Grass types, Overcoat, and Safety Goggles (including redirection)",
          );
        return [[move.id, details.join("/")]];
      }),
    );
    const mega: string[] = [];
    const item = mon.item ? this.dex.items.get(mon.item) : undefined;
    if (item?.exists && item.megaStone) {
      for (const formeName of species.otherFormes ?? []) {
        const forme = this.dex.species.get(formeName);
        if (!forme.exists || !/^Mega(?:-|$)/.test(forme.forme)) continue;
        const target = item.megaStone[species.name];
        if (id(target ?? "") !== id(forme.name)) continue;
        const [megaLow, megaHigh] = statRange(this.battle, forme.baseStats, knownNature, "spe");
        mega.push(
          `if Mega Evolved -> ${forme.name}: ${forme.types.join("/")}, ability ${uniqueNames(Object.values(forme.abilities)).join("/")}, ${baseStats(forme.baseStats)}, raw Speed ${megaLow}-${megaHigh}`,
        );
      }
    }
    const reference: CompactMonReference = {
      types: species.types.join("/"),
      speed: `${low}-${high}`,
      moves,
    };
    if (mega.length) reference.mega = mega.join("; ");
    return reference;
  }

  speedProfile(input: SpeedProfileInput): SpeedProfile | undefined {
    const species = this.dex.species.get(input.species);
    if (!species.exists) return undefined;
    const nature = input.nature ? this.dex.natures.get(input.nature) : undefined;
    const exact = Number.isInteger(input.exact) && (input.exact ?? 0) > 0 ? input.exact : undefined;
    const raw: [number, number] =
      exact === undefined
        ? statRange(this.battle, species.baseStats, nature?.exists ? nature : undefined, "spe")
        : [exact, exact];
    const stage = Math.max(-6, Math.min(6, Math.trunc(input.boost ?? 0)));
    let effective = stage >= 0 ? modifyRange(raw, 2 + stage, 2) : modifyRange(raw, 2, 2 - stage);
    const modifiers: string[] = [];
    if (stage) modifiers.push(`Speed stage ${stage > 0 ? "+" : ""}${stage}`);

    const fallbackAbility = Object.values(species.abilities)[0];
    const ability = id(input.ability || fallbackAbility || "");
    const weather = canonicalWeather(input.weather ?? "");
    const terrain = id(input.terrain ?? "");
    let numerator = 1;
    let denominator = 1;
    const multiply = (label: string, top: number, bottom = 1) => {
      numerator *= top;
      denominator *= bottom;
      modifiers.push(label);
    };
    if (
      (ability === "chlorophyll" && ["sun", "sunnyday", "desolateland"].includes(weather)) ||
      (ability === "swiftswim" && ["rain", "raindance", "primordialsea"].includes(weather)) ||
      (ability === "sandrush" && ["sand", "sandstorm"].includes(weather)) ||
      (ability === "slushrush" && ["hail", "snow", "snowscape"].includes(weather))
    )
      multiply(`${input.ability || fallbackAbility} ×2`, 2);
    if (ability === "surgesurfer" && ["electricterrain", "electric"].includes(terrain))
      multiply(`${input.ability || fallbackAbility} ×2`, 2);
    if (ability === "quickfeet" && input.status)
      multiply(`${input.ability || fallbackAbility} ×1.5`, 3, 2);
    if (ability === "unburden" && input.itemConsumed)
      multiply(`${input.ability || fallbackAbility} ×2`, 2);

    const item = input.itemConsumed ? "" : id(input.item ?? "");
    if (item === "choicescarf") multiply("Choice Scarf ×1.5", 3, 2);
    else if (SPEED_HALVING_ITEMS.has(item)) multiply(`${input.item} ×0.5`, 1, 2);
    if (input.tailwind) multiply("Tailwind ×2", 2);
    if (id(input.status ?? "") === "par" && ability !== "quickfeet")
      multiply("paralysis ×0.5", 1, 2);
    effective = modifyRange(effective, numerator, denominator);
    return { raw, effective, modifiers };
  }

  movePriority(name: string): number | undefined {
    const move = this.dex.moves.get(name);
    return move.exists ? move.priority : undefined;
  }

  priorityProfile(
    name: string,
    context: {
      ability?: string;
      item?: string;
      itemConsumed?: boolean;
      fullHp?: boolean;
      grassyTerrain?: boolean;
    },
  ): { priority: number; notes: string[]; unresolved?: string } | undefined {
    const move = this.dex.moves.get(name);
    if (!move.exists) return undefined;
    let priority = move.priority;
    const notes: string[] = [];
    let unresolved: string | undefined;
    const ability = id(context.ability ?? "");
    if (ability === "prankster" && move.category === "Status") {
      priority += 1;
      notes.push("Prankster +1 (fails against Dark-type targets)");
    }
    if (ability === "galewings" && move.type === "Flying") {
      if (context.fullHp === true) {
        priority += 1;
        notes.push("Gale Wings +1 (full HP)");
      } else if (context.fullHp === false) notes.push("Gale Wings inactive (not at full HP)");
      else unresolved = "Gale Wings adds +1 only at full HP; current HP unknown";
    }
    if (ability === "triage" && move.flags.heal) {
      priority += 3;
      notes.push("Triage +3");
    }
    if (ability === "myceliummight" && move.category === "Status")
      notes.push("Mycelium Might: acts last within its bracket");
    if (ability === "stall") notes.push("Stall: acts last within its bracket");
    if (move.id === "grassyglide" && context.grassyTerrain) {
      priority += 1;
      notes.push("Grassy Glide +1 (Grassy Terrain)");
    }
    const item = context.itemConsumed ? "" : id(context.item ?? "");
    if (item === "quickclaw") notes.push("Quick Claw: 20% chance to act first within its bracket");
    if (item === "laggingtail" || item === "fullincense")
      notes.push(`${context.item}: acts last within its bracket`);
    if (unresolved === undefined) return { priority, notes };
    return { priority, notes, unresolved };
  }

  renderActiveMatchups(attackers: MatchupMon[], defenders: MatchupMon[], weather = ""): string[] {
    const lines: string[] = [];
    let examined = false;
    const weatherId = canonicalWeather(weather);
    for (const attacker of attackers) {
      const species = this.dex.species.get(attacker.species);
      if (!species.exists) continue;
      for (const moveName of uniqueNames(attacker.moves)) {
        const move = this.dex.moves.get(moveName);
        if (!move.exists || move.category === "Status" || !move.type || move.type === "???")
          continue;
        const override = weatherBallOverride(move.id, weatherId);
        const speciesType = speciesMoveType(move.id, move.type, species.name);
        const moveType =
          override?.type ??
          speciesMoveType(
            move.id,
            move.type,
            species.name,
            attacker.ability ?? "",
            !!move.flags.sound,
          );
        const abilityConverted = !override && moveType !== speciesType && attacker.ability;
        const typeLabel = override
          ? `currently ${override.type} in ${weather}`
          : moveType !== move.type
            ? `currently ${moveType} for ${species.name}${abilityConverted ? ` (${attacker.ability})` : ""}`
            : moveType;
        const bits: string[] = [];
        for (const defender of defenders) {
          if (
            attacker.ally !== undefined &&
            defender.ally !== undefined &&
            attacker.ally === defender.ally
          )
            continue;
          const target = this.dex.species.get(defender.species);
          if (!target.exists) continue;
          examined = true;
          const modifier = typeModifier(this.dex, moveType, target.types);
          const blockedBy = visibleDamageBlock(attacker, defender, move, moveType, modifier);
          if (blockedBy)
            bits.push(
              `${target.name} immune via ${blockedBy} (type chart ${effectivenessLabel(modifier)})`,
            );
          else if (modifier !== 1) bits.push(`${target.name} ${effectivenessLabel(modifier)}`);
        }
        if (bits.length)
          lines.push(`- ${species.name} ${move.name} (${typeLabel}): ${bits.join("; ")}`);
      }
    }
    if (examined) lines.push("- Damaging matchups not listed above are neutral (1x).");
    return lines;
  }

  render(query: ReferenceQuery = {}): string[] {
    const speciesSets = query.speciesSets ?? [];
    const moves = uniqueNames(query.moves ?? []);
    const items = uniqueNames([...(query.items ?? []), ...speciesSets.map((set) => set[1])]);
    const abilities = uniqueNames(query.abilities ?? []);
    const natures = uniqueNames([...(query.natures ?? []), ...speciesSets.map((set) => set[2])]);
    const lines: string[] = [];

    const speciesGroups = new Map<string, { species: Dex.Species; sets: SpeciesSet[] }>();
    for (const set of speciesSets) {
      const species = this.getSpecies(set[0]);
      if (!species.exists) continue;
      const group = speciesGroups.get(species.id) ?? { species, sets: [] };
      if (
        !group.sets.some(
          (current) => JSON.stringify(current.slice(1)) === JSON.stringify(set.slice(1)),
        )
      )
        group.sets.push(set);
      speciesGroups.set(species.id, group);
    }
    const fixedIvs = investmentLimits(this.battle).fixedIvs;
    for (const { species, sets } of [...speciesGroups.values()].sort((a, b) =>
      id(a.species.name).localeCompare(id(b.species.name)),
    )) {
      const abilityNames = uniqueNames(Object.values(species.abilities));
      const details = [
        species.types.join("/"),
        baseStats(species.baseStats),
        ...(abilityNames.length ? [`abilities ${abilityNames.join("/")}`] : []),
      ];
      if (species.forme) details.push(`forme ${species.forme}`);
      for (const [, , natureName] of sets) {
        const nature = natureName ? this.dex.natures.get(natureName) : undefined;
        const knownNature = nature?.exists ? nature : undefined;
        const [low, high] = statRange(this.battle, species.baseStats, knownNature, "spe");
        const detail = knownNature
          ? `raw Speed ${low}-${high} with ${knownNature.name} alignment (${fixedIvs ? "fixed maximum IV/Stat Point range" : "full legal IV/EV range"})`
          : `raw Speed ${low}-${high} (${fixedIvs ? "fixed maximum IV/Stat Point/nature range" : "full legal IV/EV/nature range"})`;
        if (!details.includes(detail)) details.push(detail);
      }
      for (const itemName of uniqueNames(sets.map((set) => set[1]))) {
        const item = this.dex.items.get(itemName);
        if (!item.exists || !item.megaStone) continue;
        for (const formeName of species.otherFormes ?? []) {
          const mega = this.dex.species.get(formeName);
          if (!mega.exists || !/^Mega(?:-|$)/.test(mega.forme)) continue;
          const target = item.megaStone[species.name];
          if (id(target ?? "") !== id(mega.name)) continue;
          const ranges = sets.flatMap(([, visibleItem, natureName]) => {
            if (id(visibleItem ?? "") !== id(itemName)) return [];
            const nature = natureName ? this.dex.natures.get(natureName) : undefined;
            const knownNature = nature?.exists ? nature : undefined;
            const [low, high] = statRange(this.battle, mega.baseStats, knownNature, "spe");
            return [
              `raw Speed ${low}-${high}${knownNature ? ` with ${knownNature.name} alignment` : ""}`,
            ];
          });
          const megaAbilities = uniqueNames(Object.values(mega.abilities));
          for (const ability of megaAbilities)
            if (!abilities.some((current) => id(current) === id(ability))) abilities.push(ability);
          details.push(
            `with ${item.name} -> ${mega.name} (${mega.types.join("/")}, ${baseStats(mega.baseStats)}, abilities ${megaAbilities.join("/")}${ranges.length ? `; ${[...new Set(ranges)].sort().join(", ")}` : ""})`,
          );
        }
      }
      lines.push(`- Species ${species.name}: ${details.join("; ")}`);
    }

    for (const name of moves) {
      const move = this.dex.moves.get(name);
      if (!move.exists) continue;
      const details = [
        move.type,
        move.category,
        move.basePower ? `BP ${move.basePower}` : "BP none",
        move.accuracy === true ? "always hits" : `acc ${move.accuracy}%`,
        `priority ${move.priority >= 0 ? "+" : ""}${move.priority}`,
        `target ${move.target}`,
      ];
      if (move.flags.powder)
        details.push(
          "powder move: no effect on Grass types, Overcoat, or Safety Goggles holders (including redirection)",
        );
      if (move.flags.sound) details.push("sound move: blocked by Soundproof, bypasses Substitute");
      const description = cleanDescription(move.desc || move.shortDesc);
      if (description) details.push(description);
      lines.push(`- Move ${move.name}: ${details.join("; ")}`);
    }
    for (const name of items) {
      const item = this.dex.items.get(name);
      const description = item.exists ? cleanDescription(item.desc || item.shortDesc) : "";
      if (description) lines.push(`- Item ${item.name}: ${description}`);
    }
    for (const name of abilities) {
      const ability = this.dex.abilities.get(name);
      const description = ability.exists ? cleanDescription(ability.desc || ability.shortDesc) : "";
      if (description) lines.push(`- Ability ${ability.name}: ${description}`);
    }
    for (const name of natures) {
      const nature = this.dex.natures.get(name);
      if (!nature.exists) continue;
      lines.push(
        nature.plus && nature.minus
          ? `- Stat alignment ${nature.name} (Showdown Nature): +${nature.plus}, -${nature.minus}`
          : `- Stat alignment ${nature.name} (Showdown Nature): neutral`,
      );
    }
    return lines.length
      ? [`Showdown reference (${this.format}, commit ${this.revision}):`, ...lines]
      : [];
  }

  lookup(name: string, args: JsonObject = {}): string {
    const speciesArguments = lookupSpeciesArgumentsSchema.parse(args);
    const value = speciesArguments.name;
    if (name === "lookup_species") {
      return this.lookupSpecies(value, speciesArguments.item, speciesArguments.nature);
    }
    if (name === "lookup_move") {
      return (
        this.formatLegalityError("move", value) ?? this.lookupOne("Move", value, { moves: [value] })
      );
    }
    if (name === "lookup_item") {
      return (
        this.formatLegalityError("item", value) ?? this.lookupOne("Item", value, { items: [value] })
      );
    }
    if (name === "lookup_learnset") return this.lookupLearnset(value);
    if (name === "lookup_ability") return this.lookupOne("Ability", value, { abilities: [value] });
    if (name === "calculate_stats")
      return calculateStats(this.calculationContext(), calculateStatsArgumentsSchema.parse(args));
    if (name === "lookup_matchup") return this.lookupMatchup(matchupArgumentsSchema.parse(args));
    if (name === "estimate_damage")
      return estimateDamage(this.calculationContext(), estimateDamageArgumentsSchema.parse(args));
    return `Unknown tool: ${name}`;
  }

  private calculationContext(): ReferenceCalculationContext {
    return {
      format: this.format,
      dex: this.dex,
      battle: this.battle,
      showdown: this.showdown,
      resolvedFormat: this.resolvedFormat,
      getSpecies: (name) => this.getSpecies(name),
      formatLegalityError: (kind, name) => this.formatLegalityError(kind, name),
    };
  }

  private formatLegalityError(kind: FormatDataKind, name: string): string | null {
    if (!name.trim()) return null;
    const data = kind === "move" ? this.dex.moves.get(name) : this.dex.items.get(name);
    if (!data.exists) return null;
    const banned = this.battle.ruleTable.has(`-${kind}:${data.id}`);
    return data.isNonstandard || banned ? `${data.name} is not legal in ${this.format}.` : null;
  }

  private getSpecies(name: string): Dex.Species {
    const direct = this.dex.species.get(name);
    if (direct.exists || !name.trim()) return direct;
    const candidates = [
      name.replace(/-Male$/i, ""),
      name.replace(/-Female$/i, "-F"),
      name.replace(/^Mega (.+?)(?: ([XY]))?$/i, (_, base, xy) =>
        xy ? `${base}-Mega-${xy}` : `${base}-Mega`,
      ),
      name.replace(/^Paldean (.+?)(?: (Aqua|Blaze|Combat))?$/i, (_, base, breed) =>
        breed ? `${base}-Paldea-${breed}` : `${base}-Paldea`,
      ),
    ];
    for (const candidate of candidates) {
      if (candidate === name) continue;
      const species = this.dex.species.get(candidate);
      if (species.exists) return species;
    }
    return direct;
  }

  private lookupSpecies(name: string, item?: string, nature?: string): string {
    if (!name.trim()) return "Species name is required.";
    if (item) {
      const error = this.formatLegalityError("item", item);
      if (error) return error;
    }
    const lines = this.render({
      speciesSets: [[name, item?.trim() ? item : null, nature?.trim() ? nature : null]],
    });
    return (
      lines.find((line) => line.startsWith("- Species ")) ??
      `No species data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }

  private lookupLearnset(name: string): string {
    if (!name.trim()) return "Species name is required.";
    const species = this.getSpecies(name);
    if (!species.exists) return `No species data for ${JSON.stringify(name)} in ${this.format}.`;
    const moves: string[] = [];
    for (const moveId of this.dex.species.getMovePool(species.id)) {
      const move = this.dex.moves.get(moveId);
      if (move.exists && !move.isNonstandard) moves.push(move.name);
    }
    moves.sort();
    return `- Learnset ${species.name} (${moves.length} legal moves): ${moves.join(", ")}`;
  }

  private lookupMatchup(args: MatchupArguments): string {
    const defenderName = args.defender;
    if (!defenderName.trim()) return "defender is required.";
    const defender = this.getSpecies(defenderName);
    if (!defender.exists)
      return `No species data for ${JSON.stringify(defenderName)} in ${this.format}.`;
    const attackerName = args.attacker;
    const attacker = attackerName ? this.getSpecies(attackerName) : undefined;
    let attackType = args.attacker_type;
    let moveName = args.move;
    let typeNote = "";
    if (moveName.trim()) {
      const move = this.dex.moves.get(moveName);
      if (!move.exists) return `No move data for ${JSON.stringify(moveName)} in ${this.format}.`;
      const error = this.formatLegalityError("move", moveName);
      if (error) return error;
      if (move.id === "ragingbull" && !attacker?.exists)
        return "attacker is required to resolve Raging Bull typing.";
      attackType = speciesMoveType(move.id, move.type, attacker?.name ?? "");
      if (attacker?.exists) {
        const abilities = [
          ...new Set(Object.values(attacker.abilities).flatMap((entry) => (entry ? [entry] : []))),
        ];
        const conversions = abilities.flatMap((abilityName) => {
          const converted = speciesMoveType(
            move.id,
            move.type,
            attacker.name,
            abilityName,
            !!move.flags.sound,
          );
          return converted === attackType ? [] : [{ abilityName, converted }];
        });
        const onlyConversion = conversions.length === 1 ? conversions[0] : undefined;
        if (onlyConversion && abilities.length === 1) {
          attackType = onlyConversion.converted;
          typeNote = ` via ${onlyConversion.abilityName}`;
        } else if (conversions.length) {
          typeNote = ` (${conversions
            .map((entry) => `${entry.abilityName} would make it ${entry.converted}`)
            .join("; ")})`;
        }
      }
      moveName = move.name;
    }
    if (!attackType.trim()) {
      if (attacker?.exists) {
        const perType = attacker.types.map(
          (type) => `${type}: ${effectivenessDetail(this.dex, type, defender.types)}`,
        );
        return `${attacker.name} types into ${defender.name} (${defender.types.join("/")}): ${perType.join(" | ")}.`;
      }
      return "Provide move or attacker_type.";
    }
    const type = this.dex.types.get(attackType);
    if (!type.exists) return `No type data for ${JSON.stringify(attackType)}.`;
    const source = moveName ? `${moveName} (${type.name}${typeNote})` : type.name;
    return `${source} into ${defender.name} (${defender.types.join("/")}): ${effectivenessDetail(this.dex, type.name, defender.types)}.`;
  }

  private lookupOne(
    kind: string,
    name: string,
    query: ReferenceQuery,
    prefix = `- ${kind} `,
  ): string {
    if (!name.trim()) return `${kind} name is required.`;
    return (
      this.render(query).find((line) => line.startsWith(prefix)) ??
      `No ${kind.toLowerCase()} data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }
}
