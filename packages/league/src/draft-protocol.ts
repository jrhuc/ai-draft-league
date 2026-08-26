import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";
import { baseCostsBySpecies, boardRow } from "./board-search.js";
import { BOARDS_DIR, defaultPsDir } from "./paths.js";
import { type MechanicsToolAvailability, mechanicsToolNotice } from "./prompt-capabilities.js";
import { FORMAT_AUTHORITY_NOTICE, MANAGER_CHARGE, renderPromptTemplate } from "./prompts.js";
import { loadShowdown } from "./showdown.js";
import { normalizeStageEvidence, type StageEvidence } from "./stage-evidence.js";
import type { JsonValue } from "./types.js";
import { fileSlug, isRecord } from "./value.js";
import type { BoardInfo, DraftBoardMonView } from "./views.js";

const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const draftBoardMonSchema = z.object({
  id: z.string().regex(BOARD_SLUG),
  name: z.string().min(1),
  species: z.string(),
  forme: z.string().optional(),
  item: z.string().optional(),
  base: z.string().min(1),
  types: z.array(z.string()),
  cost: z.number().int().min(1),
  origin: z.enum(["base", "regmb"]),
  anchor: z.string().optional(),
  usage: z.string().optional(),
  listed: z.number().optional(),
});

export const draftBoardSchema = z.object({
  id: z.string().min(1),
  format: z.string().endsWith("bo3"),
  budget: z.number().int().min(1),
  picks: z.number().int().min(4),
  source: z.string(),
  mons: z.array(draftBoardMonSchema),
});

export type DraftBoardMon = z.infer<typeof draftBoardMonSchema>;
export type DraftBoard = z.infer<typeof draftBoardSchema>;

const pickResponseSchema = z.object({
  pick: z.string().catch(""),
  reasoning: z.string().optional().catch(undefined),
  notebook: z.string().optional().catch(undefined),
});

const franchiseNameResponseSchema = z.object({ team_name: z.string() });

export const draftTranscriptRowSchema = z.object({
  pick: z.number().int(),
  entrant: z.number().int().optional(),
  model: z.string(),
  mon: z.string(),
  name: z.string(),
  cost: z.number(),
  budget_left: z.number(),
  action: z.object({ pick: z.string() }).optional(),
  rationale: z.string(),
  evidence_supplied: z.object({ rationale: z.boolean(), notebook_update: z.boolean() }).optional(),
  notebook: z.string().optional(),
  team_name: z.string().optional(),
  fallback: z.boolean(),
  timestamp: z.string(),
});

export type DraftTranscriptRow = z.infer<typeof draftTranscriptRowSchema>;

export const franchiseNameTranscriptRowSchema = z.object({
  entrant: z.number().int(),
  model: z.string(),
  team_name: z.string(),
  fallback: z.boolean(),
  timestamp: z.string(),
});

export function isRejection<T extends object>(result: T | string): result is string {
  return !(result instanceof Object);
}

const DRAFT_AVAILABLE_MECHANICS_TOOLS = [
  "You have the Showdown dex tools. Use them to check anything the board summary does not answer: what a Mega",
  "becomes, how a type matchup reads, what a spread outruns, or roughly how hard an attack hits. They compute",
  "from the simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;",
  "a hypothetical damage result does not imply omitted abilities or field effects. search_board filters and re-sorts the",
  "board itself by type, price, ability, base stat total, or which entries legally learn a given move.",
].join("\n");

