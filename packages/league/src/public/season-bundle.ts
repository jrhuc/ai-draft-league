import {
  buildDraftPlayoffBracket,
  type DraftLeagueSeriesPlan,
  rankedTable,
} from "../draftleague-protocol.js";
import type {
  DraftBoardMonView,
  DraftTableRow,
  LeagueFranchiseView,
  LeagueGameResponse,
  LeagueResponse,
  LeagueTeambuildView,
  LeagueTradeWindowView,
} from "../views.js";
import type { BattleLogEntry } from "../battlelog.js";
import {
  type PublicBattleEvent,
  type PublicBuild,
  type PublicMatch,
  type PublicSeasonBundle,
  publicSeasonBundleSchema,
} from "./season-protocol.js";

export type PublicSeasonGameInput = Pick<
  LeagueGameResponse,
  "game" | "winner" | "log" | "decisions" | "reflections"
>;

export interface BuildPublicSeasonBundleOptions {
  league: LeagueResponse;
  plans: readonly DraftLeagueSeriesPlan[];
  board: readonly DraftBoardMonView[];
  games: ReadonlyMap<string, readonly PublicSeasonGameInput[]>;
  title: string;
  releasedThroughWeek: number;
  closedSheets: boolean;
  showdownCommit: string | null;
  generatedAt?: string;
}

function franchiseId(entrant: number): string {
  return `franchise-${entrant}`;
}

