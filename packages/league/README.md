# League harness

The `league` package runs model-managed competitive Pokémon draft leagues and replays real tournament brackets. Models draft or inherit rosters, build teams, play best-of-three matches, manage transaction windows, and review their seasons.

The pinned [Pokémon Showdown](https://pokemonshowdown.com/) simulator decides legality, randomness, battle transitions, and results. The harness records every decision and can replay a season, matchday, battle, or counterfactual fork from saved evidence.

New drafts use [Champions Regulation M-C](docs/regulation-mc.md) and the `regmc-202609` board, including the six newly available Mega Evolutions and the expanded item roster.

The sibling [`apps/site`](../../apps/site) spectator app consumes validated public season bundles.

## Run locally

Install Node.js 24.21.0 or newer in the 24.x line and pnpm 12.3.4. Model execution uses the [Pi](https://github.com/earendil-works/pi) agent loop (`pi-agent-core`, `pi-ai`, `pi-codemode`). Specifications are `<provider>:<model-id>` from the pi-ai catalog, or `random`, for example:

- `opencode:model_id` (OpenCode Zen)
- `opencode-go:model_id` (OpenCode Go)
- `openrouter:model_id`
- `random`

Set `OPENCODE_API_KEY` for Zen and Go, and `OPENROUTER_API_KEY` for OpenRouter. Any other pi-ai provider works the same way with its own environment key.

pi-ai supplies the model catalog and provider protocols. The league owns the agent loop around it: native tools, Code Mode, retries, compaction, and recovery. League tools validate submissions against the current task and Pokémon Showdown. Each private conversation is a JSONL transcript under the run's `agents/` directory.

From `packages/league`:

```sh
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm run build
pnpm test
pnpm run vgcleague --help
```

See [Usage](docs/usage.md) for commands and the [repository README](../../README.md) for spectator development.

## Documentation

- [Season overview and rules](docs/index.md)
- [Usage](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Franchise manager state](docs/manager-model.md)
- [Evidence interpretation](docs/measurement.md)
- [Transactions](docs/trade-window.md)
- [Weekly review](docs/weekly-review.md)
- [Season review](docs/season-review.md)
- [Deployment](docs/deployment.md)

## License

The code uses the [MIT License](../../LICENSE). Pokémon and related names are trademarks of Nintendo, Creatures Inc., and GAME FREAK inc.
