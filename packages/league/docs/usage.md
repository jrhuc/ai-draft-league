# Operate the league harness

Run these commands from `packages/league` after completing the [local setup](../README.md#run-locally). `pnpm run vgcleague --help` lists current options.

## Configure a provider

Use one of these model specification prefixes:

| Prefix          | Environment variable |
| --------------- | -------------------- |
| `openrouter:`   | `OPENROUTER_API_KEY` |
| `prime:`        | `PRIME_API_KEY`      |
| `gateway:`      | `AI_GATEWAY_API_KEY` |
| `opencode-go:`  | `OPENCODE_API_KEY`   |
| `opencode-zen:` | `OPENCODE_API_KEY`   |
| `random`        | None                 |

Model specifications never accept a base URL.

For OpenRouter, `--nitro` changes the requested model specification. `VGC_OPENROUTER_PIN=provider_name` supplies upstream routing metadata without changing persisted run identity.

Reasoning levels support `minimal`, `low`, `medium`, `high`, or `xhigh` where the provider accepts them. Provider adapters own infrastructure retries and error classification. Draft, review, transaction, and build stages retry only answers that fail their response contract.

## Choose a run mode

```sh
pnpm run vgcleague selfcheck
pnpm run vgcleague rotation --models model_spec_a model_spec_b --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague tournament --models model_spec_a model_spec_b model_spec_c model_spec_d --pool regmb-202607
pnpm run vgcleague draft --models model_spec_a model_spec_b model_spec_c model_spec_d --board regmb-202607
pnpm run vgcleague exhibition --opponent model_spec
```

| Mode       | Behavior                                                | Comparison role                     |
| ---------- | ------------------------------------------------------- | ----------------------------------- |
| Tournament | Single-elimination bracket with one team per entrant    | Contextual only                     |
| Draft      | Shared draft, matchup builds, round robin, and playoffs | Contextual only                     |
| Rotation   | Mirrored assignments across a fixed pool                | Controlled or contextual; no rating |
| Exhibition | One external terminal-agent seat                        | Uncontrolled; no rating             |

All experiment modes accept `--seed`. Rotation, tournament, and draft accept `--concurrency` and `--timer-scale value`. Battles are untimed by default. Use `--timer-scale 1` for the standard VGC clock or a value from 0.5 through 4 to scale it.

## Resume a tournament

```sh
pnpm run vgcleague tournament --resume run_directory
```

A seeded event pool preserves bracket positions while shuffling models across teams. `--provenance disclosed` names the event without exposing finishing order to competitive prompts; `blind` removes event context. Competitive prompts omit player names.

Resume validates entrants, teams, seed, provenance, reasoning, timer, draw, and completed evidence. It replays eligible decisions without provider calls, then continues or restarts the unfinished game. Stop the previous owner before resuming, and never resume one run concurrently.

## Run or resume a draft league

A draft assigns 10 roster entries within 100 points to each franchise, then builds 6 complete sets for every matchup. Builds cannot read results from other matches in the same blind batch.

```sh
pnpm run vgcleague draft --models model_spec_a model_spec_b --draft-only
pnpm run vgcleague draft --resume run_directory
pnpm run vgcleague draft --models model_spec_a model_spec_b --through-week 3
pnpm run vgcleague draft --models model_spec_a model_spec_b --sequential-weeks
pnpm run vgcleague draft --models model_spec_a model_spec_b --closed-sheets
pnpm run vgcleague draft --models model_spec_a model_spec_b --transactions off
pnpm run vgcleague draft --models model_spec_a model_spec_b --rosters presets/noise-quartet.json
```

- `--draft-only` records rosters and stops
- `--through-week week_number` runs that week, its review, and any scheduled transaction window before stopping
- `--sequential-weeks` plays and reviews one week at a time
- `--closed-sheets` hides team sheets until their reveal point
- `--transactions off` disables windows; a comma-separated value such as `2,4` chooses window weeks
- `--swaps count` changes the season free-agent allowance from its default of 6
- `--rosters preset_path` uses a validated preset instead of a live draft

Private memory persists through drafts, reviews, transactions, and reconciliation. Match plans and battle notebooks remain series-scoped, though authorized final notes can enter later playoff context. Each manager records a [season review](season-review.md) when its season ends.

`config.json` records the models, seating, seed, board, format, Showdown commit, timer, sheet policy, schedule, transactions, and provider specifications. Resume rejects inconsistent stored state or evidence ordering.

## Build immutable inputs

Team pools live at `teams/pool_name/pool.json`; draft boards live at `boards/board_name.json`. Never change an input after it has recorded results.

```sh
pnpm run build-pool -- teams/pool_name/sources.json
pnpm run build-event-pool -- teams/pool_name/sources.json
pnpm run build-board
```

The pinned simulator validates imported teams. The current board builder uses its fixed Regulation MB cost source.

## Inspect evidence

```sh
pnpm run vgcleague outcomes
pnpm run vgcleague outcomes --pool regmb-202607
pnpm run vgcleague report --pool regmb-202607
```

Without `--pool`, reports exclude only the disposable `test` pool. Rows retain mode, pool, clock, opponents, and sample size. They never merge aliases or compute an aggregate ranking.

Decision logs show authorized context and submitted choices. Join them with game and referee logs to establish accepted transitions and results. See [Evidence interpretation](measurement.md).

## Archive and publish

Archive run directories to verified tarballs without deleting their sources:

```sh
pnpm run archive-run -- run_id
```

Runs come from `$VGC_LEAGUE_DATA_DIR/runs` when configured. Archives go to `$VGC_RUN_ARCHIVE_DIR` or `~/vgc-run-archive`.

Export one explicit spectator release:

```sh
pnpm run export:season \
  --run run_id \
  --through-week 1 \
  --title "AI Draft League"
```

`--through-week` is required. `--through-week 0` publishes a completed draft; later values release regular-season weeks and playoff rounds. Use `--out output_file` to choose the destination. See [Publish a season bundle](deployment.md).

## Use the Exhibition seat

Exhibition writes `runs/run_id/agent/seat.mjs`, `SEAT.md`, and a token. Start the external terminal agent in that directory.

The loopback bridge and owner-only file modes protect the token but do not sandbox the agent. Same-user processes can read the workspace. Treat Exhibition as trusted, manual, unrated use.

During a live process, request omitted authorized history with:

```sh
node seat.mjs context '{"after":"ctx-00000010","limit":50}'
```

This cannot recover memory from an earlier external process.
