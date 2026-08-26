# Use the league

This page covers installation, provider setup, every run mode, and how to
inspect, archive, and publish what a run produced. Commands are shown exactly
as typed; `pnpm run vgcleague --help` always lists the current options.

## Install

You need Node.js 24.18.1 and pnpm 11.22.0.

```sh
npm install --global pnpm@11.22.0 --ignore-scripts --no-audit --no-fund
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm run build
pnpm test
```

`setup:showdown` installs and verifies the official full-commit pin in
`showdown.lock.json`. The harness embeds the simulator itself, not its HTTP
server. To review or move the pin:

```sh
pnpm run check:showdown-update
pnpm run update:showdown
```

The update command builds and tests the candidate and restores the previous
revision if either fails. A pin update is reviewed against the format rules in
[AGENTS.md](../AGENTS.md)
before it is kept.

## Point runs at providers

Models are specified in one of these exact forms:

- `openrouter:<model-id>`
- `prime:<model-id>`
- `gateway:<model-id>` (Vercel AI Gateway)
- `opencode-go:<model-id>` / `opencode-zen:<model-id>` (OpenCode)
- `random`, the legal-action baseline

CLI runs read `OPENROUTER_API_KEY`, `PRIME_API_KEY`, `AI_GATEWAY_API_KEY`, or `OPENCODE_API_KEY` from the environment.

Endpoints are fixed, and model specs never take a base URL:

| Spec            | Endpoint                           | Model IDs                           |
| --------------- | ---------------------------------- | ----------------------------------- |
| `openrouter:`   | `https://openrouter.ai/api/v1`     | listed in the OpenRouter catalog    |
| `prime:`        | `https://api.pinference.ai/api/v1` | entered manually                    |
| `gateway:`      | `https://ai-gateway.vercel.sh/v1`  | entered manually as `creator/model` |
| `opencode-go:`  | `https://opencode.ai/zen/go/v1`    | listed by OpenCode                  |
| `opencode-zen:` | `https://opencode.ai/zen/v1`       | listed by OpenCode                  |

OpenCode serves each model through one API shape. The harness follows OpenCode's endpoint tables: GPT, Grok, and Muse use the Responses API; Claude, Qwen, and MiniMax on Go use the Anthropic Messages API; Kimi, GLM, DeepSeek, MiMo, Hy3, and MiniMax on Zen use chat completions. Gemini requires the Google API and is rejected, so route it through OpenRouter instead.

For OpenRouter, `--nitro` changes the requested model spec, and
`VGC_OPENROUTER_PIN=<provider>` supplies upstream routing metadata without
becoming part of persisted run identity.

If reasoning configuration is omitted, the provider default applies. The CLI
can request `minimal`, `low`, `medium`, `high`, or `xhigh` where the provider
supports explicit levels; unsupported settings fail with the provider's own
error.

Provider adapters own one external-call timeout, SDK transport retries, and
API error classification; a provider failure ends the run after those retries.
Draft, review, transaction, and teambuild stages additionally retry only replies
that break their answer contract. User cancellation aborts any run.

## Pick a mode and run it

```sh
pnpm run vgcleague selfcheck    # one random-vs-random series

pnpm run vgcleague rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague tournament   --models <spec> <spec> <spec> <spec> --pool regmb-202607
pnpm run vgcleague draft   --models <spec> <spec> <spec> <spec> --board regmb-202607
pnpm run vgcleague exhibition --opponent <spec>
```

| Mode       | What happens                                        | Comparison role                  |
| ---------- | --------------------------------------------------- | -------------------------------- |
| Tournament | single-elimination bracket, one team per entrant    | contextual only                  |
| Draft      | shared draft, matchup builds, round robin, playoffs | contextual only                  |
| Rotation   | mirrored assignments across a fixed pool            | controlled/contextual; no rating |
| Exhibition | one external terminal-agent seat                    | uncontrolled; no rating          |

All experiment commands accept `--seed`. Rotation, tournament, and draft also
accept `--concurrency` and `--timer-scale <n|off>`. Battles are untimed by
default; `--timer-scale 1` applies the standard VGC clock, and values from 0.5
through 4 scale Showdown's clocks. Record whichever clock you chose with the
run.

### Resume a tournament

A seeded event pool keeps its actual bracket positions while models are
shuffled across teams. With `--provenance disclosed` (the default) the event
and field are named but competitive prompts omit finishing order; `blind`
omits event context entirely. Competitive prompts never include player names.

```sh
pnpm run vgcleague tournament --resume <run-dir>
```

The stored entrants, pool and teams, seed, provenance, reasoning, timer, draw, and completed evidence define the continuation. Reconstruction replays recorded decisions without provider calls when eligible and requested. Otherwise, it continues the unfinished game live or restarts it. Resume rebuilds explicit state and notes. It does not restore a provider process or chat. Stop the previous owner first, and never resume the same run twice concurrently.

## Run or resume a draft league

A draft takes ten roster entries within 100 points per franchise, then builds six complete sets for every matchup. Builds cannot read results from other matches in the same blind batch. Later builds receive only earlier results authorized by the schedule and saved manager state.

By default, the scheduler runs concurrency-limited blind batches: all series up to each transaction window, then that barrier and its window, then the next batch. Disable windows and the round robin becomes one batch. Use `--sequential-weeks` for week-by-week play.

