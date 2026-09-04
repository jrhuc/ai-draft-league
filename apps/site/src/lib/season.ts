import type { PublicMatch, PublicSeasonBundle, PublicWeeklyReview } from "league/protocol";

export type SeasonBundle = PublicSeasonBundle;
export type Match = PublicMatch;
export type WeeklyReview = PublicWeeklyReview;

export type Franchise = SeasonBundle["franchises"][number];
export type BoardMon = SeasonBundle["board"][number];
export type DraftPick = SeasonBundle["draft"]["picks"][number];
export type Week = SeasonBundle["weeks"][number];
export type Replay = NonNullable<SeasonBundle["replays"][string]>;
