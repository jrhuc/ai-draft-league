# Understand the league

The `league` package runs competitive Pokémon seasons in which a model can manage each franchise. You choose the models and rules; the harness schedules play, runs every battle against a pinned Pokémon Showdown revision, and records the decisions and results.

Use the command-line interface (CLI) to start, resume, or cancel a run. The sibling [spectator site](../../../apps/site) displays live local runs and exported public data.

## Follow the season

The published season has three parts: roster selection, a round robin with transaction windows, and playoffs. Each franchise keeps its manager identity and private memory throughout the run.

<ol class="season-flow" aria-label="Published season flow">
  <li><strong>Set the roster</strong><span>Draft ten Pokémon or start from a checked preset.</span></li>
  <li><strong>Play weeks 1–3</strong><span>Build six, play a best-of-three, review at each barrier, then open transactions.</span></li>
  <li><strong>Lock rosters</strong><span>Finish weeks 4–7 without further trades or free agency.</span></li>
  <li><strong>Play the top four</strong><span>Run semifinals followed by the final.</span></li>
  <li><strong>Close each season</strong><span>Request a retrospective when each franchise finishes.</span></li>
</ol>

The default schedule opens transaction windows after weeks 1, 2, and 3. Weekly reviews run at those barriers and after the round robin; `--sequential-weeks` reviews every week. A roster change triggers memory reconciliation before the next build. See [Transactions](trade-window.md) and [Weekly review](weekly-review.md).

## Current season rules

The published season has 8 franchises, 7 round-robin weeks, and a 4-team playoff. It starts from a checked roster preset, though the harness also supports live drafts.

- **Rosters**: 10 entries within a 100-point budget; no shared entry; no repeated base species; required Mega stones stay locked
- **Matchups**: build 6 complete sets, bring 4 to each game, and lead 2
- **Series**: best-of-three Champions VGC with open team sheets by default and no battle clock
- **Standings**: series wins, then game differential, then game wins
- **Transactions**: up to 2 one-for-one offers per window and 6 free-agent swaps per season
- **Playoffs**: the top 4 enter semifinals, followed by the final
- **Season reviews**: one retrospective when each franchise finishes

Builds never receive results from other matches in the same blind batch. Later stages receive only state authorized by the schedule.

> Records show what each seat received, submitted, and carried forward. They cannot establish private belief or prove that a rationale caused a later choice. Standings describe one run, not general model quality. See [Evidence interpretation](measurement.md).

## Know the authority boundary

The pinned Pokémon Showdown simulator decides team legality, accepted actions, randomness, battle transitions, timers, and results. League code owns draft rules, schedules, and transactions. Model text is authoritative for neither layer. See [Architecture](architecture.md).
