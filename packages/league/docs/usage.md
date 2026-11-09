# Operate the league harness

Run these commands from `packages/league` after completing the [local setup](../README.md#run-locally). `pnpm run vgcleague --help` lists current options.

## Configure a provider

Use `<provider>:<model-id>` from the pi-ai catalog, or `random` for the baseline. Common providers are:

| Prefix         | Provider             | Environment variable |
| -------------- | -------------------- | -------------------- |
| `opencode:`    | OpenCode Zen         | `OPENCODE_API_KEY`   |
| `opencode-go:` | OpenCode Go          | `OPENCODE_API_KEY`   |
| `openrouter:`  | OpenRouter           | `OPENROUTER_API_KEY` |
| `random`       | Seeded random engine | None                 |

Any other pi-ai provider works with its own environment key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...). The catalog ships with the pinned pi-ai release, so a model newer than the release is unknown until pi-ai is upgraded. OpenRouter variant suffixes such as `:nitro` reuse their base model's entry.

`VGC_MODEL_UPSTREAM=opencode:muse-spark-1.3-contributor-free=muse-spark-1.3` sends a seat's requests to another model id on the same provider (for example a free tier's paid twin, or an id the catalog does not list) while the run keeps recording the original identity; the target's cost table is used for spend.

OpenRouter requests set `allow_fallbacks: false`. Set `VGC_OPENROUTER_PIN` to one upstream provider name to restore an explicit pin, for example `VGC_OPENROUTER_PIN=Anthropic`. Comma-separated pins are rejected. Keep the same model, reasoning, and routing when resuming a session. Prompt caching follows each provider's protocol, keyed by the private session.

`--reasoning` sets a pi thinking level: `minimal`, `low`, `medium`, `high`, or `xhigh` and `max` on models that offer them. Omitting it sends no reasoning setting, so the provider default applies (Anthropic models then run without extended thinking). A model the catalog lacks, or a level it does not offer, fails before model dispatch. Transient provider errors are retried up to four times with backoff, and Gemini malformed function calls and Anthropic refusals are resampled; timed stages never retry. A reply that ends without an accepted submission gets two reminders to call its submission tool; five rejected submissions in one attempt, or a third reply without one, fail the stage.

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

Add `--progress` to any run command to print one JSON line per agent update on stderr: the private session and task, the model, its current activity (`starting`, `generating`, `reasoning`, `tool` with the tool name, `retry`, `compacting`, `ended`), and the session's cost and token usage once known. Updates omit prompt, reasoning, and tool-input text. Programmatic runs receive the same updates through `onAgentProgress`. The optional Showdown clock disables retries during decisions; untimed stages keep the retry policy above.

For a live spectator screen, run `pnpm dev` from the repository root, open `/live`, and choose **Watch live**. The screen shows active agent tasks, reasoning/tool/retry/compaction activity, conversation usage, and an animated Showdown battle. Switch between concurrent series, or uncheck **Follow live** to pause and rewind. Public battle updates arrive over SSE; reconnecting restores the current state. Live snapshots are written automatically, including without `--progress`.

The **Season pages** link opens the same run's draft, standings, and completed replays. These refresh on league transitions. `vgcleague monitor` remains the completed-evidence audit for decision integrity and mechanics.

## Resume a tournament

```sh
pnpm run vgcleague tournament --resume run_directory
```

A seeded event pool preserves bracket positions while shuffling models across teams. `--provenance disclosed` names the event without exposing finishing order to competitive prompts; `blind` removes event context. Competitive prompts omit player names.

Resume validates entrants, teams, seed, provenance, reasoning, timer, draw, and completed evidence. Untimed games replay accepted native submissions from the seed without inference, validating the original inputs, then continue the unfinished conversation. Timed games restart the unresolved game with a new conversation because the elapsed clock and timer substitutions are not checkpointed. Resolved games and their completed reviews are retained. Stop the previous owner before resuming, and never resume one run concurrently.

Each private conversation is `<run-dir>/agents/<session>.jsonl`: a header with the session's model, reasoning, and routing, then every task, message, and compaction in order. Recovery reads only this transcript; a torn final line from a crash is discarded on reopen.

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