```sh
pnpm run vgcleague draft --models <specs...> --draft-only
pnpm run vgcleague draft --resume <run-dir>
pnpm run vgcleague draft --models <specs...> --through-week <n>
pnpm run vgcleague draft --models <specs...> --sequential-weeks
pnpm run vgcleague draft --models <specs...> --closed-sheets
pnpm run vgcleague draft --models <specs...> --transactions off
pnpm run vgcleague draft --models <specs...> --rosters presets/noise-quartet.json
```

- `--draft-only` records rosters and stops; resume later to play the season.
- `--through-week <n>` implies sequential weeks and stops cleanly after that
  week's review, before its transaction window.
- `--closed-sheets` switches from the default open team sheets (Champions Bo3
  excludes hidden stat points either way).
- `--transactions` chooses the window weeks or turns them off. The default opens windows after weeks 1, 2, and 3. See [Transactions](trade-window.md) for the full rule
- `--swaps <n>` sets the season free-agent allowance, which defaults to six and remains fixed for the run

`--rosters` seeds the league from a packaged preset instead of holding a live draft. Team names and rosters stand as if drafted, the draft log stays empty, and `config.json` records the preset ID. Presets must fit their board's picks and budget, with no entry repeated across the league.

Use a preset to reach reviews and windows without running a live draft. `presets/noise-quartet.json` contains four original Regulation MB rosters. Three have deliberate flaws: no Mega, no synergy, or unspent budget. `presets/noise-octet.json` extends the preset to eight managers. Each team's `flaw` field is tester-facing and never reaches a manager.

Private notes are explicitly reinjected state, not a persistent provider conversation. Franchise memory persists through the draft, weekly reviews, and transaction windows. A matchup plan and battle notebook apply only to their series. Playoff managers may receive their own earlier builds, results, and final notes. Franchise names are spectator metadata and never enter competitive or review prompts. Each manager records a terminal [season review](season-review.md) when its season ends.

`config.json` records the season facts needed to understand or resume the run: models and seating, seed, board and format, harness and Showdown commits, timer and sheet policy, schedule and transaction options, and provider specifications when present.

Resume validates the stored board, models, seed, rosters, schedule, transaction state, completed results, and authorized playoff context. It stops if any of those records are inconsistent. A draft-only run selects its transaction schedule when season play begins because the run has not held a window yet.

## Manage immutable inputs

Team pools live at `teams/<pool>/pool.json`. Draft boards live at `boards/<board>.json`. Never modify an input after it has recorded results.

```sh
pnpm run build-pool teams/<pool>/sources.json
pnpm run build-event-pool teams/<pool>/sources.json
pnpm run build-board
```

`build-pool` reads Poképaste sources and Showdown teambuilder exports. The pinned simulator validates both. The current board builder uses its fixed Regulation MB cost source and takes no pool.

## Inspect evidence

```sh
pnpm run vgcleague outcomes
pnpm run vgcleague outcomes --pool regmb-202607
pnpm run vgcleague report --pool regmb-202607
```

Without `--pool`, outcomes and reports exclude only the disposable `test` pool. Rows show mode, pool, clock, opponents, and sample size per series. They never merge aliases or compute an aggregate order. Standings and brackets describe only their individual run.

Decision and context logs record authorized observations and submitted model evidence, but they do not prove Showdown accepted a transition. Join them with game and referee logs to establish legality, substitutions, timer defaults, and outcomes.

Public league browsing belongs to the spectator app in [`apps/site`](../../../apps/site). [Architecture](architecture.md) defines the operator, filesystem, provider, simulator, and publication boundaries.

## Archive and publish

Archive full run directories to verified tarballs without deleting the sources:

```sh
pnpm run archive-run <run-id> [<run-id>...]
```

Runs are read from `$VGC_LEAGUE_DATA_DIR/runs` when configured. Output goes to `$VGC_RUN_ARCHIVE_DIR` or `~/vgc-run-archive`. Copy it offsite with operator-managed tooling, then remove source runs manually if needed.

To publish a spectator release, build first, then export one explicit boundary:

```sh
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League"
```

The release boundary is mandatory. Export never infers it from the newest local result. `--through-week 0` publishes a completed draft before any match result. A value past the last regular-season week releases playoff rounds. `--out <file>` chooses the destination — pass `--out ../../apps/site/public/season-bundle.json` to write the spectator app's committed artifact directly (see [Deployment](deployment.md)). Export fails if a named released week is incomplete or lacks verified replay evidence.

`season-bundle.json` carries released public evidence: draft picks with stated rationales, the board, rosters and acquisitions, builds and plans, standings, results, canonical game summaries, structured battle events, submitted decisions, reflections, transactions, weekly review and reconciliation reasoning with memory sizes, the bracket, and end-of-season reviews. It excludes notebooks, traces, prompts, provider responses, credentials, and future results.

[Deployment](deployment.md) covers the release process. [Publication boundary](architecture.md#publication-boundary) defines the bundle's content and authority.

## Use the Exhibition seat

Exhibition creates `runs/<run>/agent/` containing `seat.mjs`, `SEAT.md`, and a token. Start the external terminal agent there. The loopback bearer bridge and owner-only file modes provide token hygiene, not sandboxing. Same-UID processes can read the workspace, and nothing enforces filesystem, process, credential, network, egress, or delegation isolation.

Treat Exhibition as trusted, manual, unrated use only. It cannot support controlled model or scaffold claims. During a live process, page authorized history omitted from the compact prompt with:

```sh
node seat.mjs context '{"after":"ctx-00000010","limit":50}'
```

This command does not recover the memory of an earlier external process.