export const DRAFT_PROMPT_POLICY = {
  systemTemplate: [
    "You are {{model}}, manager of a franchise in a Pokémon VGC draft league played in the format {{format}}.",
    MANAGER_CHARGE,
    FORMAT_AUTHORITY_NOTICE,
    "",
    "This is the draft.",
    "",
    "LEAGUE RULES",
    "- {{coaches}} coaches snake-draft {{picks}} Pokémon each from the shared board below.",
    "- Every coach has {{budget}} points. A Pokémon drafted by one coach is gone for everyone else.",
    "- You may not draft two entries that share a base species, so Charizard and Mega Charizard Y are alternatives, not a pair.",
    "- A Mega entry plays as its base forme holding its Mega Stone, with the option to Mega Evolve during a game;",
    "  drafting the base forme instead means it can hold any item but never a Mega Stone. The board lists both, priced differently.",
    "- You may draft, register, and bring any number of Mega entries. During a game you choose which of the Mega entries",
    "  you brought, if any, Mega Evolves; the rest simply play their base formes that game.",
    "{{rosterPolicy}}",
    "- Before each match you choose 6 of your {{picks}} and build every set yourself: item, ability, nature, moves, and EVs.",
    "  Nothing about a set is fixed by the draft.",
    "- Games are 4-of-6 doubles. You will see your opponent’s full roster before you build, and they will see yours.",
    "",
    "You have the Showdown dex tools. Use them to check anything the board summary does not answer: what a Mega",
    "becomes, how a type matchup reads, what a spread outruns, or roughly how hard an attack hits. They compute",
    "from the simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;",
    "a hypothetical damage result does not imply omitted abilities or field effects. search_board filters and re-sorts the",
    "board itself by type, price, ability, base stat total, or which entries legally learn a given move.",
    "",
    "Your roster is judged matchup by matchup: over the season it needs a winning 6 against each of the other",
    "rosters taking shape around you.",
    "",
    "{{board}}",
  ],
  turnInstruction:
    'Reply with one JSON object containing {"pick":"<board-id>"}. Optional evidence fields are "reasoning":"<concise reason>" and, only when your durable plan changed, "notebook":"<complete replacement notes for later picks>".',
  turnTemplate:
    "Overall pick {{pick}} of {{total}}; {{remaining}} left for you, {{budget}} points to fill them from what is still on the board.",
  boardHeading: "DRAFT BOARD (id | cost | name | types | base stats | abilities):",
  boardOrder: "cost-descending",
  takenHeading: "ALREADY DRAFTED:",
  nothingTaken: "- (nothing yet; you have the first pick)",
  rosterHeading: "YOUR ROSTER:",
  notebookHeading: "YOUR PRIVATE DRAFT NOTE FROM YOUR PREVIOUS PICK:",
  emptyRoster: "- (empty)",
  rejectionTemplate: "That pick was rejected: {{error}}. Reply again with only the JSON object.",
  fallbackNote:
    "Harness note: every reply for pick {{pick}} was rejected (last reason: {{error}}), so a random legal pick was " +
    "made for you — {{mon}} is now on your roster. Your note above predates that pick.",
  truncatedTemplate:
    "Your previous reply used the whole {{budget}}-token budget before naming a pick. Reply now with only the JSON object, keeping your reasoning short enough to finish inside the budget.",
  notebookLimit: 4_000,
  rationaleLimit: 2_000,
  maxTokens: 65_536,
  attempts: 3,
  toolRounds: 8,
  maxCallsPerRound: 6,
} as const;

export const FRANCHISE_NAME_PROMPT_POLICY = {
  systemTemplate: [
    "You are {{model}}. The competitive draft is complete.",
    FORMAT_AUTHORITY_NOTICE,
    "Choose a concise, playful franchise name for the spectator-facing league display based on your finished roster.",
    "Wordplay and personality are welcome. The Shadow Cabinet, Prankster's Paradise, and Drought Dodgers are examples of the tone, not names to copy.",
    "The name is presentation only: coaches never see franchise names during competitive decisions.",
    'Reply with exactly one JSON object {"team_name":"<your franchise name>"} and nothing else.',
  ],
  rosterHeading: "YOUR COMPLETED ROSTER:",
  rejectionTemplate: "That name was rejected: {{error}} Reply again with only the JSON object.",
  maxTokens: 4_096,
  attempts: 3,
  nameLimit: 60,
} as const;

const CONNECTED_DRAFT_PROMPT_POLICY = {
  framing: "system-blank-line-user-v1",
  boardProjection: "current-legal-picks-only-v1",
} as const;

export function connectedDraftPromptRevision(
  mechanicsTools: MechanicsToolAvailability = "available",
): string {
  const draft = createHash("sha256")
    .update(JSON.stringify({ draft: DRAFT_PROMPT_POLICY, naming: FRANCHISE_NAME_PROMPT_POLICY }))
    .digest("hex")
    .slice(0, 12);
  return createHash("sha256")
    .update(JSON.stringify([draft, CONNECTED_DRAFT_PROMPT_POLICY, mechanicsTools]))
    .digest("hex")
    .slice(0, 12);
}

