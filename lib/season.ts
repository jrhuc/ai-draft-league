export type SeasonStatus = "draft" | "regular-season" | "playoffs" | "complete";

export type Pokemon = { id: string; name: string; spriteId: string; cost: number };

export type RosterSlot = Pokemon & {
  acquired: "draft" | "trade" | "free-agency";
  overallPick: number | null;
  rationale: string;
  fallback: boolean;
};

export type Record = { seriesWins: number; seriesLosses: number; gameWins: number; gameLosses: number };

export type Franchise = {
  id: string;
  name: string;
  model: string;
  budget: { total: number; spent: number; remaining: number };
  roster: RosterSlot[];
  record: Record;
  finish: string | null;
};

export type BoardMon = Pokemon & {
  types: string[];
  abilities: string[];
  baseStats: { [stat: string]: number };
  megaStone: string | null;
  draftedBy: string | null;
};

export type DraftPick = {
  overall: number;
  round: number;
  franchiseId: string;
  pokemon: Pokemon;
  rationale: string;
  fallback: boolean;
};

export type Standing = Record & { rank: number; franchiseId: string; differential: number };

export type BuildSet = {
  species: string;
  spriteId: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  evs: { [stat: string]: number };
};

export type Build = {
  franchiseId: string;
  prepared: string[];
  sets: BuildSet[] | null;
  rationale: string;
  attempts: number;
};

export type GameSummary = { number: number; winnerId: string | null; turns: number };

export type Match = {
  id: string;
  seriesIndex: number;
  seriesId: string | null;
  franchises: [string, string];
  status: "scheduled" | "complete";
  score: [number, number] | null;
  winnerId: string | null;
  games: GameSummary[];
  builds: Build[];
};

export type Week = { number: number; status: "released" | "scheduled"; matches: Match[] };

export type SlotRef = { side: 0 | 1; slot: number };

export type ReplayEvent = {
  turn: number;
  kind: "turn" | "move" | "switch" | "faint" | "status" | "field" | "win" | "timer" | "detail" | "preview";
  text: string;
  actor?: SlotRef;
  target?: SlotRef;
  species?: string;
  hp?: number;
  status?: string | null;
};

export type Decision = {
  franchiseId: string;
  turn: number;
  phase: string;
  action: string;
  rationale: string;
  fallback: boolean;
  automatic: boolean;
  latencyMs: number | null;
  reasoningTokens: number | null;
};

export type Reflection = {
  franchiseId: string;
  result: "won" | "lost";
  summary: string;
  adjustment: string;
  fallback: boolean;
};

export type ReplayGame = GameSummary & { events: ReplayEvent[]; decisions: Decision[]; reflections: Reflection[] };

export type Replay = { seriesId: string; franchises: [string, string]; games: ReplayGame[] };

export type TradeOffer = {
  from: string;
  to: string | null;
  give: string | null;
  get: string | null;
  message: string | null;
  accepted: boolean | null;
  offerReasoning: string;
  responseReasoning: string;
};

export type TransactionWindow = {
  afterWeek: number;
  order: string[];
  offers: TradeOffer[];
  moves: Array<{ franchiseId: string; swaps: Array<{ drop: string; add: string }>; reasoning: string; fallback: boolean }>;
};

export type BracketSlot = {
  seriesIndex: number;
  round: number;
  slots: [string | null, string | null];
  match: Match | null;
};

export type Review = {
  franchiseId: string;
  outcome: string;
  summary: string;
  didWell: string;
  didPoorly: string;
  wouldChange: string;
  fallback: boolean;
};

export type WeeklyReview = {
  week: number;
  stage: "week" | "transactions";
  franchiseId: string;
  rosterVersion: number;
  reasoning: string;
  notebookChanged: boolean;
  fallback: boolean;
};

export type SeasonBundle = {
  protocolVersion: "season-bundle-v2";
  generatedAt: string;
  season: {
    id: string;
    title: string;
    format: string;
    board: { id: string; budget: number; picksPerFranchise: number };
    startedAt: string;
    status: SeasonStatus;
    releasedThroughWeek: number;
    releasedPlayoffRounds: number;
    totalWeeks: number;
    playoffRounds: number;
    sheets: "open" | "closed";
    championId: string | null;
  };
  provenance: { harnessCommit: string | null; showdownCommit: string | null; models: Array<{ franchiseId: string; spec: string }> };
  franchises: Franchise[];
  board: BoardMon[];
  draft: { picks: DraftPick[] };
  standings: Standing[];
  weeks: Week[];
  transactions: TransactionWindow[];
  weeklyReviews: WeeklyReview[];
  playoffs: { rounds: BracketSlot[][] } | null;
  replays: { [seriesId: string]: Replay };
  reviews: Review[];
};