function franchiseName(teamName: string, model: string): string {
  return teamName || model.replace(/^[^:]*:/, "").replace(/^[^/]*\//, "");
}

type PublicRosterSlot = PublicSeasonBundle["franchises"][number]["roster"][number];

function replayReleasedRosters(
  franchises: readonly LeagueFranchiseView[],
  windows: readonly LeagueTradeWindowView[],
  board: readonly DraftBoardMonView[],
): Map<number, PublicRosterSlot[]> {
  const rosters = new Map<number, PublicRosterSlot[]>(
    franchises.map((franchise) => [
      franchise.entrant,
      franchise.draftRoster.map((slot) => ({
        id: slot.id,
        name: slot.name,
        spriteId: slot.spriteId,
        cost: slot.cost,
        acquired: "draft" as const,
        overallPick: slot.pick,
        rationale: slot.rationale,
        fallback: slot.fallback,
      })),
    ]),
  );
  const boardById = new Map(board.map((mon) => [mon.id, mon]));
  for (const window of windows) {
    for (const offer of window.offers) {
      if (!offer.accepted) continue;
      if (offer.to === null || offer.give === null || offer.get === null) {
        throw new Error(`accepted trade after week ${window.afterWeek} is incomplete`);
      }
      const from = rosters.get(offer.from);
      const to = rosters.get(offer.to);
      const giveIndex = from?.findIndex((slot) => slot.id === offer.give) ?? -1;
      const getIndex = to?.findIndex((slot) => slot.id === offer.get) ?? -1;
      if (!from || !to || giveIndex < 0 || getIndex < 0) {
        throw new Error(
          `accepted trade after week ${window.afterWeek} does not match the released rosters`,
        );
      }
      const given = from[giveIndex]!;
      const received = to[getIndex]!;
      from[giveIndex] = {
        ...received,
        acquired: "trade",
        rationale: offer.offerReasoning,
        fallback: false,
      };
      to[getIndex] = {
        ...given,
        acquired: "trade",
        rationale: offer.responseReasoning,
        fallback: false,
      };
    }
    for (const decision of window.decisions) {
      const roster = rosters.get(decision.entrant);
      if (!roster)
        throw new Error(
          `transaction after week ${window.afterWeek} references an unknown franchise`,
        );
      for (const swap of decision.swaps) {
        const dropIndex = roster.findIndex((slot) => slot.id === swap.drop);
        const added = boardById.get(swap.add);
        if (dropIndex < 0 || !added) {
          throw new Error(
            `free-agent swap after week ${window.afterWeek} does not match the released roster or board`,
          );
        }
        roster[dropIndex] = {
          id: added.id,
          name: added.name,
          spriteId: added.spriteId,
          cost: added.cost,
          acquired: "free-agency",
          overallPick: null,
          rationale: decision.reasoning,
          fallback: decision.fallback,
        };
      }
    }
  }
  return rosters;
}

function publicEvent(entry: BattleLogEntry): PublicBattleEvent {
  return { ...entry };
}

function publicBuild(build: LeagueTeambuildView, revealSets: boolean): PublicBuild {
  return {
    franchiseId: franchiseId(build.entrant),
    prepared: [...build.brought],
    sets: revealSets
      ? build.sets.map((set) => ({
          species: set.species,
          spriteId: set.spriteId,
          item: set.item,
          ability: set.ability,
          nature: set.nature,
          moves: [...set.moves],
          evs: { ...set.evs },
        }))
      : null,
    rationale: build.rationale,
    attempts: build.attempts,
  };
}

export function buildPublicSeasonBundle(
  options: BuildPublicSeasonBundleOptions,
): PublicSeasonBundle {
  const { league } = options;
  const totalWeeks = league.weeks ?? Math.max(0, ...options.plans.map((plan) => plan.round));
  const playoffRounds = league.playoffRounds;
  const maxRelease = totalWeeks + playoffRounds;
  if (
    !Number.isSafeInteger(options.releasedThroughWeek) ||
    options.releasedThroughWeek < 0 ||
    options.releasedThroughWeek > maxRelease
  ) {
    throw new Error(
      `released week must be between 0 and ${maxRelease} (${totalWeeks} weeks + ${playoffRounds} playoff rounds)`,
    );
  }
  const releasedThroughWeek = Math.min(options.releasedThroughWeek, totalWeeks);
  const releasedPlayoffRounds = Math.max(0, options.releasedThroughWeek - totalWeeks);
  const seasonReleased = releasedPlayoffRounds === playoffRounds && league.phase === "complete";
  if (
    !league.board ||
    !league.format ||
    league.budget === null ||
    league.picksPerEntrant === null
  ) {
    throw new Error(`league ${league.runId} is missing its public draft identity`);
  }

  const seriesByIndex = new Map(league.series.map((series) => [series.seriesIndex, series]));
  const planByIndex = new Map(options.plans.map((plan) => [plan.index, plan]));
  const buildsBySeries = new Map<number, LeagueTeambuildView[]>();
  for (const build of league.teambuilds) {
    const list = buildsBySeries.get(build.seriesIndex) ?? [];
    list.push(build);
    buildsBySeries.set(build.seriesIndex, list);
  }
  const released = (plan: DraftLeagueSeriesPlan): boolean =>
    plan.stage === "roundrobin"
      ? plan.round <= releasedThroughWeek
      : plan.round <= releasedPlayoffRounds;

  const replays: PublicSeasonBundle["replays"] = {};
  const matchFor = (
    plan: DraftLeagueSeriesPlan,
    matchId: string,
    sides: [number, number],
  ): PublicMatch => {
    const ids: [string, string] = [franchiseId(sides[0]), franchiseId(sides[1])];
    const series = seriesByIndex.get(plan.index);
    if (!released(plan)) {
      return {
        id: matchId,
        seriesIndex: plan.index,
        seriesId: null,
        franchises: ids,
        status: "scheduled",
        score: null,
        winnerId: null,
        games: [],
        builds: [],
      };
    }
    if (!series) {
      throw new Error(`${matchId} cannot be released before series ${plan.index} is complete`);
    }
    const games = options.games.get(series.seriesId);
    if (!games || games.length !== series.games.length) {
      throw new Error(
        `released series ${series.seriesId} has ${games?.length ?? 0} verified replays for ${series.games.length} games`,
      );
    }
    const builds = (buildsBySeries.get(plan.index) ?? [])
      .filter((build) => sides.includes(build.entrant))
      .sort((a, b) => sides.indexOf(a.entrant) - sides.indexOf(b.entrant))
      .map((build) => publicBuild(build, !options.closedSheets || seasonReleased));
    replays[series.seriesId] = {
      seriesId: series.seriesId,
      franchises: ids,
      games: games.map((game) => {
        const summary = series.games[game.game - 1];
        if (!summary)
          throw new Error(`released series ${series.seriesId} has no result for game ${game.game}`);
        return {
          number: game.game,
          winnerId: game.winner === null ? null : franchiseId(game.winner),
          turns: summary.turns,
          brought: summary.brought,
          megaEvolved: summary.megaEvolved,
          faints: summary.faints,
          events: game.log.map(publicEvent),
          decisions: game.decisions.map((decision) => ({
            franchiseId: franchiseId(sides[decision.side]),
            turn: decision.turn,
            phase: decision.phase,
            action: decision.action,
            selection: [...decision.selection],
            rationale: decision.rationale,
            fallback: decision.fallback,
            automatic: decision.automatic,
            latencyMs: decision.latencyMs,
            reasoningTokens: decision.reasoningTokens,
          })),
          reflections: game.reflections.map((reflection) => ({
            franchiseId: franchiseId(sides[reflection.side]),
            result: reflection.result,
            summary: reflection.summary,
            adjustment: reflection.adjustment,
            fallback: reflection.fallback,
          })),
        };
      }),
    };
    return {
      id: matchId,
      seriesIndex: plan.index,
      seriesId: series.seriesId,
      franchises: ids,
      status: "complete",
      score: series.score,
      winnerId: series.winner === null ? null : franchiseId(series.winner),
      games: series.games.map((game, index) => ({
        number: index + 1,
        winnerId: game.winner === null ? null : franchiseId(game.winner),
        turns: game.turns,
        brought: game.brought,
        megaEvolved: game.megaEvolved,
        faints: game.faints,
      })),
      builds,
    };
  };

  const weeks = Array.from({ length: totalWeeks }, (_, weekIndex) => {
    const number = weekIndex + 1;
    const plans = options.plans.filter(
      (plan) => plan.stage === "roundrobin" && plan.round === number,
    );
    return {
      number,
      status: number <= releasedThroughWeek ? ("released" as const) : ("scheduled" as const),
      matches: plans.map((plan, matchIndex) => {
        if (!plan.entrants) throw new Error(`round-robin series ${plan.index} has no entrants`);
        return matchFor(plan, `week-${number}-match-${matchIndex + 1}`, plan.entrants);
      }),
    };
  });

  const table: DraftTableRow[] = league.franchises.map((franchise) => ({
    entrant: franchise.entrant,
    w: 0,
    l: 0,
    gw: 0,
    gl: 0,
  }));
  for (const series of league.series) {
    if (series.stage !== "roundrobin" || series.round > releasedThroughWeek) continue;
    const [a, b] = series.sides;
    const rowA = table[a];
    const rowB = table[b];
    if (!rowA || !rowB)
      throw new Error(`series ${series.seriesIndex} references an unknown franchise`);
    if (series.winner !== null) {
      if (series.winner === a) {
        rowA.w += 1;
        rowB.l += 1;
      } else {
        rowB.w += 1;
        rowA.l += 1;
      }
    }
    rowA.gw += series.score[0];
    rowA.gl += series.score[1];
    rowB.gw += series.score[1];
    rowB.gl += series.score[0];
  }
  const ranked = rankedTable(table);
  const standings = ranked.map((row, index) => ({
    rank: index + 1,
    franchiseId: franchiseId(row.entrant),
    seriesWins: row.w,
    seriesLosses: row.l,
    gameWins: row.gw,
    gameLosses: row.gl,
    differential: row.gw - row.gl,
  }));

  let playoffs: PublicSeasonBundle["playoffs"] = null;
  if (releasedThroughWeek === totalWeeks && releasedPlayoffRounds > 0) {
    const playoffPlans = options.plans.filter((plan) => plan.stage === "playoff");
    const seeding = ranked.map((row) => row.entrant);
    const bracket = buildDraftPlayoffBracket(playoffPlans, seeding);
    const winnerOf = (seriesIndex: number): number | null =>
      seriesByIndex.get(seriesIndex)?.winner ?? null;
    playoffs = {
      rounds: bracket.map((round, roundIndex) =>
        round.map((entry, matchIndex) => {
          const seriesIndex = entry.seriesIndex;
          if (seriesIndex === null)
            throw new Error(
              `playoff round ${roundIndex + 1} match ${matchIndex + 1} has no series`,
            );
          const plan = playoffPlans.find((candidate) => candidate.index === seriesIndex);
          if (!plan) throw new Error(`playoff series ${seriesIndex} has no plan`);
          let slots: [number | null, number | null] = entry.slots;
          if (roundIndex > 0) {
            const feeders = bracket[roundIndex - 1]!.slice(matchIndex * 2, matchIndex * 2 + 2);
            const feederWinner = (feeder: { seriesIndex: number | null } | undefined) =>
              feeder?.seriesIndex === null || feeder === undefined
                ? null
                : winnerOf(feeder.seriesIndex);
            slots = [feederWinner(feeders[0]), feederWinner(feeders[1])];
          }
          const id = `playoff-${roundIndex + 1}-match-${matchIndex + 1}`;
          const match =
            slots[0] !== null && slots[1] !== null && released(plan)
              ? matchFor(plan, id, [slots[0], slots[1]])
              : null;
          return {
            seriesIndex,
            round: roundIndex + 1,
            slots: [
              slots[0] === null ? null : franchiseId(slots[0]),
              slots[1] === null ? null : franchiseId(slots[1]),
            ],
            match,
          };
        }),
      ),
    };
  }

  const releasedWindows = league.transactions.filter(
    (tradeWindow) =>
      tradeWindow.state === "complete" && tradeWindow.afterWeek <= releasedThroughWeek,
  );
  const transactions: PublicSeasonBundle["transactions"] = releasedWindows.map((tradeWindow) => ({
    afterWeek: tradeWindow.afterWeek,
    order: tradeWindow.order.map(franchiseId),
    offers: tradeWindow.offers.map((offer) => ({
      from: franchiseId(offer.from),
      to: offer.to === null ? null : franchiseId(offer.to),
      give: offer.give,
      get: offer.get,
      message: offer.message,
      accepted: offer.accepted,
      offerReasoning: offer.offerReasoning,
      responseReasoning: offer.responseReasoning,
    })),
    moves: tradeWindow.decisions.map((decision) => ({
      franchiseId: franchiseId(decision.entrant),
      swaps: decision.swaps.map(({ drop, add }) => ({ drop, add })),
      swapsRemaining: decision.swapsRemaining,
      reasoning: decision.reasoning,
      fallback: decision.fallback,
    })),
  }));
  const weeklyReviews: PublicSeasonBundle["weeklyReviews"] = league.weeklyReviews
    .filter(
      (review) =>
        review.week <= releasedThroughWeek &&
        (review.reasoning.trim().length > 0 || review.memoryCharacters > 0 || review.fallback),
    )
    .map((review) => ({
      week: review.week,
      stage: review.stage,
      franchiseId: franchiseId(review.entrant),
      rosterVersion: review.rosterVersion,
      reasoning: review.reasoning,
      memoryPages: review.memoryPages,
      memoryCharacters: review.memoryCharacters,
      fallback: review.fallback,
    }));
  const releasedRosters = replayReleasedRosters(league.franchises, releasedWindows, options.board);

  const franchises = league.franchises.map((franchise) => {
    const roster = releasedRosters.get(franchise.entrant);
    if (!roster)
      throw new Error(`league ${league.runId} is missing franchise ${franchise.entrant}`);
    const spent = roster.reduce((total, slot) => total + slot.cost, 0);
    const record = table[franchise.entrant]!;
    return {
      id: franchiseId(franchise.entrant),
      name: franchiseName(franchise.teamName, franchise.model),
      model: franchise.model,
      budget: { total: league.budget!, spent, remaining: league.budget! - spent },
      roster,
      record: {
        seriesWins: record.w,
        seriesLosses: record.l,
        gameWins: record.gw,
        gameLosses: record.gl,
      },
      finish: seasonReleased && franchise.finish ? franchise.finish : null,
    };
  });

  const picks = league.franchises
    .flatMap((franchise) =>
      franchise.draftRoster
        .filter((slot) => slot.pick !== null)
        .map((slot) => ({
          overall: slot.pick!,
          round: Math.ceil(slot.pick! / league.franchises.length),
          franchiseId: franchiseId(franchise.entrant),
          pokemon: { id: slot.id, name: slot.name, spriteId: slot.spriteId, cost: slot.cost },
          rationale: slot.rationale,
          fallback: slot.fallback,
        })),
    )
    .sort((a, b) => a.overall - b.overall);
  const draftedBy = new Map(picks.map((pick) => [pick.pokemon.id, pick.franchiseId]));

  const status = (() => {
    if (options.releasedThroughWeek === 0) return "draft" as const;
    if (seasonReleased) return "complete" as const;
    if (
      releasedPlayoffRounds > 0 ||
      (releasedThroughWeek === totalWeeks && league.phase !== "roundrobin")
    )
      return "playoffs" as const;
    return "regular-season" as const;
  })();
  const lastReleased = league.series
    .filter((series) => {
      const plan = planByIndex.get(series.seriesIndex);
      return plan !== undefined && released(plan) && options.games.has(series.seriesId);
    })
    .map((series) => series.timestamp)
    .filter(Boolean)
    .sort()
    .at(-1);

  return publicSeasonBundleSchema.parse({
    generatedAt: options.generatedAt ?? lastReleased ?? league.when,
    season: {
      id: league.runId,
      title: options.title,
      format: league.format,
      board: { id: league.board, budget: league.budget, picksPerFranchise: league.picksPerEntrant },
      startedAt: league.when,
      status,
      releasedThroughWeek,
      releasedPlayoffRounds,
      totalWeeks,
      playoffRounds,
      sheets: options.closedSheets ? "closed" : "open",
      swapsAllowed: league.swapsAllowed,
      championId: seasonReleased && league.champion ? franchiseId(league.champion.entrant) : null,
    },
    provenance: {
      showdownCommit: options.showdownCommit,
      models: league.franchises.map((franchise) => ({
        franchiseId: franchiseId(franchise.entrant),
        spec: franchise.model,
      })),
    },
    franchises,
    board: options.board.map((mon) => ({
      id: mon.id,
      name: mon.name,
      spriteId: mon.spriteId,
      cost: mon.cost,
      types: [...mon.types],
      abilities: [...mon.abilities],
      baseStats: { ...mon.baseStats },
      megaStone: mon.item || null,
      draftedBy: draftedBy.get(mon.id) ?? null,
    })),
    draft: { picks },
    standings,
    weeks,
    transactions,
    weeklyReviews,
    playoffs,
    replays,
    reviews: seasonReleased
      ? league.seasonReviews.map((review) => ({
          franchiseId: franchiseId(review.entrant),
          outcome: review.outcome,
          summary: review.summary,
          didWell: review.didWell,
          didPoorly: review.didPoorly,
          wouldChange: review.wouldChange,
          fallback: review.fallback,
        }))
      : [],
  });
}
