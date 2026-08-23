# Weekly review

Weekly review updates the private memory that a franchise manager carries through the season. This page explains when reviews run, which evidence they can read, and how their replies persist.

## Memory across the season

Memory is the only seat-private state that lasts for the whole season. The draft writes the first `notebook` page. Weekly reviews and post-window reconciliations can update memory. Team builds and transaction decisions read it, and the season review receives its final form. No other stage writes it.

Memory contains named pages. The `notebook` page appears in full in every later prompt for that franchise manager. Every other page appears as an index line with its name, size, and first line. The team builder, transaction stages, and review can fetch a full page with `read_memory_page`.

A franchise manager may hold 16 pages, with at most 8,000 characters per page and 48,000 characters in total. Page names are lowercase slugs. If a reply exceeds a limit, the harness rejects it with the reason and asks the manager to reply again. It does not clip the reply or suggest which pages to keep.

## Review timing

A weekly review runs at each barrier exposed by the league. With `--sequential-weeks`, it runs at the end of every round-robin week. With the default blind batches, it runs at the end of each transaction-window week and at the end of the round robin.

The review runs before the transaction window that opens in the same week, so that window reads the revised memory. `--through-week <n>` completes week `n` and its review, then stops before the transaction window at that barrier. `review_weeks` in `config.json` records the schedule. Playoffs use the final round-robin review.

### Reconciliation after a transaction window

After a transaction window closes, each franchise manager whose roster changed runs reconciliation before any later build. Reconciliation offers the same tools and reply shape as weekly review, but supplies the roster before and after the window instead of the period's results. The league does not call managers whose rosters did not change.

Reconciliation rows live in `reviews/week-<n>-transactions.jsonl` and bind the new roster version.

## Review inputs

Each franchise manager receives this information for its own seat:

- Standings through the week
- Its series since the previous review, including the result, registered sets, and final battle note
- Public results for every other series in the same period
- Its remaining schedule with each opponent's current roster
- Public transactions from the season so far
- Its roster and current memory
- The next transaction window, or notice that rosters are locked

The review also has the draft dex and board tools plus five league tools:

- **`read_public_series`**: returns the spectator log for any completed series. Closed sheets never publish `|showteam|`, so the tool returns exactly what a viewer saw
- **`read_own_series`**: returns the manager's turn-by-turn choices, reasons supplied at the time, and end-of-game notes
- **`read_own_build`**: returns the six registered for a series, the plan, and what remained on the roster held at that time. It also returns the Pokémon brought and Mega Evolved in each game, based on the game log
- **`read_memory_page`**: returns one of the manager's memory pages in full
- **`read_memory_history`**: returns that manager's memory after an earlier barrier as `{week, stage}`. `stage` is `week` for weekly review or `transactions` for reconciliation. A same-week weekly review remains readable from its reconciliation

A manager cannot read another seat's decisions, builds, or memory. Each matchup gets a new build. Later build prompts list the manager's own earlier results and registrations, but include full context against the same opponent only when that matchup repeats.

## Reply shape

The manager replies with one JSON object. Every field is optional, and every omission preserves the current value:

- **`notebook`**: replaces the `notebook` page
- **`set_pages`**: writes the named pages and leaves all other pages unchanged
- **`delete_pages`**: removes the named pages and is the only way to remove a page
- **`reasoning`**: records the manager's stated reasoning as evidence

`{}` is a complete answer that leaves memory unchanged. The harness rejects a reply that sets and deletes the same page, deletes `notebook`, or uses the retired whole-replacement `pages` field. It returns the rejection reason, and no unnamed page can be lost.

## Visibility and release

Review reasoning remains private from other active managers while its barrier is open. The season bundle releases that reasoning only with the completed week or transaction window. [Publication boundary](architecture.md#publication-boundary) lists the data that never leaves the run directory.

The spectator site is outside every manager's information set. Seats have no browser, HTTP, Model Context Protocol (MCP), URL-fetch, or spectator-site tool, and the selected provider must not add built-in web search. Any network-capable seat tool requires a new review of this policy.

Memory pages never enter the season bundle. The public review record contains only the reasoning and memory size in pages and characters. [Interpret league evidence](measurement.md#how-to-interpret-reviews) covers the limits on claims based on that reasoning.

## Persistence and resume

`reviews/week-<n>.jsonl` stores one row per franchise manager. Each row includes entrant and model identity, stage, week, roster version, the complete memory after review, reasoning, and fallback status. Rows appear in completion order and replay in file order. An entrant may appear only once in a stage file.

Seat transcripts live under `reviews/week-<n>/`, with one row per answer attempt. They retain response text, finish reason, latency, usage, and tool calls with their results. Provider adapters own external-call timeouts and transport retries. Weekly review retries only rejected answer shapes.

On resume, completed rows replay without provider calls. A stored transaction window must follow the complete review for its week. Later evidence must follow reconciliation for every roster changed by that window. Resume stops when identity, roster version, or barrier ordering does not match.
