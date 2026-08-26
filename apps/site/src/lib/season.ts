import type {
  PublicBattleEvent,
  PublicBuild,
  PublicMatch,
  PublicSeasonBundle,
  PublicWeeklyReview,
} from "league/protocol";

export type SeasonBundle = PublicSeasonBundle;
export type Match = PublicMatch;
export type Build = PublicBuild;
export type WeeklyReview = PublicWeeklyReview;

type Season = SeasonBundle["season"];
type FranchiseRow = SeasonBundle["franchises"][number];

export type SeasonStatus = Season["status"];
export type Franchise = FranchiseRow;
export type Record = Franchise["record"];
export type RosterSlot = Franchise["roster"][number];
export type Pokemon = Pick<RosterSlot, "id" | "name" | "spriteId" | "cost">;
export type BoardMon = SeasonBundle["board"][number];
export type DraftPick = SeasonBundle["draft"]["picks"][number];
export type Standing = SeasonBundle["standings"][number];
export type BuildSet = NonNullable<Build["sets"]>[number];
export type GameSummary = Match["games"][number];
export type Week = SeasonBundle["weeks"][number];
export type ReplayEvent = PublicBattleEvent;
export type SlotRef = NonNullable<ReplayEvent["actor"]>;
export type Replay = NonNullable<SeasonBundle["replays"][string]>;
export type ReplayGame = Replay["games"][number];
export type Decision = ReplayGame["decisions"][number];
export type Reflection = ReplayGame["reflections"][number];
export type TransactionWindow = SeasonBundle["transactions"][number];
export type TradeOffer = TransactionWindow["offers"][number];
export type BracketSlot = NonNullable<SeasonBundle["playoffs"]>["rounds"][number][number];
export type Review = SeasonBundle["reviews"][number];
