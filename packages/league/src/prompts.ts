import {
  type BattleMemory,
  DECISION_NOTE_LIMIT,
  NEXT_GAME_PLAN_CHAR_LIMIT,
  renderStrategicMemory,
  renderVerifiedReferenceMemory,
  SERIES_MEMORY_CHAR_LIMIT,
  TEAM_PLAYBOOK_CHAR_LIMIT,
  VERIFIED_REFERENCE_CHAR_LIMIT,
} from "./battle-memory.js";
import type { SlotMenu } from "./choices.js";

export const MANAGER_CHARGE =
  "The franchise is yours for the whole season: you draft its roster, review it after every week, trade and sign in the transaction windows, and each matchup’s six is built and piloted on your behalf from the roster and memory you leave behind. The goal is not to run the franchise correctly but to win the league: you are judged on results against the other coaches, nothing else.";

export const FORMAT_AUTHORITY_NOTICE =
  "Pokémon Champions and this regulation may postdate your training data. Treat the rules in this prompt and the pinned Pokémon Showdown simulator as authoritative. Do not import mechanics from other Pokémon games or formats. If a mechanic is absent from the rules and legal actions, treat it as unavailable rather than trying to correct the format.";

export type SheetPolicy = "open" | "closed";

export function renderPromptTemplate(
  lines: readonly string[],
  values: ReadonlyArray<readonly [string, string]>,
): string {
  return lines
    .map((line) =>
      values.reduce((rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value), line),
    )
    .join("\n");
}

const SYSTEM_CORE_BEFORE_SHEETS = [
  "You are an expert VGC player in a persistent best-of-three match. Maximize the probability of winning the series.",
  FORMAT_AUTHORITY_NOTICE,
  "Choose only from the legality-filtered numbered menus. Never invent a move, target, switch, effect, immunity, stat, or revealed fact.",
  "Treat both active Pokémon as one joint decision. Targets +1/+2 are foes and -1/-2 are allies; allAdjacent moves also hit your ally unless an ability or type blocks them.",
  "One Mega Evolution is allowed per game; if you brought more than one Mega Stone holder, which of them evolves is your choice.",
  "Within a turn, all switches resolve first, then Mega Evolutions in Speed order, then moves by priority and then Speed; apart from Speed ties the order is deterministic, never random.",
  "On-entry abilities such as weather trigger at the moment their Pokémon switches in or Mega Evolves; simultaneous triggers resolve in Speed order, and a newer weather or terrain replaces the current one.",
];

const SHEET_RULES = {
  open: "Open team sheets reveal sets and natures, but not exact opposing IVs/EVs. Your own request stats are exact; foe damage must stay a range.",
  closed:
    "Team sheets are closed: opposing moves, items, abilities, and natures are unknown until the battle reveals them, and species alone never implies a set. Your own request stats are exact; foe damage must stay a range.",
} satisfies Record<SheetPolicy, string>;

const TOOL_RULES = {
  open: "lookup_matchup reports only the type chart. For actual KO ranges, use estimate_damage: it binds known abilities, items, stats, stages, status, HP, screens, weather, terrain, and both active allies with their abilities from the current battle and open team sheets. Use compare_action_order for Speed order. Trust a tool only for the factors its result says it applied.",
  closed:
    "lookup_matchup reports only the type chart. For actual KO ranges, use estimate_damage: it binds the abilities, items, stats, stages, status, HP, screens, weather, terrain, and both active allies with their abilities that the battle has revealed so far, and treats anything unrevealed as neutral across legal ranges. Use compare_action_order for Speed order. Trust a tool only for the factors its result says it applied.",
} satisfies Record<SheetPolicy, string>;

const NOTEBOOK_RULE = `Your private notebook is a full replacement with team_playbook (maximum ${TEAM_PLAYBOOK_CHAR_LIMIT} characters), series_memory (maximum ${SERIES_MEMORY_CHAR_LIMIT}), and next_game_plan (maximum ${NEXT_GAME_PLAN_CHAR_LIMIT}); the combined strategic limit is ${DECISION_NOTE_LIMIT}. The harness separately retains up to ${VERIFIED_REFERENCE_CHAR_LIMIT} characters of mechanics returned by actual species, move, item, and ability lookups. You cannot write that verified reference memory directly.`;
const NOTEBOOK_OBJECT =
  '{"team_playbook":"transferable facts about piloting your team","series_memory":"facts and tendencies specific to this opponent","next_game_plan":"immediate plan and contingencies for the next game"}';

