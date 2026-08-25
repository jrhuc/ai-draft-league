import { PROTECT_MOVES } from './state.js';
import type { BattleMoveRequest, BattlePokemonRequest, BattleRequest } from './types.js';

import { afterColon } from './value.js';

type MenuKind = 'move' | 'switch' | 'team' | 'pass' | 'forfeit';
interface MenuItem {
  label: string;
  part: string;
  kind: MenuKind;
}
export type SlotMenu = MenuItem[];
export type TargetNames = Record<'foe' | 'ally', Record<number, string>>;

export interface MenuHints {
  names?: TargetNames;
  /** Per active slot: whether consecutive Protect odds are reduced. */
  protectReduced?: Record<number, boolean>;
  moveAnnotation?: (slot: number, move: string, targetSide: 'foe' | 'ally', targetNumber: number) => string | undefined;
}

const SELECTED_TARGETS = new Set(['normal', 'any', 'adjacentFoe']);
const SPREAD_TARGETS = new Set(['allySide', 'foeSide', 'all', 'allAdjacent', 'allAdjacentFoes', 'allies']);

function pokemonSpecies(pokemon: BattlePokemonRequest): string {
  const fromDetails = pokemon.details?.split(',', 1)[0]?.trim();
  if (fromDetails) return fromDetails;
  return afterColon(pokemon.ident ?? '') || 'Pokémon';
}

function switches(request: BattleRequest, reviving = false): SlotMenu {
  const menu: SlotMenu = [];
  for (const [index, pokemon] of (request.side?.pokemon ?? []).entries()) {
    const fainted = pokemon.condition?.endsWith(' fnt') ?? false;
    if ((!reviving && pokemon.active) || fainted !== reviving) continue;
    menu.push({ label: `Switch to ${pokemonSpecies(pokemon)}`, part: `switch ${index + 1}`, kind: 'switch' });
  }
  return menu;
}

function spreadLabel(target: string, slot: number, names?: TargetNames): string {
  if (target === 'allAdjacentFoes' || target === 'foeSide') return ' (both foes)';
  if (target === 'allies' || target === 'allySide') {
    const ally = slot === 1 ? 2 : 1;
    const species = names?.ally[ally];
    return species ? ` (your side, including ally ${species})` : ' (your side)';
  }
  if (target === 'allAdjacent' || target === 'all') {
    const ally = slot === 1 ? 2 : 1;
    const species = names?.ally[ally];
    return species ? ` (all adjacent, including ally ${species})` : ' (all adjacent, including ally)';
  }
  return ' (spread)';
}

function moveItems(
  move: BattleMoveRequest,
  moveSlot: number,
  slot: number,
  activeCount: number,
  hasAlly: boolean,
  mega: boolean,
  hints?: MenuHints,
): SlotMenu {
  const target = move.target ?? '';
  const names = hints?.names;
  const targetLabel = (side: 'foe' | 'ally', number: number) => {
    const species = names?.[side][number];
    return ` -> ${side} ${number}${species ? ` (${species})` : ''}`;
  };
  let targets: Array<[string, string]> = [['', '']];
  if (activeCount > 1 && SELECTED_TARGETS.has(target)) {
    targets = [1, 2].map((number) => [` +${number}`, targetLabel('foe', number)]);
    if ((target === 'normal' || target === 'any') && hasAlly) {
      const ally = slot === 1 ? 2 : 1;
      targets.push([` -${ally}`, targetLabel('ally', ally)]);
    }
  } else if (activeCount > 1 && target === 'adjacentAlly') {
    const ally = slot === 1 ? 2 : 1;
    targets = hasAlly ? [[` -${ally}`, targetLabel('ally', ally)]] : [];
  } else if (activeCount > 1 && target === 'adjacentAllyOrSelf') {
    const ally = slot === 1 ? 2 : 1;
    targets = [[` -${slot}`, ' -> itself']];
    if (hasAlly) targets.push([` -${ally}`, targetLabel('ally', ally)]);
  }

  const name = move.move || `Move ${moveSlot}`;
  const protectHint =
    PROTECT_MOVES.has(name.toLowerCase().replace(/[^a-z0-9]+/g, '')) && hints?.protectReduced?.[slot]
      ? ' [success rate reduced: Protected last turn]'
      : '';
  const spread = SPREAD_TARGETS.has(target) ? spreadLabel(target, slot, names) : '';
  return targets.flatMap(([targetPart, label]) => {
    const part = `move ${moveSlot}${targetPart}`;
    const selected = /^ ([+-])([12])$/.exec(targetPart);
    const annotation = selected
      ? hints?.moveAnnotation?.(slot, name, selected[1] === '+' ? 'foe' : 'ally', Number(selected[2]))
      : undefined;
    const warning = annotation ? ` [${annotation}]` : '';
    const item: MenuItem = { label: `${name}${spread}${protectHint}${label}${warning}`, part, kind: 'move' };
    return mega ? [item, { label: `${item.label} + Mega Evolve`, part: `${part} mega`, kind: 'move' }] : [item];
  });
}

