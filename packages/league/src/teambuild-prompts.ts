import { createHash } from "node:crypto";

import { defaultPsDir } from "./paths.js";
import { type MechanicsToolAvailability, mechanicsToolNotice } from "./prompt-capabilities.js";
import { FORMAT_AUTHORITY_NOTICE, renderPromptTemplate } from "./prompts.js";
import { loadShowdown } from "./showdown.js";
import {
  strictTeamBuildTask,
  type TeamBuildObjective,
  type TeamBuildRefereeOptions,
  type TeamBuildSheetPolicy,
  type TeamBuildTask,
} from "./teambuild-protocol.js";
import { type DexLike, legalItems, legalMoves } from "./teambuild-validation.js";

const MATCHUP_AVAILABLE_MECHANICS_TOOLS = [
  "You have the Showdown dex tools. Use them while you build: check what an item or ability actually does here,",
  "what a spread outruns, and how hard an attack lands. They compute from the",
  "simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;",
  "a hypothetical damage result does not imply omitted abilities or field effects.",
].join("\n");

const GENERAL_AVAILABLE_MECHANICS_TOOLS = [
  "You have the Showdown dex tools. Use them while you build: check legal moves, items, abilities, speed benchmarks,",
  "and damage against representative threats. The tools compute from the simulator this task validates against.",
].join("\n");

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
    "- Each move has at most 20 PP.",
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
    "",
    "Choose the 6 for this specific opponent and build their sets. Reply with JSON only, in this shape:",
    '{"team_plan": "<2-5 sentences on the matchup and how these six answer it>",',
    ' "sets": [{"id": "<board-id>", "item": "<item>", "ability": "<ability>", "nature": "<nature>",',
    '           "moves": ["<up to 4 moves>"], "evs": {"hp": 0, "atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0},',
    '           "note": "<one line on this set\'s job>"}]}',
    'Exactly 6 entries in "sets", each one a board id from YOUR ROSTER below.',
  ],
  rosterHeading: "YOUR ROSTER (board id | name | types | base stats | abilities | legal moves):",
  opponentHeading: "OPPONENT ROSTER — {{model}} (they pick 6 of these):",
  priorContextHeading:
    "YOUR SEASON SO FAR (your results, what you registered, and your notes against this coach):",
  priorContextNotice:
    "Every coach builds a new six for every matchup; sets, items, moves and spreads seen earlier were built for that series and may not return.",
  lockedItem: "MUST hold {{item}}",
  noMega: "cannot hold a Mega Stone",
  rejectionTemplate: "That team was rejected:\n{{error}}\nReply again with only the JSON object.",
  truncatedTemplate:
    "Your previous reply used the whole {{budget}}-token budget before finishing the team. Reply now with only the JSON object, keeping your reasoning short enough to finish inside the budget.",
  maxTokens: 65_536,
  attempts: 5,
  toolRounds: 16,
  maxCallsPerRound: 8,
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
    "- Each move has at most 20 PP.",
    "- Item Clause: no two team members may hold the same item. Species Clause: no two may share a species.",
    "- Use only these items:",
    "{{items}}",
    "- A candidate with a locked item must hold it. A candidate without one cannot hold a Mega Stone.",
    "",
    "You have the Showdown dex tools. Use them while you build: check legal moves, items, abilities, speed benchmarks,",
    "and damage against representative threats. The tools compute from the simulator this task validates against.",
    "",
    "Reply with JSON only, in this shape:",
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

const TEAMBUILD_RESPONSE_PROTOCOL_FIELD = "responseShape";

const TEAMBUILD_RENDERER_PROTOCOL = {
  version: 2,
  [TEAMBUILD_RESPONSE_PROTOCOL_FIELD]: "strict-json-v1",
  candidateIdentity: "frozen-id",
  setPacking: "showdown-teams-pack",
  setNotes: true,
  promptRenderer: "ordered-template-replace-all-v1",
  candidateRenderer: "dex-roster-block-v1",
  sheetRules: {
    open:
      "- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are open, so your opponent reads your\n" +
      "  moves, items, abilities, and natures — but not your exact EV spreads.",
    closed:
      "- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are closed, so neither coach receives " +
      "the opposing moves, items, abilities, natures, or EV spreads before play.",
  },
  sheetPolicy: "task-bound",
  evidencePolicy: "stage-evidence-v1",
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
  return TEAMBUILD_RENDERER_PROTOCOL.sheetRules[policy];
}

export function teamBuildSystemPrompt(
  task: TeamBuildTask,
  dex: DexLike,
  evLimit: number,
  evMax: number,
  mechanicsTools: MechanicsToolAvailability = "available",
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
  const rendered = renderPromptTemplate(
    task.objective.kind === "matchup"
      ? TEAMBUILD_PROMPT_POLICY.systemTemplate
      : GENERAL_TEAMBUILD_PROMPT_POLICY.systemTemplate,
    values,
  );
  const availableNotice =
    task.objective.kind === "matchup"
      ? MATCHUP_AVAILABLE_MECHANICS_TOOLS
      : GENERAL_AVAILABLE_MECHANICS_TOOLS;
  return rendered.replace(availableNotice, mechanicsToolNotice(mechanicsTools, availableNotice));
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

export function connectedTeamBuildPromptRevision(
  objective: TeamBuildObjective,
  sheetPolicy: TeamBuildSheetPolicy,
  mechanicsTools: MechanicsToolAvailability = "available",
): string {
  const policy =
    objective.kind === "matchup"
      ? [TEAMBUILD_PROMPT_POLICY, TEAMBUILD_RENDERER_PROTOCOL, sheetPolicy, "strict"]
      : [
          TEAMBUILD_PROMPT_POLICY,
          GENERAL_TEAMBUILD_PROMPT_POLICY,
          TEAMBUILD_RENDERER_PROTOCOL,
          sheetPolicy,
          "strict",
        ];
  const revision = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
  return createHash("sha256")
    .update(JSON.stringify([revision, "system-blank-line-user-v1", mechanicsTools]))
    .digest("hex")
    .slice(0, 12);
}

export function renderStrictTeamBuildPrompt(
  task: TeamBuildTask,
  options: Pick<TeamBuildRefereeOptions, "psDir"> & {
    mechanicsTools?: MechanicsToolAvailability;
  } = {},
): string {
  const canonical = strictTeamBuildTask(task);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonical.format);
  const dex = Dex.mod(format.mod || "base");
  const rules = Dex.formats.getRuleTable(format);
  return [
    teamBuildSystemPrompt(
      canonical,
      dex,
      rules.evLimit ?? 508,
      32,
      options.mechanicsTools ?? "available",
    ),
    "",
    teamBuildUserPrompt(canonical, dex),
  ].join("\n");
}