The monitor reads `league.sqlite` and the decision, trace, and game files of every completed series. It reports per-seat decision integrity (substitution and parse-failure rates, tool queries, latency, tokens), a mechanics audit that replays every `estimate_damage` and `compare_action_order` result against what the simulator then did (wrong KO calls, damage outside the predicted range, inverted action order, with forme changes in the same turn marked; a prediction is paired through the species the result names, so slot labels such as `foe 1` count, and what-if results (another weather, a Mega, a stat stage, a switch-in, the other turn order) are counted but never paired), the share of draft reasons that name another coach or the season ahead, per-entry roster usage by week and opponent, entries never registered while owned, and how many board Pokémon each memory barrier names, carries, or drops. Findings are evidence to inspect, not verdicts.

## Drive one battle from outside

`vgcleague bridge` plays one battle for an external driver over JSON lines on stdin and stdout, one game per process. The driver sees exactly what a league coach sees: the same rendered state and menus, the same reference tools, the same submission rules, and the mechanics audit afterwards. The [league-evals](https://github.com/jrhuc/league-evals) Inspect tasks are the first driver.

```sh
printf '%s\n' \
  '{"id":1,"method":"open","params":{"format":"gen9championsvgc2026regmcbo3","sheets":"open"}}' \
  '{"id":2,"method":"pool","params":{"name":"test"}}' \
  | pnpm run vgcleague bridge
```

Each request is `{"id","method","params"}`; each reply is `{"id","result"}` or `{"id","error"}`, answered strictly in order. `open` returns the harness and Showdown commits. `tools` returns the decision tool catalog (minus the series history tool), `system` the battle system prompt, and `pool` a team pool as packed strings. `start` takes the format, a seed, both players (`{name, team}`), the external seats (`["p1"]` or both), and the fixed policy for a seat that is not external (`opponent`: `random`, or `greedy`, which plays the largest damage the harness's own calculator projects). It returns the first decision event: `{kind:"decision", pid, decision, turn, phase, prompt, slot_names, menus, error, request}`, where `prompt` is the coach's full observation and `error` carries a simulator rejection of the previous choice. `call` runs a catalog tool for a seat (`{pid, name, arguments}`); `submit` takes menu indices (`{pid, choices}`) or `"default"`, validates them as the league would, and returns `{choice, next}` with the next event, which is either another decision or `{kind:"end", outcome}`. After the end, `outcome` returns the winner, turn count, canonical log and its sha256, error counts, and every external submission with its source and simulator verdict; `audit` returns the mechanics audit for the game. Turns with a single legal option never reach the driver, exactly as they never reach a model.

`start` also accepts `script`: the recorded Showdown choices for each seat (`{p1: [...], p2: [...]}`), automatic ones included. Each seat replays its choices and then hands over, so with the same seed and teams an external seat's first decision is the recorded game's decision at that point, and its observation carries the whole game so far. A rejected recorded choice ends the game with an error.

## Value recorded decisions

`vgcleague positions` reads one recorded game per JSON line on stdin: `{id, source: {format, seed, names, packed, choices}, log, settings?, only?}`. It replays the game, reports `{kind:"game", verified}`, and values nothing unless the replay reproduces the recorded log. For every simultaneous turn decision (or only the `{pid, choice_index, commands?}` entries in `only`, where `commands` restricts the actions valued; an action's value does not depend on which others are valued) it writes `{kind:"position", focal, turn, recorded, greedy, hidden_opponents, actions}`, where each accepted joint action has its win rate over `samples` reseeded rollouts against the opponent's damage-greedy reply and its recorded reply. Both sides continue with the damage-greedy policy (`value`), or with a random action `epsilon` of the time (`explored`). The simulator sees both full teams; `hidden_opponents` counts the opposing Pokémon the focal seat had not yet seen. Forced switches and team preview are not valued.

## Review a Showdown replay

`vgcleague replay` reads public Pokémon Showdown replays, by URL, by replay id, or from a saved replay JSON file, and prints each game as one of its players saw it. Fetched replays are kept in `replays/`, which is local state like `runs/`.

```sh
pnpm run vgcleague replay https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-2697755008 --as CoolMeDownB
pnpm run vgcleague replay REPLAY_ID --team replays/team.txt --calc '{"turn":2,"tool":"estimate_damage","args":{"attacker":"ally 1","defender":"foe 1","move":"Draco Meteor"}}'
```

The output holds both sheets at team preview and then, for every turn, the state at the decision as a league coach is shown it (with the Speed and type references) followed by the Showdown lines of what happened. Chat and room lines are dropped. Several replays print in best-of-three game order. The player is named with `--as` (a Showdown name, `p1`, or `p2`), or found by matching the six Pokémon of the `--team` export, or taken from a `?p2` replay link.

A public replay carries both open team sheets with natures but no stat points, and HP as percentages for both sides. Without `--team` every stat on both sides is therefore a range under the sheet's nature. `--team` takes the reviewed player's own export: their stats, Mega Evolution included, and maximum HP become exact, and their current HP is the percentage applied to it. The opponent's stats stay ranges.

Each printed game also says whether the simulator could rebuild it. The rebuild replays the game inside the pinned Showdown from the public log alone: each side's choices are read off the log (a Pokémon that never acted gets any move that keeps the log true), every random outcome is steered until the simulator writes the same lines, and HP is pulled to the recorded percentages. Stat points no team file supplies start from the nature (full investment where it points) and a Pokémon's Speed is moved the least distance that reproduces the order the log shows; each such move is reported as a bound ("needs at least 21"). A sleep or confusion whose length only shows turns later is redrawn where it began. Where the simulator cannot follow the log, the header names the turn and the two lines that differ. On 240 public Reg M-C Bo3 ladder replays from October 2026, 226 rebuild line for line and 96% of turns are followed; Illusion is not supported.

`--fork` asks what-ifs of the rebuilt game, one `{turn, do, you?, they?, samples?}` request or a list: `options` lists every legal choice of both sides at the start of the turn as Showdown commands with labels, and what was played; `play` plays your command (`you`) against theirs (`they`), both defaulting to what was played, over `samples` reseeded rolls (200 by default), reporting knockout rates, HP ranges, and the turn with every roll at its usual value; `table` plays every choice of yours against every reply of theirs once with usual rolls, ranking yours by the worst reply on the turn's material swing (HP fractions plus one per knockout), then lists the replies that hurt the played line most and your best choices against what they played. Attacks aimed at an ally and switches to a Pokémon the log never showed are left out. A recorded pivot switch is reused when a forked turn needs one.

`--calc` runs the decision tools against one replay instead of printing it: one `{turn, tool, args}` object or a list of them, where `turn` is the state at the start of that turn and `0` is team preview, and `-` reads the JSON from stdin. `estimate_damage` and `compare_action_order` read the live state exactly as they do for a league coach; every other name is a reference lookup. The `review-replay` Claude Code skill at the repository root drives both modes to review a finished game.

## Ask the calculators without a game

`vgcleague dex` runs the same lookup and calculator tools against the pinned format with no replay or league run: one `{tool, args}` object or a list of them, `-` reading the JSON from stdin, and `--format` naming any format the pinned Showdown knows (the Reg M-C best-of-three format by default).

```sh
pnpm run vgcleague dex '{"tool":"find_species","args":{"moves":["Sunny Day","Thunderbolt"]}}'
pnpm run vgcleague dex '{"tool":"bulk_to_survive","args":{"attacker":"Cinderace","attacker_ability":"Libero","move":"Smack Down","defender":"Charizard"}}'
```

Two tools exist only here. `find_species` lists the format-legal species that learn every move in `moves`, carry every type in `types`, and can have every ability in `abilities`; Mega formes are left to `lookup_species`. `bulk_to_survive` takes `estimate_damage` arguments and, for a neutral nature and for the natures that raise the defending stat (or just `defender_nature`), reports the cheapest HP and defending-stat investment at which the defender survives the max roll from full HP, or the best it reaches when nothing does. The attacker is at its legal maximum unless `attacker_stats` pins it. The `teambuild` Claude Code skill at the repository root drives this command.

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