export function buildMenus(request: BattleRequest, hints?: MenuHints): SlotMenu[] {
  const pokemon = request.side?.pokemon ?? [];
  if (request.wait) return [];
  if (request.teamPreview) {
    const count = request.maxChosenTeamSize || pokemon.length;
    const base = pokemon.map(
      (mon, index): MenuItem => ({ label: `Pick ${pokemonSpecies(mon)}`, part: String(index + 1), kind: 'team' }),
    );
    return Array.from({ length: count }, () => base.slice());
  }
  if (request.forceSwitch) {
    const active = pokemon.filter((mon) => mon.active);
    const menus = request.forceSwitch.map((forced, slot): SlotMenu => {
      if (!forced) return [{ label: 'Pass', part: 'pass', kind: 'pass' }];
      const menu = switches(request, Boolean(active[slot]?.reviving));
      return menu.length ? menu : [{ label: 'Pass', part: 'pass', kind: 'pass' }];
    });
    const forced = request.forceSwitch.flatMap((value, index) => (value ? [index] : []));
    const targets = new Set(
      menus.flatMap((menu) => menu.filter((item) => item.kind === 'switch').map((item) => item.part)),
    );
    if (targets.size < forced.length) {
      for (const index of forced) {
        const menu = menus[index]!;
        if (!menu.some((item) => item.kind === 'pass')) menu.push({ label: 'Pass', part: 'pass', kind: 'pass' });
      }
    }
    if (menus.some((menu) => menu.some((item) => item.kind === 'switch')))
      menus[0]!.push({ label: 'Forfeit the game (concede the loss)', part: 'forfeit', kind: 'forfeit' });
    return menus;
  }
  const activeRequests = request.active;
  if (activeRequests) {
    const activePokemon = pokemon.filter((mon) => mon.active);
    const menus = activeRequests.map((active, slotIndex): SlotMenu => {
      const slot = slotIndex + 1;
      const current = activePokemon[slotIndex];
      if (!active || current?.commanding || current?.condition?.endsWith(' fnt')) {
        return [{ label: 'Pass', part: 'pass', kind: 'pass' }];
      }
      const moves = active.moves;
      const allyIndex = slot === 1 ? 1 : 0;
      const ally = activePokemon[allyIndex];
      const hasAlly =
        activeRequests.length > 1 &&
        activeRequests[allyIndex] !== null &&
        ally !== undefined &&
        !ally.commanding &&
        !ally.condition?.endsWith(' fnt');
      const menu = moves.flatMap((move, index) =>
        move.disabled
          ? []
          : moveItems(move, index + 1, slot, activeRequests.length, hasAlly, Boolean(active.canMegaEvo), hints),
      );
      if (moves.length && moves.every((move) => move.disabled))
        menu.push({ label: 'Struggle', part: 'move 1', kind: 'move' });
      if (!active.trapped) menu.push(...switches(request));
      return menu.length ? menu : [{ label: 'Pass', part: 'pass', kind: 'pass' }];
    });
    if (menus.some((menu) => menu.some((item) => item.kind !== 'pass')))
      menus[0]!.push({ label: 'Forfeit the game (concede the loss)', part: 'forfeit', kind: 'forfeit' });
    return menus;
  }
  return [[{ label: 'Pass', part: 'pass', kind: 'pass' }]];
}
