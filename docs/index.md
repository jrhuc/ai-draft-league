# VGC Model League

VGC Model League is a local harness for running competitive Pokémon seasons in which a language model manages each franchise. You choose the models and league settings. The harness schedules the season, uses a pinned Pokémon Showdown revision for every battle, and records the decisions and results.

Use the CLI or local GUI to start, resume, inspect, or cancel a run. Exported public data goes to the separate [AI Draft League](https://github.com/jrhuc/ai-draft-league) spectator site.

## How a season runs

A season has three parts: roster selection, a round robin with early transaction windows, and playoffs. Each franchise keeps the same manager identity and private memory throughout the run.

<ol class="season-flow" aria-label="Current season flow">
  <li><strong>Set the roster</strong><span>Draft ten Pokémon or start from a checked preset.</span></li>
  <li><strong>Play weeks 1–3</strong><span>Build six, play a best-of-three, review, then open transactions.</span></li>
  <li><strong>Lock rosters</strong><span>Finish weeks 4–7 without further trades or free agency.</span></li>
  <li><strong>Play the top four</strong><span>Run semifinals followed by the final.</span></li>
  <li><strong>Close each season</strong><span>Request a retrospective when each franchise finishes.</span></li>
</ol>

Weeks 1, 2, and 3 each end with a transaction window. The weekly review runs first, followed by trade offers and free agency. If a roster changes, reconciliation updates that manager's memory before the next build. Rosters lock after the week 3 window and stay locked through the playoffs.

You can move or remove the windows with [`--transactions`](usage.md#run-or-resume-a-draft-league).

## Current season rules

The published season has eight franchises, seven round-robin weeks, and a four-team playoff. It starts from a checked eight-roster preset rather than a live draft. The harness also supports live drafts under the same roster rules.

The current rules are:

- **Rosters**: 10 entries within a 100-point budget, no shared entry, no repeated base species, and all Mega Evolution locks enforced
- **Matchups**: build 6 complete sets from the current roster, bring 4 to each game, and lead 2
- **Series**: best-of-three Champions VGC with open team sheets and no battle clock
- **Standings**: series wins, then game differential, then game wins
- **Weekly reviews**: one after every round-robin week; any manager with a changed roster also reconciles memory before its next build
- **Transaction windows**: one after weeks 1, 2, and 3; each manager may make up to 2 one-for-one offers per window
- **Free agency**: 6 drop-and-add swaps per franchise across the whole season; trades do not use this allowance
- **Playoffs**: the top 4 enter semifinals, followed by the final
- **Season reviews**: one retrospective when each franchise's season ends

Builds do not receive results from other matches in the same blind batch. Later builds can receive earlier results only through authorized manager state and playoff context. [Transactions](trade-window.md) explains the order, legality checks, and saved evidence for each window.

> The record shows what each seat received, submitted, and carried forward. It cannot establish private belief or prove that a written rationale caused a later move. Standings describe this run, not the general quality of a model. See [Evidence interpretation](measurement.md).

## What decides outcomes

The embedded Pokémon Showdown simulator, at the exact commit recorded in
`showdown.lock.json`, owns team legality, accepted actions, randomness, battle
transitions, timers, and results. League code handles everything outside the
simulator: draft ownership, budgets, roster size, schedules, and transactions.
Model text is never an authority for either layer. [Architecture](architecture.md)
draws the full boundary map.

## Where to go next

- [Usage](usage.md): install the harness and run it
- [Architecture](architecture.md): follow the runtime and publication paths
- [How franchise managers work](manager-model.md): see which state reaches each model call
- [Evidence interpretation](measurement.md): learn what the artifacts can support
- [AI Draft League](https://github.com/jrhuc/ai-draft-league): browse exported season data
