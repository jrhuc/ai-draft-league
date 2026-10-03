# Operate the league harness

Run these commands from `packages/league` after completing the [local setup](../README.md#run-locally). `pnpm run vgcleague --help` lists current options.

## Configure a provider

Use `<OpenCode-provider-id>:<model-id>`, or a fixed policy: `random` or `bot`. Common providers are:

| Prefix         | Provider             | Environment variable |
| -------------- | -------------------- | -------------------- |
| `opencode:`    | OpenCode Zen         | `OPENCODE_API_KEY`   |
| `opencode-go:` | OpenCode Go          | `OPENCODE_API_KEY`   |
| `openrouter:`  | OpenRouter           | `OPENROUTER_API_KEY` |
| `random`       | Seeded random engine | None                 |
| `bot`          | Fixed league policy  | None                 |

`bot` drafts by board cost, spending its budget on six core picks and filling the bench at the board minimum. It builds the six highest-cost picks, at most two of them Megas, from tournament pastes in `teams/`, Showdown's curated Champions random-doubles sets, or a move heuristic, in that order. It battles with the standard `search`. It files no reviews and makes no transactions, and it declines every trade.

Any other provider in the OpenCode catalog works with its own environment key; the catalog only lists providers whose key is present.

OpenCode owns the provider catalog, credentials, and routing. `VGC_MODEL_UPSTREAM=opencode:muse-spark-1.3-contributor-free=muse-spark-1.3` bills a seat to another model id on the same provider (for example a free tier's paid twin once its quota is spent) while the run keeps recording the original identity; the target's cost table is used for spend. Additional provider configuration belongs in `<run-dir>/agents/opencode.json`, using the [OpenCode V2 provider schema](https://opencode.ai/v2/docs/providers). The embedded host excludes project configuration and uses only league tools. Its native databases stay in the private run directory.

The SDK and plugin use matching, exactly pinned `dev` builds. OpenCode packages are exempt from pnpm's release-age delay so upgrades can use newly published model APIs.

Use OpenCode provider settings for custom endpoints. OpenRouter requests set `allow_fallbacks: false`. Set `VGC_OPENROUTER_PIN` to one upstream provider name to restore an explicit pin, for example `VGC_OPENROUTER_PIN=Anthropic`. Comma-separated pins are rejected. Keep the same routing policy when resuming a session. Claude system prompts carry an ephemeral cache hint through the native protocol.

`--reasoning` selects a variant from the chosen OpenCode model. Omitting it uses the model's default. Unavailable models or variants fail before model dispatch. OpenCode owns infrastructure retries and native tool correction. A reply that ends without an accepted submission gets two reminders to call its submission tool; the stage fails only after those.

## Choose a run mode

```sh
pnpm run vgcleague selfcheck
pnpm run vgcleague rotation --models model_spec_a model_spec_b --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague tournament --models model_spec_a model_spec_b model_spec_c model_spec_d --pool regmb-202607
pnpm run vgcleague draft --models model_spec_a model_spec_b model_spec_c model_spec_d --board regmc-202609
pnpm run vgcleague exhibition --opponent model_spec
```

| Mode       | Behavior                                                | Comparison role                     |
| ---------- | ------------------------------------------------------- | ----------------------------------- |
| Tournament | Single-elimination bracket with one team per entrant    | Contextual only                     |
| Draft      | Shared draft, matchup builds, round robin, and playoffs | Contextual only                     |
| Rotation   | Mirrored assignments across a fixed pool                | Controlled or contextual; no rating |
| Exhibition | One external terminal-agent seat                        | Uncontrolled; no rating             |

All experiment modes accept `--seed`. Rotation, tournament, and draft accept `--concurrency` and `--timer-scale value`. Battles are untimed by default. Use `--timer-scale 1` for the standard VGC clock or a value from 0.5 through 4 to scale it.

Add `--progress` to any run command to print one JSON line per agent update on stderr: the private session and task, the model, its current activity (`starting`, `generating`, `reasoning`, `tool` with the tool name, `retry`, `compacting`, `ended`), and the session's cost and token usage once known. Updates omit prompt, reasoning, and tool-input text. Programmatic runs receive the same updates through `onAgentProgress`. The optional Showdown clock disables infrastructure retries during decisions; untimed stages retain OpenCode's retry policy.

For a live spectator screen, run `pnpm dev` from the repository root, open `/live`, and choose **Watch live**. The screen shows active agent tasks, reasoning/tool/retry/compaction activity, conversation usage, and an animated Showdown battle. Switch between concurrent series, or uncheck **Follow live** to pause and rewind. Public battle updates arrive over SSE; reconnecting restores the current state. Live snapshots are written automatically, including without `--progress`.

The **Season pages** link opens the same run's draft, standings, and completed replays. These refresh on league transitions. `vgcleague monitor` remains the completed-evidence audit for decision integrity and mechanics.

## Resume a tournament

```sh
pnpm run vgcleague tournament --resume run_directory
```

A seeded event pool preserves bracket positions while shuffling models across teams. `--provenance disclosed` names the event without exposing finishing order to competitive prompts; `blind` removes event context. Competitive prompts omit player names.

Resume validates entrants, teams, seed, provenance, reasoning, timer, draw, and completed evidence. Untimed games replay accepted native submissions from the seed without inference, validating the original inputs, then continue the unfinished conversation. Timed games restart the unresolved game with a new conversation because the elapsed clock and timer substitutions are not checkpointed. Resolved games and their completed reviews are retained. Stop the previous owner before resuming, and never resume one run concurrently.

Native conversations share `<run-dir>/agents/opencode.sqlite`.

## Run or resume a draft league

A draft defaults to the `regmc-202609` [Regulation M-C board](regulation-mc.md), assigns 10 roster entries within 100 points to each franchise, then builds 6 complete sets for every matchup. Each week is completed and reviewed before the next week's builds begin.

```sh
pnpm run vgcleague draft --models model_spec_a model_spec_b --draft-only
pnpm run vgcleague draft --resume run_directory
pnpm run vgcleague draft --models model_spec_a model_spec_b --through-week 3
pnpm run vgcleague draft --models model_spec_a model_spec_b --closed-sheets
pnpm run vgcleague draft --models model_spec_a model_spec_b --transactions off
pnpm run vgcleague draft --models model_spec_a model_spec_b --rosters presets/noise-quartet.json
```

- `--draft-only` records rosters and stops
- `--through-week week_number` runs that week, its review, and any scheduled transaction window before stopping
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

The pinned simulator validates imported teams. The board builder writes `regmc-202609`: prior costs and M-B usage adjustments carry forward, with explicitly provisional prices for the M-C additions. Historical event pools retain their original regulation and provenance.

## Inspect evidence

```sh
pnpm run vgcleague outcomes
pnpm run vgcleague outcomes --pool regmb-202607
pnpm run vgcleague report --pool regmb-202607
```

Without `--pool`, reports exclude only the disposable `test` pool. Rows retain mode, pool, clock, opponents, and sample size. They never merge aliases or compute an aggregate ranking.

Decision logs show authorized context and submitted choices. Join them with game and referee logs to establish accepted transitions and results. See [Evidence interpretation](measurement.md).

Check how the harness behaved in one league run, not just whether its code passed:

```sh
pnpm run vgcleague monitor run_id
pnpm run vgcleague monitor run_id --json
```

The monitor reads `league.sqlite` and the decision, trace, and game files of every completed series. It reports per-seat decision integrity (substitution and parse-failure rates, tool queries, latency, tokens), a mechanics audit that replays every `estimate_damage` and `compare_action_order` result against what the simulator then did, leaving out what-if results (another weather, a Mega, a stat stage, a switch-in, the other turn order) (wrong KO calls, damage outside the predicted range, inverted action order, with forme changes in the same turn marked), the share of draft reasons that name another coach or the season ahead, per-entry roster usage by week and opponent, entries never registered while owned, and how many board Pokémon each memory barrier names, carries, or drops. Findings are evidence to inspect, not verdicts.

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

## Drive a seat from another program

`bridge` plays one battle or one whole league where another program holds a seat. It speaks JSON lines on stdio and is what the `league-evals` Inspect tasks run against:

```sh
node dist/src/cli.js bridge
```

The outside seat is the league's battle coach with its model replaced: it receives the same system prompt, decision prompt, tools, notebook, and submission validation as a league model. Each request is `{"id", "method", "params"}` and is answered by `{"id", "result"}` or `{"id", "error"}`. Lines without an `id` are `{"event"}`.

| Method    | Parameters                                                            | Result                                               |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| `open`    | `format`                                                              | Showdown and harness commits, available seats        |
| `pool`    | `name`                                                                | The pool's packed teams                              |
| `start`   | `seed`, `p1`, `p2` (`name`, `team`, `seat`), `policy_seed`, `script`  | `started`                                            |
| `tool`    | `pid`, `exchange`, `name`, `arguments`                                | The tool's text                                      |
| `submit`  | `pid`, `exchange`, `input`, optional `response`, `reasoning`, `usage` | `accepted`, or the validator's message as an error   |
| `abandon` | `pid`, `exchange`, `reason`                                           | The harness plays its default for that decision      |
| `outcome` |                                                                       | Winner, turns, log, decision rows                    |
| `audit`   |                                                                       | The mechanics audit of the outside seats' tool calls |

| Event      | Meaning                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exchange` | A decision waits for a seat: the task (`system`, `prompt`, `tools`, `submission`) and the `decision` view (`turn`, `phase`, `slot_names`, `menus`, `request`) |
| `decision` | Showdown accepted or rejected a submitted action; the row is the seat's decision log                                                                          |
| `end`      | The game ended; carries the outcome                                                                                                                           |

A `seat` is `external` or a fixed policy. At least one seat must be external.

| Policy                                 | Plays                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `random`                               | A uniformly random legal action                                                |
| `greedy`                               | The highest projected damage for each active Pokémon; never switches by choice |
| `search`, `search:fast`, `search:deep` | The equilibrium of a payoff matrix filled by greedy rollouts                   |

`greedy` and `search` read the simulator's battle, so they know the opposing bench and exact stats. They never see the other side's choice for the current decision. `script` holds recorded choices per side; the bridge replays them and hands over at the first decision past each list.

A session that starts with `league` instead of `open` runs a whole season: the draft, franchise naming, a build before every series, every battle decision and post-game review, weekly reviews, transaction windows, and the season review. `seats` lists `external:<label>` seats and fixed policies (`bot`, `random`); the seed shuffles them into draft order.

| Method    | Parameters                                                                  | Result                                                 |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `league`  | `seats`, `seed`, `run_dir`, optional `board`, `concurrency`, `transactions` | The run directory and the Showdown and harness commits |
| `tool`    | `exchange`, `name`, `arguments`                                             | The tool's text                                        |
| `submit`  | `exchange`, `input`, optional `response`, `reasoning`, `usage`              | `accepted`, or the validator's message as an error     |
| `abandon` | `exchange`, `reason`                                                        | A battle decision plays the harness default            |
| `outcome` |                                                                             | Entrants, team names, standings, series, placement     |

| Event      | Meaning                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `exchange` | A task waits for an outside seat: its `entrant` and the task (`model`, `session`, `system`, `prompt`, `tools`, `submission`) |
| `series`   | A series ended: `stage`, `round`, the two entrants, the score, and the winning entrant                                       |
| `end`      | The season ended or failed; carries the outcome                                                                              |

Tasks on one `session` belong to one conversation: a game and its review, or a franchise's draft. Only battle decisions may be abandoned; an abandoned draft, build, or review fails the season, so a client keeps asking until the validator accepts a submission. `placement` lists entrants in finishing order: the playoff bracket, then regular-season rank. The run directory holds the usual run evidence, so `monitor` and the site's live watch read it as they read any league.

`positions` values recorded turn decisions. It reads one game per line (`id`, `source`, `log`, optional `settings` and `only`) and writes one line per game and per valued decision, with the win rate of every accepted action when both sides continue with the greedy policy:

```sh
node dist/src/cli.js positions < games.jsonl
```

A game whose replay does not reproduce its recorded log is reported unverified and is not valued.
