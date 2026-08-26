import type { DecisionStats } from "./battle-agent.js";
import type { SlotMenu } from "./choices.js";
import type { BattleState } from "./state.js";
import type { Pid } from "./types.js";

const CONSECUTIVE_DECISION_FAILURE_LIMIT = 3;

export class LLMEngineStats {
  private decisions = 0;
  private fallbacks = 0;
  private reflections = 0;
  private reflectionFallbacks = 0;
  private moveSelections = 0;
  private switchSelections = 0;
  private protectSelections = 0;
  private consecutiveProtectSelections = 0;
  private allyTargetSelections = 0;
  private spreadMoveSelections = 0;
  private megaSelections = 0;
  private toolLookups = 0;
  private repeatedJointActions = 0;
  private teamPreviews = 0;
  private bringChanges = 0;
  private leadChanges = 0;
  private substitutedActions = 0;
  private abandonedDecisions = 0;
  private parseFailures = 0;
  private cost = 0;
  private reasoningTokens = 0;
  private consecutiveDecisionFailures = 0;
  private previousPreview: { brought: string; leads: string } | undefined;
  private previousTurnAction: { gameId: string; turn: number; action: string } | undefined;
  private previousProtect = new Map<string, { gameId: string; turn: number }>();

  abandonedFailure() {
    this.abandonedDecisions += 1;
    this.consecutiveDecisionFailures += 1;
    return {
      count: this.consecutiveDecisionFailures,
      repeated: this.consecutiveDecisionFailures >= CONSECUTIVE_DECISION_FAILURE_LIMIT,
    };
  }

  decision(input: {
    fallback: boolean;
    parseFailures: number;
    usage: Record<string, number> | undefined;
    substituted: boolean;
  }): void {
    if (!input.fallback) this.consecutiveDecisionFailures = 0;
    this.decisions += 1;
    if (input.fallback) this.fallbacks += 1;
    this.parseFailures += input.parseFailures;
    this.cost += input.usage?.cost ?? 0;
    this.reasoningTokens += Math.trunc(input.usage?.reasoning_tokens ?? 0);
    if (input.substituted) this.substitutedActions += 1;
  }

  reflection(fallback: boolean, usage: Record<string, number>): void {
    this.reflections += 1;
    if (fallback) this.reflectionFallbacks += 1;
    this.cost += usage.cost ?? 0;
    this.reasoningTokens += Math.trunc(usage.reasoning_tokens ?? 0);
  }

  tendencies(input: {
    phase: string;
    menus: SlotMenu[];
    choices: number[];
    parts: string[];
    action: string;
    toolLookups: number;
    state: BattleState;
    pid: Pid;
    gameId: string;
  }): void {
    this.toolLookups += input.toolLookups;
    if (input.phase === "team_preview") {
      this.teamPreviews += 1;
      const brought = [...input.parts].sort().join(",");
      const leads = input.parts.slice(0, 2).sort().join(",");
      if (this.previousPreview) {
        if (this.previousPreview.brought !== brought) this.bringChanges += 1;
        if (this.previousPreview.leads !== leads) this.leadChanges += 1;
      }
      this.previousPreview = { brought, leads };
    }
    for (const [slot, part] of input.parts.entries()) {
      const item = input.menus[slot]?.[input.choices[slot]!];
      if (item?.kind === "move") this.moveSelections += 1;
      if (item?.kind === "switch") this.switchSelections += 1;
      if (/ -[12](?:\s|$)/.test(part)) this.allyTargetSelections += 1;
      if (item?.kind === "move" && /\((?:both foes|your side|all adjacent|spread)/.test(item.label))
        this.spreadMoveSelections += 1;
      if (part.endsWith(" mega")) this.megaSelections += 1;

      if (input.phase !== "turn") continue;
      const activeKey =
        input.state.sides[input.pid].active[String.fromCharCode("a".charCodeAt(0) + slot)];
      if (!activeKey) continue;
      const protect = item?.kind === "move" && /^Protect(?:\b|\s)/i.test(item.label);
      const previous = this.previousProtect.get(activeKey);
      if (protect) {
        this.protectSelections += 1;
        if (previous?.gameId === input.gameId && previous.turn === input.state.turn - 1)
          this.consecutiveProtectSelections += 1;
        this.previousProtect.set(activeKey, { gameId: input.gameId, turn: input.state.turn });
      } else this.previousProtect.delete(activeKey);
    }
    if (input.phase === "turn") {
      if (
        this.previousTurnAction?.gameId === input.gameId &&
        this.previousTurnAction.turn === input.state.turn - 1 &&
        this.previousTurnAction.action === input.action
      )
        this.repeatedJointActions += 1;
      this.previousTurnAction = {
        gameId: input.gameId,
        turn: input.state.turn,
        action: input.action,
      };
    } else this.previousTurnAction = undefined;
  }

  snapshot(): DecisionStats {
    const stats: DecisionStats = {
      decisions: this.decisions,
      fallbacks: this.fallbacks,
      reflections: this.reflections,
      reflection_fallbacks: this.reflectionFallbacks,
      move_selections: this.moveSelections,
      switch_selections: this.switchSelections,
      protect_selections: this.protectSelections,
      consecutive_protect_selections: this.consecutiveProtectSelections,
      ally_target_selections: this.allyTargetSelections,
      spread_move_selections: this.spreadMoveSelections,
      mega_selections: this.megaSelections,
      tool_lookups: this.toolLookups,
      repeated_joint_actions: this.repeatedJointActions,
      team_previews: this.teamPreviews,
      bring_changes: this.bringChanges,
      lead_changes: this.leadChanges,
      substituted_actions: this.substitutedActions,
      abandoned_decisions: this.abandonedDecisions,
      parse_failures: this.parseFailures,
    };
    if (this.reasoningTokens > 0) stats.reasoning_tokens = this.reasoningTokens;
    if (this.cost > 0) stats.cost = Math.round(this.cost * 1e6) / 1e6;
    return stats;
  }
}
