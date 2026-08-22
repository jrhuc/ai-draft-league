# Weekly review

A coach's memory is the only seat-private state that carries across a season.
The draft writes its notebook, the weekly review and the post-window
reconciliation revise the whole memory, every team build and transaction
decision reads it, and the season review sees its final form. No other stage
writes it.

## Memory

Memory is a set of named pages. The `notebook` page appears in full in every
later prompt of that coach. Every other page appears in those prompts as an
index line (name, size, first line) and is fetched in full with
`read_memory_page`, which the builder, the transaction stages, and the review
all offer. A coach may hold 16 pages of up to 8,000 characters each, 48,000 in
all; page names are lowercase slugs. A reply that exceeds a limit is rejected
with the reason and the coach replies again; nothing is clipped. The harness
does not suggest what pages to keep or how to organise them.

## When it runs

A review runs at each barrier the league exposes. With `--sequential-weeks`,
that is the end of every round-robin week. With the default blind batches, it is
the end of each transaction-window week and the end of the round robin. The
review precedes the transaction window that opens in the same week, so the
window reads the revised notebook. `--through-week` stops before the review of
the week it stops at.

`review_weeks` in `config.json` records the schedule. Playoffs run on the final
round-robin review.

### Reconciliation after a window

When a transaction window closes, every coach whose roster changed runs a
reconciliation before any later build: the same tools and reply shape, with
the roster before and after the window in place of the period's results.
Coaches whose roster did not change are not called. Rows live in
`reviews/week-<n>-transactions.jsonl` and bind the new roster version.

## What the coach sees

Each coach receives, for its own seat only:

- standings through the week;
- its own series since the previous review: result, registered sets, and its
  final battle note;
- the public results of every other series in the same period;
- its remaining schedule with each opponent's current roster;
- the public transactions of the season so far;
- its roster and its current memory;
- which window opens next, or that rosters are locked.

It has the draft dex and board tools and five league tools:

- `read_public_series` returns the spectator log of any completed series.
  Closed sheets never publish `|showteam|`, so the tool returns exactly what a
  viewer saw.
- `read_own_series` returns the coach's own turn-by-turn choices with the
  reasons it gave at the time and its end-of-game notes.
- `read_own_build` returns the six the coach registered for a series, its
  plan, what was left behind on the roster it held *at the time*, and for each
  game which Pokémon it brought and which one Mega Evolved, read from the game
  log.
- `read_memory_page` returns one of the coach's own pages in full.
- `read_memory_history` returns the coach's own memory as it stood after an
  earlier barrier: `{week, stage}` where `stage` is `week` (the weekly review,
  the default) or `transactions` (the reconciliation after that week's
  window). A build after a window read the reconciled memory, so the two are
  addressed separately; the same week's review is readable from its own
  reconciliation.

A coach cannot read another coach's decisions, builds, or memory. The prompt
states that every coach builds a new six for each matchup and that sets seen in
one series may not return. Later team builds repeat that notice and list the
coach's own results with what it registered; the full context of a series
against the same opponent comes along only when the matchup repeats.

## Response data

The coach replies with one JSON object in which every field is optional and
every omission keeps what exists: `notebook` replaces the notebook page,
`set_pages` writes the pages it names and leaves the rest alone, `delete_pages`
is the only way a page is removed, and `reasoning` is recorded as evidence.
`{}` keeps the current memory unchanged and is a complete answer. A reply that
sets and deletes the same page, deletes the notebook, or uses the retired
whole-replacement `pages` field is rejected with the reason. Nothing a coach
did not name can be lost.

### Release model

Review reasoning is *seat-private while the barrier is open*: no other coach
sees it, and the season bundle releases it to spectators only with its
completed week or transaction window. After release it is public on purpose —
the spectator site exists to show how the managers thought. That is safe
because the site is outside every agent's information set: seats have no
browser, HTTP, MCP, URL-fetch, or spectator-site tool, and the selected
provider must not add built-in web search. Adding any network-capable tool to a
seat would require revisiting this policy. The memory pages themselves never
leave the run directory; the bundle carries only the reasoning and memory size
in pages and characters.

## Persistence and resume

`reviews/week-<n>.jsonl` holds one row per coach: entrant and model identity,
stage, week, roster version, the complete memory after the review, reasoning,
and fallback status. Rows appear in completion order and replay in file order.
An entrant may occur only once in a stage file.

Seat transcripts are under `reviews/week-<n>/`, one row per answer attempt.
They retain response text, finish reason, latency, usage, and tool calls with
their results. Provider adapters own external-call timeouts and transport
retries; the weekly-review stage retries only rejected answer shapes.

Completed rows replay without provider calls. A stored window must follow the
complete review of its week, and later evidence must follow the reconciliation
of every roster that window changed. Resume stops when identity, roster
version, or barrier ordering does not match.
