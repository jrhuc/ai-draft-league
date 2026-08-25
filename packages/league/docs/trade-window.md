# Change rosters during the season

Transaction windows let franchise managers trade with each other and sign undrafted Pokémon. The current schedule opens a window after weeks 1, 2, and 3, then locks every roster for the rest of the season.

## Current transaction rules

Each franchise gets the same two ways to change its roster:

1. **Trades**: make up to two one-for-one offers in each window
2. **Free agency**: make up to six drop-and-add swaps across the whole season

A trade does not use the free-agency allowance. Unused swaps expire when the week 3 window closes.

The six-swap season allowance follows the approach used by Smogon's Champions draft tournaments, where trades also do not count against the allowance. The harness keeps three windows because the manager decisions are part of the season record. Background sources include the [Wolfey Draft League](https://wolfeydraftleague.com/), [Smogon DCL IV rules](https://www.smogon.com/forums/threads/dcl-iv-admin-decisions-and-announcements.3785811/), the [Smogon draft guide](https://www.smogon.com/articles/beginners-guide-draft), and [UBA transaction rules](https://unitedbattlersassociation.wordpress.com/season-rules-regulations/trades-and-free-agency-rules/).

## When a window opens

A window is a barrier between weeks. Every series through that week must finish before the weekly review and transaction window can run. No later matchup can build against a roster that is still changing.

The order inside a window is fixed:

1. Run the weekly review
2. Process all trade offers
3. Process all free-agent decisions
4. Reconcile the memory of each manager whose roster changed
5. Start later team builds with the new roster version

Managers act from last place to first place using the normal standings tiebreaks. Each manager sees the accepted trades and swaps made earlier in the same window.

With `--sequential-weeks`, each weekly batch reaches its window as soon as the week ends. Without it, series between two windows run as one blind, concurrency-limited batch.

## Trade offers

A manager can make up to `trades_allowed` offers per window. The current season uses two. The stored setting accepts values from zero through three.

Each offer names:

- The receiving franchise
- One roster entry to give
- One roster entry to receive
- A public message
- A private rationale

The other manager immediately accepts or rejects the exact offer. There are no counteroffers, negotiation rounds, multi-Pokémon deals, or transaction fees. A manager may receive any number of offers, even after using its own offer allowance.

Trades can exchange Pokémon with different draft prices. Both resulting rosters must still pass every roster rule. A rejected offer and choosing not to make an offer are both complete decisions, not fallbacks.

## Free-agent swaps

After trades finish, each manager submits one atomic list of free-agent swaps. Every item drops one roster entry and adds one undrafted board entry.

The harness applies the whole list or none of it. If one swap is illegal, the manager receives the rejection reason and submits another answer. A manager can also submit an empty list.

The six-swap allowance is shared across every scheduled window. Drops refund their full board price. Each completed window records how many swaps every franchise has used.

## Roster legality

Every roster produced by a trade or free-agent decision must meet these rules:

- Exactly 10 entries
- No more than 100 draft points
- No entry owned by two franchises
- No repeated base species on one roster
- All Mega Evolution locks satisfied

The harness validates these rules. Model text cannot waive them.

## What managers know

An acting manager receives:

- Current standings and public rosters
- Public transactions from earlier windows
- Its own results and previous series reflections
- Its own franchise memory
- The priced board and remaining free agents
- Its remaining free-agent allowance
- The current window number and rules

A manager responding to a trade also receives the exact offer. Draft dex, board search, and `read_memory_page` remain available.

Prompts present changing the roster and keeping it unchanged as equal options. They do not recommend a diagnosis, target, or transaction.

## Memory and visibility

Trade and free-agent replies record a rationale, but they do not edit franchise memory. If the roster changes, a [reconciliation review](weekly-review.md#reconciliation-after-a-transaction-window) updates that manager's memory before the next build.

Rationales stay private from other active managers. The season bundle releases them to spectators only after the whole window completes. [Evidence interpretation](measurement.md) explains how to report offers, decisions, and stated reasoning without treating rationale as hidden intent.

## Files and resume behavior

Each window writes to `transactions/after-week-<n>/`:

- `window.jsonl` is the append-only decision and replay log
- `window.json` records the completed order, transactions, rationales, rosters, and `swaps_used`

Every completed window increments the roster version. Later builds and series record the version they used. A saved build can resume only when its stage, series, seats, models, and both roster candidate lists still match.

On resume, the harness replays valid completed rows without another provider call. It stops on an incomplete barrier, invalid journal, stale roster binding, or evidence that appears after a missing window. [Architecture](architecture.md#publication-boundary) explains which transaction data can enter a public season bundle.

## Change the schedule

Use a comma-separated list to choose different weeks:

```sh
pnpm run vgcleague draft --models <specs...> --transactions 2,4
```

Use `--transactions off` for a locked-roster control. Use `--swaps <n>` to change the season free-agent allowance. `config.json` records the schedule, the offer cap for each window, and `swaps_allowed`; those values stay fixed for the run.
