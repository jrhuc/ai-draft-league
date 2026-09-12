import { FORMAT_AUTHORITY_NOTICE, PARALLEL_TOOLS_RULE, renderPromptTemplate } from "./prompts.js";
import { type TeamBuildSheetPolicy, type TeamBuildTask } from "./teambuild-protocol.js";
import { type DexLike, legalItems, legalMoves } from "./teambuild-validation.js";

export const TEAMBUILD_PROMPT_POLICY = {
  systemTemplate: [
    "You are {{model}}, building the six for one matchup on behalf of the franchise you manage in a Pokémon VGC draft league, format {{format}}.",
    FORMAT_AUTHORITY_NOTICE,
    "",
    "The roster of {{picks}} Pokémon and the memory below are your own, written as the franchise’s manager across the season.",
    "Before every match you choose exactly 6 of them and build each set from scratch. The memory is context, not a constraint; read_memory_page returns one of its pages in full.",
    "",
    "FORMAT RULES",
    "{{teamSheetRule}}",
    "- Every Pokémon is set to level 50.",
    "- EVs: {{evLimit}} points total across the team member, at most {{evMax}} in any one stat. IVs are fixed at maximum.",
    "  This is the Champions EV system, not the older 508/252 one. Points are whole numbers.",
    "- Base PP is capped at 20; battle PP is boosted by the Champions simulator.",
    "- Item Clause: no two of your six may hold the same item. Species Clause: no two may share a species.",
    "- This game has its own item list, which is shorter than the one you may expect. Many Gen 9 staples do not",
    "  exist here. Use only these items:",
    "{{items}}",
    "- Mega Evolution: a roster entry drafted as a Mega holds its Mega Stone and plays as its base forme until it",
    "  Mega Evolves; one drafted as the base forme may never hold a Mega Stone. You may register and bring any number of",
    "  Mega entries; bringing several to a game is legal — in play you choose which of them, if any, Mega Evolves that game,",
    "  and the others play as base formes.",
    "",
    "You have the Showdown dex tools. Use them while you build: check what an item or ability actually does here,",
    "what a spread outruns, and how hard an attack lands. They compute from the",
    "simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;",
    "a hypothetical damage result does not imply omitted abilities or field effects.",
    PARALLEL_TOOLS_RULE,
    "",
    "Choose the 6 for this specific opponent and build their sets. Call submit_team with:",
    '{"team_plan": "<2-5 sentences on the matchup and how these six answer it>",',
    ' "sets": [{"id": "<board-id>", "item": "<item>", "ability": "<ability>", "nature": "<nature>",',
    '           "moves": ["<up to 4 moves>"], "evs": {"hp": 0, "atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0},',
    '           "note": "<one line on this set\'s job>"}]}',
    'Exactly 6 entries in "sets", each one a board id from YOUR ROSTER below.',
  ],
  rosterHeading: "YOUR ROSTER (board id | name | types | base stats | abilities | legal moves):",
  opponentHeading:
    "OPPONENT ROSTER — {{model}} (they register any 6 of these with new sets for this matchup; a six they brought before is not a commitment):",
  priorContextHeading:
    "YOUR SEASON SO FAR (your results, what you registered, and your notes against this coach):",
  priorContextNotice:
    "Every coach builds a new six for every matchup; sets, items, moves and spreads seen earlier were built for that series and may not return.",
  lockedItem: "MUST hold {{item}}",
  noMega: "cannot hold a Mega Stone",
} as const;

const GENERAL_TEAMBUILD_PROMPT_POLICY = {
  systemTemplate: [
    "You are {{model}}, building a Pokémon VGC team for format {{format}}.",
    FORMAT_AUTHORITY_NOTICE,
    "",
    "Choose exactly {{teamSize}} entries from the explicit frozen candidate pool supplied below and build every set from scratch.",
    "No particular opponent is specified. Build for robust play across the format; do not assume an opponent roster.",
    "Your memory, when supplied, is context, not a constraint.",
    "",
    "FORMAT RULES",
    "{{teamSheetRule}}",
    "- Every Pokémon is set to level 50.",
    "- EVs: {{evLimit}} points total across the team member, at most {{evMax}} in any one stat. IVs are fixed at maximum.",
    "  This is the Champions EV system, not the older 508/252 one. Points are whole numbers.",
    "- Base PP is capped at 20; battle PP is boosted by the Champions simulator.",
    "- Item Clause: no two team members may hold the same item. Species Clause: no two may share a species.",
    "- Use only these items:",
    "{{items}}",
    "- A candidate with a locked item must hold it. A candidate without one cannot hold a Mega Stone.",
    "",
    "You have the Showdown dex tools. Use them while you build: check legal moves, items, abilities, speed benchmarks,",
    "and damage against representative threats. The tools compute from the simulator this task validates against.",
    PARALLEL_TOOLS_RULE,
    "",
    "Call submit_team with:",
    '{"team_plan": "<2-5 sentences on the team and its modes>",',
    ' "sets": [{"id": "<candidate-id>", "item": "<item>", "ability": "<ability>", "nature": "<nature>",',
    '           "moves": ["<up to 4 moves>"], "evs": {"hp": 0, "atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0},',
    '           "note": "<one line on this set\'s job>"}]}',
    'Exactly {{teamSize}} entries in "sets", each one a candidate id from the frozen pool below.',
  ],
  candidateHeading:
    "FROZEN CANDIDATE POOL (id | name | types | base stats | abilities | legal moves):",
  briefHeading: "TASK BRIEF:",
} as const;

