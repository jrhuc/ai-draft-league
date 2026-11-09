import type { Dex } from "pokemon-showdown";
import { z } from "zod";

import {
  type EstimateDamageArguments,
  prepareDamage,
  type ReferenceCalculationContext,
} from "./reference-calculations.js";
import { filledStats, id, investmentLimits, statSet } from "./reference-mechanics.js";

const nameListSchema = z.array(z.string()).optional().catch(undefined);

export const findSpeciesArgumentsSchema = z.object({
  moves: nameListSchema,
  types: nameListSchema,
  abilities: nameListSchema,
});

type FindSpeciesArguments = z.infer<typeof findSpeciesArgumentsSchema>;

export function findSpecies(context: ReferenceCalculationContext, args: FindSpeciesArguments) {
  const moves: Dex.Move[] = [];
  for (const raw of args.moves ?? []) {
    const move = context.dex.moves.get(raw);
    if (!move.exists) return `No move data for ${JSON.stringify(raw)}.`;
    const error = context.formatLegalityError("move", raw);
    if (error) return error;
    moves.push(move);
  }
  const types: string[] = [];
  for (const raw of args.types ?? []) {
    const type = context.dex.types.get(raw);
    if (!type.exists) return `No type ${JSON.stringify(raw)}.`;
    types.push(type.name);
  }
  const abilities: Dex.Ability[] = [];
  for (const raw of args.abilities ?? []) {
    const ability = context.dex.abilities.get(raw);
    if (!ability.exists) return `No ability data for ${JSON.stringify(raw)}.`;
    abilities.push(ability);
  }
  if (!moves.length && !types.length && !abilities.length)
    return "At least one of moves, types, or abilities is required.";
  const matches: string[] = [];
  for (const species of context.dex.species.all()) {
    if (!species.exists || species.isNonstandard || species.isMega) continue;
    if (context.battle.ruleTable.isBannedSpecies(species)) continue;
    if (types.some((type) => !species.types.includes(type))) continue;
    const owned = Object.values(species.abilities).map((name) => id(String(name)));
    if (abilities.some((ability) => !owned.includes(ability.id))) continue;
    if (moves.length) {
      const pool = context.dex.species.getMovePool(species.id);
      if (moves.some((move) => !pool.has(move.id))) continue;
    }
    matches.push(`${species.name} (${species.types.join("/")})`);
  }
  const criteria = [
    moves.length ? `moves ${moves.map((move) => move.name).join(" + ")}` : "",
    types.length ? `type ${types.join("/")}` : "",
    abilities.length ? `ability ${abilities.map((ability) => ability.name).join(" + ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return matches.length
    ? `- ${matches.length} species in ${context.format} with ${criteria} (Mega formes listed under their base species): ${matches.join(", ")}`
    : `- No species in ${context.format} with ${criteria}.`;
}

interface Spread {
  hp: number;
  def: number;
  stats: Dex.StatsTable;
  damage: number;
}

export function bulkToSurvive(
  context: ReferenceCalculationContext,
  args: EstimateDamageArguments,
): string {
  const { error, plan } = prepareDamage(context, args);
  if (plan === undefined) return error;
  const { attacker, defender, move, defStat } = plan;
  if (plan.offFromDefender)
    return `${move.name} attacks with the defender's own stat, so bulk cannot be searched.`;
  const limits = investmentLimits(context.battle);
  const step = limits.fixedIvs ? 1 : 4;
  const allNatures = context.dex.natures.all();
  const natureGroups = args.defender_nature?.trim()
    ? [[context.dex.natures.get(args.defender_nature)]]
    : [
        [allNatures.find((nature) => !nature.plus)!],
        allNatures.filter((nature) => nature.plus === defStat),
      ];
  const damageByDefense = new Map<number, number>();
  let outcome: string | undefined;
  const maxDamage = (defValue: number): number => {
    const cached = damageByDefense.get(defValue);
    if (cached !== undefined) return cached;
    const hit = plan.run(plan.offHigh, defValue, plan.hpHigh, 100, false);
    if (hit.outcome !== "damage") outcome = hit.outcome;
    damageByDefense.set(defValue, hit.damage);
    return hit.damage;
  };
  const lines: string[] = [];
  for (const group of natureGroups) {
    const [nature] = group;
    if (!nature) continue;
    let best: Spread | undefined;
    let fullest: Spread | undefined;
    for (let def = 0; def <= limits.perStat; def += step) {
      for (let hp = 0; hp <= limits.perStat; hp += step) {
        if (limits.total !== null && hp + def > limits.total) continue;
        const stats = context.battle.spreadModify(
          defender.baseStats,
          statSet(
            context.battle,
            nature.name,
            { ...filledStats(0), hp, [defStat]: def },
            filledStats(31),
          ),
        );
        const damage = maxDamage(stats[defStat]);
        if (outcome) break;
        const spread: Spread = { hp, def, stats, damage };
        if (!fullest || stats.hp - damage > fullest.stats.hp - fullest.damage) fullest = spread;
        if (damage >= stats.hp) continue;
        if (
          !best ||
          hp + def < best.hp + best.def ||
          (hp + def === best.hp + best.def && stats.hp - damage > best.stats.hp - best.damage)
        )
          best = spread;
      }
      if (outcome) break;
    }
    if (outcome) break;
    const label = args.defender_nature?.trim()
      ? nature.name
      : nature.plus
        ? `${group.map((entry) => entry.name).join("/")} (+${defStat})`
        : "neutral nature";
    const unit = limits.fixedIvs ? "Stat Points" : "EVs";
    const describe = (spread: Spread) =>
      `HP ${spread.hp} / ${defStat} ${spread.def} ${unit} (raw HP ${spread.stats.hp}, ${defStat} ${spread.stats[defStat]}) takes at most ${spread.damage} (${Math.round((spread.damage / spread.stats.hp) * 1000) / 10}%)`;
    lines.push(
      best
        ? `- ${label}: survives from ${describe(best)}.`
        : `- ${label}: never survives; the best it reaches is ${describe(fullest!)}.`,
    );
  }
  if (outcome === "immune" || outcome === "blocked")
    return `${attacker.name} ${move.name} into ${defender.name}: ${outcome === "immune" ? "immune or absorbed" : "blocked"}; nothing to survive.`;
  if (outcome) return `${move.name} has no standard damage output to estimate.`;
  const attackBasis =
    plan.exactOff !== undefined
      ? `${plan.offStat} ${plan.exactOff} exact from request`
      : `legal maximum ${plan.offStat} ${plan.offHigh}`;
  const notes = plan.notes.length ? ` Notes: ${plan.notes.join("; ")}.` : "";
  return `${attacker.name} ${move.name} into ${defender.name}, max roll with ${attackBasis}, cheapest surviving investment at full HP before survival effects:\n${lines.join("\n")}${notes}`;
}