function cheapestCostsByBase(mons: readonly DraftBoardMon[]): number[] {
  const costs = new Map<string, number>();
  for (const mon of mons) {
    const current = costs.get(mon.base);
    if (current === undefined || mon.cost < current) costs.set(mon.base, mon.cost);
  }
  return [...costs.values()].sort((a, b) => a - b);
}

export function boardInfo(board: DraftBoard): BoardInfo {
  const cheapest = cheapestCostsByBase(board.mons);
  const affordable =
    cheapest.slice(0, board.picks).reduce((sum, cost) => sum + cost, 0) <= board.budget;
  return {
    id: board.id,
    format: board.format,
    monCount: board.mons.length,
    budget: board.budget,
    picks: board.picks,
    maxEntrants: affordable ? Math.min(8, Math.floor(cheapest.length / board.picks)) : 0,
  };
}

export function listBoards(boardsDir = BOARDS_DIR): BoardInfo[] {
  if (!fs.existsSync(boardsDir)) return [];
  const infos: BoardInfo[] = [];
  for (const entry of fs.readdirSync(boardsDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      infos.push(boardInfo(loadBoard(entry.slice(0, -".json".length), boardsDir)));
    } catch {}
  }
  return infos;
}

export function loadBoard(
  name: string,
  boardsDir = BOARDS_DIR,
  psDir = defaultPsDir(),
): DraftBoard {
  if (!BOARD_SLUG.test(name))
    throw new Error("board name must be lowercase letters, digits, and dashes");
  const file = path.join(boardsDir, `${name}.json`);
  const parsed = draftBoardSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid board ${file}: ${z.prettifyError(parsed.error)}`);
  const board = parsed.data;
  if (board.id !== name) throw new Error(`${file} id must match its filename`);
  const { Dex } = loadShowdown(psDir);
  const resolvedFormat = Dex.formats.get(board.format);
  if (!resolvedFormat.exists) throw new Error(`${file} names an unknown format`);
  const dex = Dex.mod(resolvedFormat.mod || "base");
  const seen = new Set<string>();
  for (const mon of board.mons) {
    const species = dex.species.get(mon.species);
    if (!species.exists || species.isNonstandard) {
      throw new Error(
        `board entry ${JSON.stringify(mon.id)} in ${file} is not a legal species in ${board.format}`,
      );
    }
    if (mon.base !== species.baseSpecies) {
      throw new Error(
        `board entry ${JSON.stringify(mon.id)} in ${file} has the wrong base species`,
      );
    }
    if (Boolean(mon.forme) !== Boolean(mon.item)) {
      throw new Error(
        `board entry ${JSON.stringify(mon.id)} in ${file} needs both a Mega forme and stone`,
      );
    }
    if (mon.item) {
      const item = dex.items.get(mon.item);
      const target = isRecord(item.megaStone) ? item.megaStone[species.name] : item.megaStone;
      if (!item.exists || target !== mon.forme) {
        throw new Error(
          `board entry ${JSON.stringify(mon.id)} in ${file} has an invalid Mega forme or stone`,
        );
      }
    }
    const battleForme = dex.species.get(mon.forme ?? mon.species);
    if (
      !battleForme.exists ||
      mon.types.length !== battleForme.types.length ||
      mon.types.some((type, index) => type !== battleForme.types[index])
    ) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} has invalid battle types`);
    }
    if (
      (mon.usage === undefined) !== (mon.listed === undefined) ||
      (mon.listed !== undefined && (!Number.isInteger(mon.listed) || mon.listed < 1))
    ) {
      throw new Error(
        `board entry ${JSON.stringify(mon.id)} in ${file} has invalid repricing metadata`,
      );
    }
    if (seen.has(mon.id))
      throw new Error(`duplicate board entry ${JSON.stringify(mon.id)} in ${file}`);
    seen.add(mon.id);
  }
  const { picks, budget } = board;
  if (board.mons.length < picks * 2)
    throw new Error(`${file} needs at least ${picks * 2} draftable entries`);
  const cheapest = cheapestCostsByBase(board.mons).slice(0, picks);
  if (cheapest.length < picks || cheapest.reduce((sum, cost) => sum + cost, 0) > budget) {
    throw new Error(`${file} needs a budget that can afford one ${picks}-Pokémon roster`);
  }
  return board;
}

