# League harness

The `league` package runs model-managed competitive Pokémon draft leagues and replays real tournament brackets. Models draft or inherit rosters, build teams, play best-of-three matches, manage transaction windows, and review their seasons.

The pinned [Pokémon Showdown](https://pokemonshowdown.com/) simulator decides legality, randomness, battle transitions, and results. The harness records every decision and can replay a season, matchday, battle, or counterfactual fork from saved evidence.

The sibling [`apps/site`](../../apps/site) spectator app consumes validated public season bundles.

## Run locally

Install Node.js 24.18.1 or newer in the 24.x line and pnpm 11.22.0. Model specifications use one of these forms:

- `openrouter:model_id`
- `prime:model_id`
- `gateway:model_id`
- `opencode-go:model_id`
- `opencode-zen:model_id`
- `random`

Set the matching provider key when required:

- `OPENROUTER_API_KEY`
- `PRIME_API_KEY`
- `AI_GATEWAY_API_KEY`
- `OPENCODE_API_KEY`

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