const RETURN_JSON = "Return only the JSON object requested in the current decision prompt.";

const TIMER_RULE =
  "The battle timer runs while you think and use tools, and your reply is token-capped to what your generation speed fits into the remaining clock — a reply cut off at the cap submits nothing, so match depth to the clock and hurry when the turn timer or bank is short. Batch at most two reference calculations plus one action-order comparison per tool round.";

export function battleSystemPrompt(options: { sheets: SheetPolicy; timed: boolean }): string {
  return [
    ...SYSTEM_CORE_BEFORE_SHEETS,
    SHEET_RULES[options.sheets],
    TOOL_RULES[options.sheets],
    NOTEBOOK_RULE,
    ...(options.timed ? [TIMER_RULE] : []),
    RETURN_JSON,
  ].join("\n");
}

export const SYSTEM = battleSystemPrompt({ sheets: "open", timed: false });

export const TIMED_SYSTEM = battleSystemPrompt({ sheets: "open", timed: true });

const REFLECTION_EVIDENCE =
  "Use only the supplied private battle evidence and authoritative outcome. Do not invent hidden information.";
const REFLECTION_PREVIEW_PLAN =
  "Assess the team-preview plan separately from piloting: whether the four brought, and which Mega Stone holder (if any) you evolved, suited this opponent.";
const REFLECTION_MEMORY_RULE =
  "Rewrite all three notebook fields. Keep transferable own-team lessons in team_playbook, current-opponent evidence in series_memory, and the immediate next-game plan in next_game_plan. Omit current HP, active positions, turn recaps, and repeated roster facts.";
const REFLECTION_RESPONSE = `Respond with exactly one JSON object: {"summary":"why the game was won or lost","adjustment":"what to do better next game","notebook":${NOTEBOOK_OBJECT}}.`;

export const REFLECTION_SYSTEM = [
  "You are reviewing one completed game in a best-of-three VGC series.",
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_EVIDENCE,
  "Identify the main reason for the result and one concrete adjustment for the next game.",
  REFLECTION_PREVIEW_PLAN,
  REFLECTION_MEMORY_RULE,
  REFLECTION_RESPONSE,
].join("\n");

export const TOURNAMENT_REFLECTION_SYSTEM = [
  "You are reviewing one completed game in a best-of-three fixed-team VGC tournament series. If the series continues, the next game is against the same opponent with the same six Pokémon.",
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_EVIDENCE,
  "Identify the main reasons for the result and what, if anything, to keep or change for the next game.",
  REFLECTION_MEMORY_RULE,
  `Respond with exactly one JSON object: {"summary":"why the game was won or lost","adjustment":"what to keep or change next game","notebook":${NOTEBOOK_OBJECT}}.`,
].join("\n");

const SERIES_REFLECTION_OVER =
  "You are reviewing the final game of a best-of-three VGC series that is now over: the stated result and final score are authoritative, and there is no next game against this opponent in this series.";
const SERIES_REFLECTION_RESULT =
  "Identify the main reasons for the game and series result, including whether your between-game adaptations helped or backfired.";
const SERIES_REFLECTION_RESPONSE = `Respond with exactly one JSON object: {"summary":"why the game and series were won or lost","adjustment":"what to keep or change with this team in the next match","notebook":${NOTEBOOK_OBJECT}}.`;

export const SERIES_REFLECTION_SYSTEM = [
  SERIES_REFLECTION_OVER,
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_EVIDENCE,
  SERIES_REFLECTION_RESULT,
  "Rewrite team_playbook with only transferable lessons about using this fixed team. Return empty series_memory and next_game_plan fields; do not assume an interaction or damage result against this opponent will repeat against a different team.",
  SERIES_REFLECTION_RESPONSE,
].join("\n");

export const TOURNAMENT_RETROSPECTIVE_SYSTEM = [
  "You are reviewing the final game of the match that ended your fixed-team VGC tournament run. The supplied outcome says whether you were eliminated or won the tournament final.",
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_EVIDENCE,
  "This is a retrospective, not a decision. Nothing you write changes the result, and there is no next round to prepare for.",
  "Judge only the supplied final game, including what you did well and poorly with the fixed team. Do not claim evidence from earlier games or rounds. Do not assume an interaction or damage result against this opponent generalizes to a different team.",
  "Credit sound choices plainly even in a loss, and identify real weaknesses plainly even in a win.",
  'Respond with exactly one JSON object: {"summary":"<1-2 sentences on how the final game ended>","did_well":"<2-4 sentences>","did_poorly":"<2-4 sentences>","would_change":"<2-4 sentences, each one concrete>"}.',
].join("\n");