export function describeBoardMon(
  mon: DraftBoardMon,
  psDir = defaultPsDir(),
  format?: string,
): DraftBoardMonView {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(format ? Dex.formats.get(format).mod || "base" : "champions");
  const species = dex.species.get(mon.forme ?? mon.species);
  return {
    id: mon.id,
    name: mon.name,
    spriteId: species.spriteid,
    cost: mon.cost,
    types: mon.types,
    item: mon.item ?? "",
    abilities: [
      species.abilities[0],
      species.abilities[1],
      species.abilities.H,
      species.abilities.S,
    ].flatMap((ability) => (ability ? [ability] : [])),
    baseStats: {
      hp: species.baseStats.hp,
      atk: species.baseStats.atk,
      def: species.baseStats.def,
      spa: species.baseStats.spa,
      spd: species.baseStats.spd,
      spe: species.baseStats.spe,
    },
  };
}

export interface DraftState {
  board: DraftBoard;
  taken: Map<string, number>;
  rosters: DraftBoardMon[][];
  budgets: number[];
  teamNames: string[];
}

function cheapestByBase(state: DraftState, drafter: number, exclude?: DraftBoardMon): number[] {
  const owned = new Set(state.rosters[drafter]!.map((mon) => mon.base));
  if (exclude) owned.add(exclude.base);
  const floor = new Map<string, number>();
  for (const mon of state.board.mons) {
    if (state.taken.has(mon.id) || owned.has(mon.base)) continue;
    const current = floor.get(mon.base);
    if (current === undefined || mon.cost < current) floor.set(mon.base, mon.cost);
  }
  return [...floor.values()].sort((a, b) => a - b);
}

export function legalPicks(state: DraftState, drafter: number): DraftBoardMon[] {
  const roster = state.rosters[drafter]!;
  if (roster.length >= state.board.picks) return [];
  const owned = new Set(roster.map((mon) => mon.base));
  const slotsLeft = state.board.picks - roster.length;
  return state.board.mons.filter((mon) => {
    if (state.taken.has(mon.id) || owned.has(mon.base)) return false;
    if (mon.cost > state.budgets[drafter]!) return false;
    const rest = cheapestByBase(state, drafter, mon);
    if (rest.length < slotsLeft - 1) return false;
    const reserve = rest.slice(0, slotsLeft - 1).reduce((sum, cost) => sum + cost, 0);
    return reserve <= state.budgets[drafter]! - mon.cost;
  });
}

export interface DraftPickAction {
  pick: number;
  entrant: number;
  mon: string;
}

export function applyDraftPick(state: DraftState, action: DraftPickAction): DraftState {
  const completed = state.taken.size;
  const expectedPick = completed + 1;
  const expectedEntrant = snakeOrder(state.rosters.length, state.board.picks)[completed];
  if (expectedEntrant === undefined) throw new Error("the draft is already complete");
  if (!Number.isSafeInteger(action.pick) || action.pick !== expectedPick) {
    throw new Error(`draft pick ${String(action.pick)} is stale; expected pick ${expectedPick}`);
  }
  if (action.entrant !== expectedEntrant) {
    throw new Error(
      `draft pick ${expectedPick} belongs to entrant ${expectedEntrant}, not entrant ${action.entrant}`,
    );
  }
  const mon = state.board.mons.find((candidate) => candidate.id === action.mon);
  if (!mon) {
    throw new Error(
      `draft pick ${expectedPick} names unknown board id ${JSON.stringify(action.mon)}`,
    );
  }
  const legal = legalPicks(state, action.entrant);
  if (!legal.includes(mon)) {
    throw new Error(
      `draft pick ${expectedPick} is illegal: ${rejection(mon.id, legal, state, action.entrant)}`,
    );
  }

  const rosters = [...state.rosters];
  rosters[action.entrant] = [...rosters[action.entrant]!, mon];
  const budgets = [...state.budgets];
  budgets[action.entrant]! -= mon.cost;
  const taken = new Map(state.taken);
  taken.set(mon.id, action.entrant);
  return { board: state.board, taken, rosters, budgets, teamNames: [...state.teamNames] };
}

