import type { MenuHints, TargetNames } from "./choices.js";
import { BattleState } from "./state.js";
import type { BattleRequest, Pid } from "./types.js";

export function battleMenuHints(
  state: BattleState,
  pid: Pid,
  request: BattleRequest,
): MenuHints | undefined {
  if (request.teamPreview || !request.active) return undefined;
  const names: TargetNames = { foe: {}, ally: {} };
  const foe: Pid = pid === "p1" ? "p2" : "p1";
  for (const [group, sidePid] of [
    ["ally", pid],
    ["foe", foe],
  ] as const) {
    const side = state.sides[sidePid];
    for (const [number, slot] of [
      [1, "a"],
      [2, "b"],
    ] as const) {
      const key = side.active[slot];
      const mon = key ? side.mons.get(key) : undefined;
      if (mon && !mon.fainted) names[group][number] = mon.species;
    }
  }
  if (!Object.keys(names.ally).length) {
    for (const [index, mon] of (request.side?.pokemon ?? [])
      .filter((pokemon) => pokemon.active)
      .entries()) {
      names.ally[index + 1] = BattleState.requestName(mon);
    }
  }
  return {
    names,
    protectReduced: state.protectReducedSlots(),
    moveAnnotation: (_slot, move, targetSide, targetNumber) =>
      state.moveAnnotation(move, targetSide, targetNumber),
  };
}
