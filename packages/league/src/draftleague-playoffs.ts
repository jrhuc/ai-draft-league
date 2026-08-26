import type { DraftLeagueSeriesPlan } from "./draftleague-protocol.js";
import { buildDraftPlayoffBracket, rankedTable } from "./draftleague-protocol.js";
import type { DraftLeagueContext } from "./draftleague-state.js";
import { DraftLeagueRuntime, sortedSeries } from "./draftleague-state.js";
import { renderMemory } from "./franchise-memory.js";
import type { SeriesRecord } from "./records.js";
import { runSeasonReview, type RunSeasonReviewOptions } from "./season-review.js";
import { mapLimit } from "./series.js";
import { applyBracketOutcome, type BracketMatch } from "./tournament.js";
import type { Pid } from "./types.js";
import { ordinal } from "./value.js";
import type { BracketView } from "./views.js";

export type PlayDraftLeagueSeries = (
  plan: DraftLeagueSeriesPlan,
  signal: AbortSignal,
) => Promise<SeriesRecord>;

export type ApplyDraftLeagueOutcome = (plan: DraftLeagueSeriesPlan) => void;

interface FinishedEntrant {
  entrant: number;
  outcome: string;
}

export async function runPlayoffPhase(
  context: DraftLeagueContext,
  runtime: DraftLeagueRuntime,
  playSeries: PlayDraftLeagueSeries,
  applyOutcome: ApplyDraftLeagueOutcome,
  reviewOptions: RunSeasonReviewOptions,
): Promise<SeriesRecord[]> {
  const { entrants, options, plans, playoffRounds, runId } = context;
  const { completed, playoffContext, results, table, windowArtifacts } = runtime;
  const draftView = () => runtime.draftView(true);

  const closeSeason = async (finished: FinishedEntrant[]): Promise<void> => {
    if (!finished.length || options.signal?.aborted) return;
    await runSeasonReview(
      finished,
      {
        board: context.board,
        models: entrants,
        picks: runtime.picks,
        rosters: runtime.rosters,
        windows: windowArtifacts,
        standings: rankedTable(table),
        series: playoffContext.map((entries) =>
          [...entries.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry),
        ),
        notebooks: runtime.memories.map((memory) => renderMemory(memory, "full").join("\n")),
      },
      reviewOptions,
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
  const finish = async (): Promise<SeriesRecord[]> => {
    await Promise.all(seasonJobs);
    if (seasonFailure !== undefined && !options.signal?.aborted) throw seasonFailure;
    return sortedSeries(results);
  };

  const seeding = rankedTable(table).map((row) => row.entrant);
  runtime.progress = { phase: "playoffs", round: 0 };
  options.onEvent?.({ type: "draft", draft: draftView() });

  const playoffCut = playoffRounds === 2 ? 4 : 2;
  startSeasonClose(
    seeding.slice(playoffCut).map((entrant, index) => ({
      entrant,
      outcome: `You finished ${ordinal(playoffCut + index + 1)} of ${entrants.length} in the round robin and missed the playoffs. Your season is over.`,
    })),
  );
  if (options.signal?.aborted) return finish();

  const playoffs = plans.filter((plan) => plan.stage === "playoff");
  let bracketRounds = runtime.playoffBracketRounds ?? buildDraftPlayoffBracket(playoffs, seeding);
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
    runtime.playoffBracketRounds = bracketRounds;
    options.onEvent?.({ type: "bracket", bracket: bracketView() });
    return winner;
  };

  if (playoffRounds === 2) {
    runtime.progress = { phase: "playoffs", round: 1 };
    const semis = await mapLimit(
      [0, 1],
      Math.min(options.concurrency ?? 4, 2),
      options.signal,
      async (matchIndex, signal) => {
        const plan = playoffs[matchIndex]!;
        const scheduled = bracketRounds[0]![matchIndex]!;
        const [first, second] = scheduled.slots;
        if (first === null || second === null) {
          throw new Error(`run ${runId} semifinal ${matchIndex + 1} has unresolved bracket slots`);
        }
        plan.entrants = [first, second];
        const existing = completed.get(plan.index);
        if (existing) {
          applyOutcome(plan);
          return existing;
        }
        const row = await playSeries(plan, signal);
        const winnerSide = runtime.outcomeFor(plan).winnerSide;
        if (!winnerSide) {
          throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
        }
        resolve(scheduled, winnerSide);
        return row;
      },
    );
    results.push(...semis);
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

  runtime.progress = { phase: "playoffs", round: playoffRounds };
  const finalPlan = playoffs[playoffs.length - 1]!;
  const finalRound = playoffRounds - 1;
  const scheduledFinal = bracketRounds[finalRound]![0]!;
  const [finalFirst, finalSecond] = scheduledFinal.slots;
  if (finalFirst === null || finalSecond === null) return finish();
  finalPlan.entrants = [finalFirst, finalSecond];
  const storedFinal = completed.get(finalPlan.index);
  const finalRows = storedFinal
    ? [storedFinal]
    : await mapLimit([finalPlan], 1, options.signal, playSeries);
  const finalRow = finalRows[0];
  if (!finalRow) return finish();
  if (storedFinal) applyOutcome(finalPlan);
  const finalWinnerSide = runtime.outcomeFor(finalPlan).winnerSide;
  if (!finalWinnerSide) {
    throw new Error(`draft playoff series ${finalPlan.index + 1} ended without a winner`);
  }
  const champion = storedFinal
    ? finalWinnerSide === "p1"
      ? finalFirst
      : finalSecond
    : resolve(scheduledFinal, finalWinnerSide);
  results.push(finalRow);
  const runnerUp = finalPlan.entrants.find((entrant) => entrant !== champion);
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
  runtime.progress = { phase: "done", champion };
  options.onEvent?.({ type: "draft", draft: draftView() });
  return finish();
}
