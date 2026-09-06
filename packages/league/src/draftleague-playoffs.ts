import { buildDraftPlayoffBracket } from "./draftleague-protocol.js";
import { playSeries } from "./draftleague-series.js";
import { renderMemory } from "./franchise-memory.js";
import type { DraftLeagueContext, LeagueCoordinator } from "./league-coordinator.js";
import { runSeasonReview } from "./season-review.js";
import { mapLimit } from "./series.js";
import { applyBracketOutcome, type BracketMatch } from "./tournament.js";
import type { Pid } from "./types.js";
import { ordinal } from "./value.js";
import type { BracketView } from "./views.js";

interface FinishedEntrant {
  entrant: number;
  outcome: string;
}

export async function runPlayoffPhase(
  context: DraftLeagueContext,
  runtime: LeagueCoordinator,
): Promise<void> {
  const { entrants, options, plans, playoffRounds, runId } = context;

  const closeSeason = async (finished: FinishedEntrant[]): Promise<void> => {
    if (!finished.length || options.signal?.aborted) return;
    await runSeasonReview(
      finished,
      {
        board: context.board,
        models: entrants,
        picks: runtime.picks,
        rosters: runtime.rosters,
        windows: runtime.windowArtifacts,
        standings: runtime.standings(),
        series: runtime.franchises.map(({ opponentDossiers }) =>
          [...opponentDossiers.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry),
        ),
        notebooks: runtime.memories.map((memory) => renderMemory(memory, "full").join("\n")),
      },
      context.reviewOptions,
    );
  };
  const seasonJobs: Promise<void>[] = [];
  let seasonFailure: Error | undefined;
  const startSeasonClose = (finished: FinishedEntrant[]): void => {
    seasonJobs.push(
      closeSeason(finished).catch((cause) => {
        seasonFailure ??= cause instanceof Error ? cause : new Error(String(cause));
      }),
    );
  };
  const finish = async (): Promise<void> => {
    await Promise.all(seasonJobs);
    if (seasonFailure !== undefined && !options.signal?.aborted) throw seasonFailure;
  };

  const seeding = runtime.standings().map((row) => row.entrant);
  runtime.transition({ phase: "playoffs", round: 0 });
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });

  const playoffCut = playoffRounds === 2 ? 4 : 2;
  startSeasonClose(
    seeding.slice(playoffCut).map((entrant, index) => ({
      entrant,
      outcome: `You finished ${ordinal(playoffCut + index + 1)} of ${entrants.length} in the round robin and missed the playoffs. Your season is over.`,
    })),
  );
  if (options.signal?.aborted) return finish();

  const playoffs = plans.filter((plan) => plan.stage === "playoff");
  let bracketRounds = buildDraftPlayoffBracket(playoffs, seeding);
  const bracketView = (): BracketView => {
    const championship = bracketRounds.at(-1)?.[0];
    if (!championship) throw new Error(`run ${runId} has no championship bracket match`);
    return {
      entrants: entrants.map((model, index) => ({
        model,
        team: runtime.teamNames[index] || `seed ${seeding.indexOf(index) + 1}`,
      })),
      rounds: bracketRounds.map((round) =>
        round.map((match) => ({
          seriesIndex: match.seriesIndex,
          slots: [...match.slots],
          winner: match.winner,
        })),
      ),
      champion: championship.winner,
    };
  };
  options.onEvent?.({ type: "bracket", bracket: bracketView() });

  const resolve = (scheduled: BracketMatch, winnerSide: Pid): number => {
    const winner = scheduled.slots[winnerSide === "p1" ? 0 : 1];
    if (winner === null) throw new Error(`run ${runId} cannot resolve an empty playoff slot`);
    bracketRounds = applyBracketOutcome(bracketRounds, scheduled, winnerSide);
    options.onEvent?.({ type: "bracket", bracket: bracketView() });
    return winner;
  };
  const playMatch = async (
    plan: (typeof playoffs)[number],
    scheduled: BracketMatch,
    signal: AbortSignal,
  ): Promise<number> => {
    const [first, second] = scheduled.slots;
    if (first === null || second === null) {
      throw new Error(`run ${runId} playoff series ${plan.index} has unresolved bracket slots`);
    }
    plan.entrants = [first, second];
    await playSeries(context, runtime, plan, signal);
    const winnerSide = runtime.outcomeFor(plan).winnerSide;
    if (!winnerSide)
      throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
    return resolve(scheduled, winnerSide);
  };

  if (playoffRounds === 2) {
    runtime.transition({ phase: "playoffs", round: 1 });
    const semis = bracketRounds[0]!;
    await mapLimit(
      [0, 1],
      Math.min(options.concurrency ?? 4, 2),
      options.signal,
      (matchIndex, signal) => playMatch(playoffs[matchIndex]!, semis[matchIndex]!, signal),
    );
    if (options.signal?.aborted) return finish();
    startSeasonClose(
      bracketRounds[0]!.flatMap((match) => {
        const loser = match.slots.find((slot) => slot !== null && slot !== match.winner);
        return loser === null || loser === undefined
          ? []
          : [
              {
                entrant: loser,
                outcome: `You reached the playoffs as the ${ordinal(seeding.indexOf(loser) + 1)} seed and were eliminated in the semifinals. Your season is over.`,
              },
            ];
      }),
    );
    if (options.signal?.aborted) return finish();
  }

  runtime.transition({ phase: "playoffs", round: playoffRounds });
  const finalPlan = playoffs[playoffs.length - 1]!;
  const scheduledFinal = bracketRounds[playoffRounds - 1]![0]!;
  if (scheduledFinal.slots.includes(null)) return finish();
  const [champion] = await mapLimit([finalPlan], 1, options.signal, (plan, signal) =>
    playMatch(plan, scheduledFinal, signal),
  );
  if (champion === undefined) return finish();
  const runnerUp = finalPlan.entrants!.find((entrant) => entrant !== champion);
  await closeSeason([
    ...(runnerUp === undefined
      ? []
      : [
          {
            entrant: runnerUp,
            outcome:
              "You reached the final and lost it. You are the league runner-up and your season is over.",
          },
        ]),
    {
      entrant: champion,
      outcome: "You won the final. You are the league champion and the season is over.",
    },
  ]);
  runtime.transition({ phase: "done", champion });
  options.onEvent?.({ type: "draft", draft: runtime.draftView(true) });
  return finish();
}
