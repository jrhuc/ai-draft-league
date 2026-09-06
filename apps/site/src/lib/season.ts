import type {
  PublicMatch,
  PublicSeasonBundle,
  PublicTracesManifest,
  PublicWeeklyReview,
} from "league/protocol";

export type SeasonBundle = PublicSeasonBundle;
export type Season = SeasonBundle & { traces: PublicTracesManifest | null };
export type Match = PublicMatch;
export type WeeklyReview = PublicWeeklyReview;

export type Franchise = SeasonBundle["franchises"][number];
export type BoardMon = SeasonBundle["board"][number];
export type DraftPick = SeasonBundle["draft"]["picks"][number];
export type Week = SeasonBundle["weeks"][number];
export type Replay = NonNullable<SeasonBundle["replays"][string]>;