const SHEET_RULES = {
  open:
    "- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are open, so your opponent reads your\n" +
    "  moves, items, abilities, and natures — but not your exact EV spreads.",
  closed:
    "- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are closed, so neither coach receives " +
    "the opposing moves, items, abilities, natures, or EV spreads before play.",
} as const;

function rosterBlock(
  dex: DexLike,
  roster: TeamBuildTask["constraint"]["candidates"],
  detailed: boolean,
): string[] {
  const lines: string[] = [];
  for (const mon of roster) {
    const battleForme = dex.species.get(mon.forme ?? mon.species);
    const stats = battleForme.baseStats;
    const abilities = Object.values(battleForme.abilities ?? {})
      .filter(Boolean)
      .join("/");
    const constraint = mon.item
      ? TEAMBUILD_PROMPT_POLICY.lockedItem.replace("{{item}}", mon.item)
      : TEAMBUILD_PROMPT_POLICY.noMega;
    lines.push(
      `- ${mon.id} | ${mon.name} | ${mon.types.join("/")} | ` +
        `${stats.hp}/${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe} | ${abilities} | ${constraint}`,
    );
    if (detailed) {
      const base = dex.species.get(mon.species);
      const baseAbilities = Object.values(base.abilities ?? {})
        .filter(Boolean)
        .join(" or ");
      if (mon.forme) {
        lines.push(
          `    registers as ${base.name}: set "ability" to one of ${baseAbilities}, NOT its Mega ability — ` +
            `it becomes ${mon.forme} with ${abilities} only after it Mega Evolves in battle`,
        );
      }
      lines.push(`    moves: ${legalMoves(dex, mon).join(", ")}`);
    }
  }
  return lines;
}

function teamSheetRule(policy: TeamBuildSheetPolicy): string {
  return SHEET_RULES[policy];
}

export function teamBuildSystemPrompt(
  task: TeamBuildTask,
  dex: DexLike,
  evLimit: number,
  evMax: number,
): string {
  const values = [
    ["model", task.model],
    ["format", task.format],
    ["picks", String(task.constraint.candidates.length)],
    ["teamSize", String(task.constraint.teamSize)],
    ["evLimit", String(evLimit)],
    ["evMax", String(evMax)],
    ["items", `  ${legalItems(dex).join(", ")}`],
    ["teamSheetRule", teamSheetRule(task.sheetPolicy)],
  ] as const;
  return renderPromptTemplate(
    task.objective.kind === "matchup"
      ? TEAMBUILD_PROMPT_POLICY.systemTemplate
      : GENERAL_TEAMBUILD_PROMPT_POLICY.systemTemplate,
    values,
  );
}

export function teamBuildUserPrompt(task: TeamBuildTask, dex: DexLike): string {
  if (task.objective.kind === "general") {
    const lines: string[] = [GENERAL_TEAMBUILD_PROMPT_POLICY.candidateHeading];
    lines.push(...rosterBlock(dex, task.constraint.candidates, true));
    if (task.notebook) lines.push("", task.notebook);
    if (task.objective.brief)
      lines.push("", GENERAL_TEAMBUILD_PROMPT_POLICY.briefHeading, task.objective.brief);
    return lines.join("\n");
  }
  const lines: string[] = [TEAMBUILD_PROMPT_POLICY.rosterHeading];
  lines.push(...rosterBlock(dex, task.constraint.candidates, true));
  if (task.notebook) lines.push("", task.notebook);
  lines.push(
    "",
    TEAMBUILD_PROMPT_POLICY.opponentHeading.replace("{{model}}", task.objective.opponent.model),
  );
  lines.push(...rosterBlock(dex, task.objective.opponent.candidates, false));
  if (task.objective.priorContext.length) {
    lines.push(
      "",
      TEAMBUILD_PROMPT_POLICY.priorContextHeading,
      ...task.objective.priorContext.map((entry) => `- ${entry}`),
      TEAMBUILD_PROMPT_POLICY.priorContextNotice,
    );
  }
  return lines.join("\n");
}