export const CLOSED_SERIES_REFLECTION_SYSTEM = [
  SERIES_REFLECTION_OVER,
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_EVIDENCE,
  "Identify the main reason for the game and series result, including whether your between-game adjustments helped or backfired.",
  REFLECTION_PREVIEW_PLAN,
  "Rewrite the private notebook for a possible future rematch: put own-team lessons in team_playbook, durable opponent tendencies and reveals in series_memory, and leave next_game_plan empty. Omit current HP, active positions, turn recaps, and repeated roster facts.",
  `Respond with exactly one JSON object: {"summary":"why the game and series were won or lost","adjustment":"what you would change against this opponent in a future series","notebook":${NOTEBOOK_OBJECT}}.`,
].join("\n");

export const DRAFT_SERIES_REFLECTION_SYSTEM = [
  SERIES_REFLECTION_OVER,
  FORMAT_AUTHORITY_NOTICE,
  REFLECTION_EVIDENCE,
  "Identify the main reason for the game and series result, including whether your between-game adjustments helped or backfired.",
  REFLECTION_PREVIEW_PLAN,
  "Also assess the preparation for this series: how well the six you registered and their sets fit this opponent, what worked, and whether the full roster offered a materially better alternative.",
  "Rewrite the private notebook for a possible future rematch: put own-team and preparation lessons in team_playbook, durable opponent tendencies and revealed facts in series_memory, and leave next_game_plan empty. Omit current HP, active positions, turn recaps, and repeated roster facts.",
  `Respond with exactly one JSON object: {"summary":"why the game and series were won or lost","adjustment":"what you would change against this opponent in a future series","notebook":${NOTEBOOK_OBJECT}}.`,
].join("\n");

export interface DecisionPrompt {
  state: string;
  slotNames: string[];
  menus: SlotMenu[];
  transcript?: string[];
  memory: BattleMemory;
  seriesContext?: string;
  matchups?: string[];
}

export function renderDecision(input: DecisionPrompt): string {
  const lines: string[] = [];
  if (input.seriesContext) lines.push("Match context:", input.seriesContext, "");
  lines.push("Authoritative battle state and roster reference:", input.state, "");
  if (input.matchups?.length)
    lines.push(
      "Active matchup reference (type chart with known direct ability/item immunities; use estimate_damage for actual damage):",
      ...input.matchups,
      "",
    );
  lines.push("Private strategic memory:", renderStrategicMemory(input.memory), "");
  lines.push(
    "Verified reference memory from prior authoritative lookups:",
    renderVerifiedReferenceMemory(input.memory),
    "",
  );
  if (input.transcript?.length)
    lines.push("Compact private battle timeline (your POV):", ...input.transcript, "");

  const sharedTeamMenu =
    input.menus.length > 1 &&
    input.menus.every(
      (menu) =>
        menu.every((item) => item.kind === "team") &&
        menu.length === input.menus[0]?.length &&
        menu.every((item, index) => item.label === input.menus[0]?.[index]?.label),
    );
  if (sharedTeamMenu) {
    lines.push("Team preview. Ordered team menu (choices 1-2 lead; choices 3-4 back):");
    for (const [index, item] of input.menus[0]!.entries()) lines.push(`  ${index}. ${item.label}`);
  } else {
    lines.push(
      input.menus.length === 1
        ? `Choose for ${input.slotNames[0] ?? "Pokémon"}:`
        : "Choose all parts of this joint decision together:",
    );
    for (const [slot, menu] of input.menus.entries()) {
      lines.push(`Slot ${slot + 1}: ${input.slotNames[slot] ?? `slot ${slot + 1}`}:`);
      for (const [index, item] of menu.entries()) lines.push(`  ${index}. ${item.label}`);
    }
  }
  lines.push(
    "",
    `Return one JSON object with {"choices":[${input.menus.map((_, index) => `N${index + 1}`).join(",")}]}.`,
    `You may add "rationale":"final reason" and, only when durable plans changed, "notebook":${NOTEBOOK_OBJECT}.`,
    `Each choice is the zero-based index for its displayed slot${sharedTeamMenu ? " or ordered team position" : ""}. Include no prose outside JSON.`,
  );
  return lines.join("\n");
}