export function maxAffordable(legal: readonly DraftBoardMon[]): number {
  return legal.length ? Math.max(...legal.map((mon) => mon.cost)) : 0;
}

export function snakeOrder(entrants: number, rounds: number): number[] {
  const order: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let seat = 0; seat < entrants; seat += 1) {
      order.push(round % 2 ? entrants - 1 - seat : seat);
    }
  }
  return order;
}

export function draftBoardTable(
  board: DraftBoard,
  psDir: string,
  mons: readonly DraftBoardMon[] = board.mons,
  heading: string = DRAFT_PROMPT_POLICY.boardHeading,
): string {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(board.format).mod || "base");
  const lines: string[] = [heading];
  const order = (a: DraftBoardMon, b: DraftBoardMon) =>
    b.cost - a.cost || a.name.localeCompare(b.name);
  const baseCosts = baseCostsBySpecies(board.mons);
  for (const mon of [...mons].sort(order)) lines.push(boardRow(mon, dex, baseCosts));
  return lines.join("\n");
}

export function draftSystemPrompt(
  board: DraftBoard,
  models: string[],
  drafter: number,
  psDir: string,
  rosterPolicy: string,
  mechanicsTools: MechanicsToolAvailability = "available",
): string {
  const values = [
    ["model", models[drafter]!],
    ["format", board.format],
    ["coaches", String(models.length)],
    ["picks", String(board.picks)],
    ["budget", String(board.budget)],
    ["board", draftBoardTable(board, psDir)],
    ["rosterPolicy", rosterPolicy],
  ] as const;
  const rendered = renderPromptTemplate(DRAFT_PROMPT_POLICY.systemTemplate, values);
  return rendered.replace(
    DRAFT_AVAILABLE_MECHANICS_TOOLS,
    mechanicsToolNotice(mechanicsTools, DRAFT_AVAILABLE_MECHANICS_TOOLS),
  );
}

export function draftUserPrompt(
  state: DraftState,
  drafter: number,
  models: string[],
  pickNumber: number,
  notebook: string,
): string {
  const lines: string[] = [];
  const slotsLeft = state.board.picks - state.rosters[drafter]!.length;

  lines.push(DRAFT_PROMPT_POLICY.takenHeading);
  const taken = [...state.taken.entries()];
  if (!taken.length) lines.push(DRAFT_PROMPT_POLICY.nothingTaken);
  for (const [index, model] of models.entries()) {
    const roster = state.rosters[index]!;
    if (!roster.length) continue;
    const label = index === drafter ? "you" : model;
    const budget = `${state.budgets[index]} points left`;
    lines.push(
      `- ${label} (${budget}): ${roster.map((mon) => `${mon.name} (${mon.cost})`).join(", ")}`,
    );
  }

  lines.push("", DRAFT_PROMPT_POLICY.rosterHeading);
  lines.push(
    ...(state.rosters[drafter]!.length
      ? state.rosters[drafter]!.map(
          (mon) =>
            `- ${mon.name} (${mon.cost}) · ${mon.types.join("/")}${mon.item ? ` · ${mon.item}` : ""}`,
        )
      : [DRAFT_PROMPT_POLICY.emptyRoster]),
  );
  if (notebook) lines.push("", DRAFT_PROMPT_POLICY.notebookHeading, notebook);
  lines.push(
    "",
    DRAFT_PROMPT_POLICY.turnTemplate
      .replace("{{pick}}", String(pickNumber + 1))
      .replace("{{total}}", String(models.length * state.board.picks))
      .replace("{{budget}}", String(state.budgets[drafter]))
      .replace("{{remaining}}", `${slotsLeft} ${slotsLeft === 1 ? "pick" : "picks"}`),
  );
  lines.push("", DRAFT_PROMPT_POLICY.turnInstruction);
  return lines.join("\n");
}

