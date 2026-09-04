# Change rosters during a season

Transaction windows let managers trade with each other and sign undrafted Pokémon. The default schedule opens windows after weeks 1, 2, and 3, then locks rosters.

## Apply transaction limits

Each franchise can use:

1. **Trades**: up to 2 one-for-one offers per window
2. **Free agency**: up to 6 drop-and-add swaps across the season

Trades do not use the free-agent allowance. Unused swaps expire when the final scheduled window closes.

## Process a window

A window is a barrier. Every series through that week must finish before the review and transactions run.

The order is fixed:

1. Run the weekly review
2. Process trade offers
3. Process free-agent decisions
4. Reconcile memory for managers whose roster changed
5. Start later builds with the new roster version

Managers act from last place to first using normal standings tiebreaks. Each manager sees transactions accepted earlier in the same window. `--sequential-weeks` reaches each barrier week by week; the default scheduler runs blind, concurrency-limited batches between barriers.

## Offer a trade

A manager can make up to `trades_allowed` offers. Each offer names the receiving franchise, one entry to give, one to receive, a public message, and a private rationale.

The recipient accepts or rejects that exact offer. The protocol has no counteroffers, negotiation rounds, multi-Pokémon deals, or fees. A manager may receive any number of offers.

Both resulting rosters must remain legal. A rejection and a decision not to offer are complete decisions, not fallbacks.

## Sign a free agent

After trades, each manager submits one atomic list of swaps. Each item drops one roster entry and adds one undrafted board entry.

The harness applies the whole list or none of it. An illegal list returns its rejection reason for another answer. An empty list keeps the roster unchanged. Drops refund their full board price.

## Preserve roster legality

Every completed transaction must leave:

- Exactly 10 entries
- No more than 100 draft points
- No entry owned by 2 franchises
- No repeated base species on one roster
- Every board Mega entry keeps its required stone

Model text cannot waive these checks.

## Supply manager context

An acting manager receives standings, public rosters and transactions, its own results and reflections, private memory, the priced board, remaining free agents and swaps, and the current window rules. A trade recipient also receives the exact offer.

Transaction rationales do not edit memory. If the roster changes, [reconciliation](weekly-review.md#reconcile-a-roster-change) updates memory before the next build. Rationales remain private from active managers and release only after the window completes.

## Persist and resume

Each window writes an append-only `transactions/after-week-{week_number}/window.jsonl` journal and a completed `window.json`. The completed file records order, transactions, rationales, rosters, and `swaps_used`.

Each completed window increments the roster version. Later builds and series bind that version. Resume replays valid rows without provider calls and rejects incomplete barriers, invalid journals, stale roster bindings, or evidence after a missing window.

Configure window weeks with `--transactions`, or disable them with `--transactions off`. Use `--swaps count` for the season allowance. `config.json` fixes these values for the run. See [Usage](usage.md#run-or-resume-a-draft-league).
