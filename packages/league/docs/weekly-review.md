# Update manager memory

Weekly review updates the private memory a franchise manager carries through the season. Reviews run automatically at configured draft barriers; they have no standalone command.

## Keep season memory

Memory is the only seat-private state that lasts through the season. The draft writes the first `notebook` page; weekly reviews and transaction reconciliations can update it. Builds and transactions read memory, and the season review receives its final form.

The `notebook` page appears in full in later prompts. Other pages appear as an index with name, size, and first line; authorized stages can fetch them with `read_memory_page`.

A manager can hold 16 pages, with 8,000 characters per page and 48,000 characters total. The harness rejects invalid updates instead of clipping them.

## Schedule reviews

The default blind scheduler reviews after each transaction-window week and after the round robin. `--sequential-weeks` reviews after every round-robin week.

Review runs before a transaction window so the window receives revised memory. `--through-week week_number` completes the requested week, its review, and any scheduled window before pausing. `review_weeks` in `config.json` records the schedule.

### Reconcile a roster change

After a window closes, each manager whose roster changed runs reconciliation before any later build. Reconciliation uses the review tools and reply shape, but receives the rosters before and after the window instead of recent results.

## Supply review evidence

Each manager receives its standings, recent series and final notes, other public results from the period, remaining schedule, public transactions, current roster and memory, and the next roster-lock or transaction barrier.

Review tools can read:

- **`read_public_series`**: the spectator log for any completed series
- **`read_own_series`**: private choices, stated reasons, and final notes
- **`read_own_build`**: registered sets, plan, brought Pokémon, and Mega Evolution
- **`read_memory_page`**: one current memory page
- **`read_memory_history`**: memory after an earlier weekly or transaction barrier

A manager cannot read another seat's decisions, builds, or memory.

## Apply memory updates

Every reply field is optional. Omitted memory fields stay unchanged; omitted reasoning records no stated rationale:

- **`notebook`**: replace the `notebook` page
- **`set_pages`**: write named pages without changing others
- **`delete_pages`**: remove named pages
- **`reasoning`**: record optional stated reasoning as evidence

`{}` leaves memory unchanged. The harness rejects conflicting updates, deletion of `notebook`, or the retired `pages` field.

## Persist private and public evidence

`reviews/week-{week_number}.jsonl` stores weekly review rows. `reviews/week-{week_number}-transactions.jsonl` stores reconciliation rows. Per-seat transcripts retain response attempts and tool calls.

Completed rows replay without provider calls. Resume rejects mismatched identity, roster versions, or barrier order.

Memory pages never enter the public bundle. Released review records contain only stated reasoning and memory size. See [Evidence interpretation](measurement.md#interpret-reviews).
