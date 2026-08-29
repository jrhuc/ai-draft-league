import type { PublicTournamentBundle } from "league/protocol";

export type TournamentBundle = PublicTournamentBundle;
export type Entrant = TournamentBundle["entrants"][number];
export type EntrantTeam = Entrant["team"];
export type TeamSet = EntrantTeam["sets"][number];
export type BracketSlot = TournamentBundle["bracket"]["rounds"][number][number];
export type Match = NonNullable<BracketSlot["match"]>;
export type GameSummary = Match["games"][number];
export type Replay = TournamentBundle["replays"][string];
export type ReplayGame = Replay["games"][number];
export type ReplayEvent = ReplayGame["events"][number];
export type Decision = ReplayGame["decisions"][number];
export type Reflection = ReplayGame["reflections"][number];