export function renderDraftPickPrompt(
  state: DraftState,
  drafter: number,
  models: string[],
  pickNumber: number,
  notebook: string,
  options: {
    psDir?: string;
    rosterPolicy: string;
    mechanicsTools?: MechanicsToolAvailability;
  },
): string {
  const psDir = options.psDir ?? defaultPsDir();
  const mechanicsTools = options.mechanicsTools ?? "available";
  const legalBoard: DraftBoard = { ...state.board, mons: legalPicks(state, drafter) };
  return [
    draftSystemPrompt(legalBoard, models, drafter, psDir, options.rosterPolicy, mechanicsTools),
    "",
    draftUserPrompt(state, drafter, models, pickNumber, notebook),
  ].join("\n");
}

interface ParsedPick {
  mon: DraftBoardMon;
  reasoning: string;
  notebook?: string;
  evidence: StageEvidence;
}

function rejection(
  pickId: string,
  legal: DraftBoardMon[],
  state: DraftState,
  drafter: number,
  models?: readonly string[],
): string {
  const entry = state.board.mons.find(
    (candidate) => candidate.id === pickId || fileSlug(candidate.name) === pickId,
  );
  if (!entry)
    return `"${pickId}" is not a board id. Copy an id exactly as it appears in the board list.`;
  const owner = state.taken.get(entry.id);
  if (owner !== undefined) {
    return `${entry.name} was already drafted by ${models?.[owner] || `coach ${owner + 1}`}.`;
  }
  const clash = state.rosters[drafter]!.find((candidate) => candidate.base === entry.base);
  if (clash) {
    return `${entry.name} shares the species ${entry.base} with your ${clash.name}, and a roster holds only one of each.`;
  }
  const affordable = maxAffordable(legal);
  return (
    `${entry.name} costs ${entry.cost}, but you can spend at most ${affordable} ` +
    `${affordable === 1 ? "point" : "points"} on this pick and still fill your remaining slots.`
  );
}

export function parsePick(
  response: string,
  legal: DraftBoardMon[],
  state: DraftState,
  drafter: number,
  models?: readonly string[],
  currentNotebook = "",
): ParsedPick | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return "the reply contained no JSON object";
  let json: JsonValue;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return "the JSON object did not parse";
  }
  const record = pickResponseSchema.safeParse(json);
  if (!record.success) return "the reply must be one JSON object";
  const pickId = fileSlug(record.data.pick);
  const mon = legal.find(
    (candidate) => candidate.id === pickId || fileSlug(candidate.name) === pickId,
  );
  if (!mon) return rejection(pickId, legal, state, drafter, models);
  const evidence = normalizeStageEvidence(record.data.reasoning, record.data.notebook, {
    currentNotebook,
    rationaleLimit: DRAFT_PROMPT_POLICY.rationaleLimit,
    notebookLimit: DRAFT_PROMPT_POLICY.notebookLimit,
  });
  return {
    mon,
    reasoning: evidence.rationale,
    evidence,
    notebook: evidence.supplied.notebookUpdate ? evidence.notebook : undefined,
  };
}

interface ParsedFranchiseName {
  teamName: string;
}

export function parseFranchiseName(response: string): ParsedFranchiseName | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return "the reply contained no JSON object";
  let json: JsonValue;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return "the JSON object did not parse";
  }
  const record = franchiseNameResponseSchema.safeParse(json);
  if (!record.success) return '"team_name" must be a non-empty string';
  const teamName = record.data.team_name
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, FRANCHISE_NAME_PROMPT_POLICY.nameLimit);
  return teamName ? { teamName } : '"team_name" must be a non-empty string';
}

export function franchiseNameSystemPrompt(model: string): string {
  return FRANCHISE_NAME_PROMPT_POLICY.systemTemplate
    .map((line) => line.replace("{{model}}", model))
    .join("\n");
}

export function franchiseNameUserPrompt(roster: readonly DraftBoardMon[]): string {
  return [
    FRANCHISE_NAME_PROMPT_POLICY.rosterHeading,
    ...roster.map((mon) => `- ${mon.name}${mon.item ? ` (${mon.item})` : ""}`),
  ].join("\n");
}
