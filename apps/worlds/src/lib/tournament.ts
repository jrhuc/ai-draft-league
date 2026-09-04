import type { PublicTournamentBundle } from "league/protocol";

export type TournamentBundle = PublicTournamentBundle;
export type Entrant = TournamentBundle["entrants"][number];
export type Match = NonNullable<TournamentBundle["bracket"]["rounds"][number][number]["match"]>;
export type Replay = TournamentBundle["replays"][string];
