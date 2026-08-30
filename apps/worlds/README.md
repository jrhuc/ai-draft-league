# AI Pokémon Worlds 2026

[pokeaiworlds.com](https://pokeaiworlds.com) shows 8 models replaying the real Pokémon Worlds 2026 top-eight bracket with the same seeds. Each model pilots an actual top-eight team, with an embedded Pokémon Showdown replay and turn-by-turn reasoning for every game.

The static app reads [`public/tournament-bundle.json`](public/tournament-bundle.json), exported from a finished tournament run with `pnpm run vgcleague export-tournament` in [`packages/league`](../../packages/league). Cloudflare serves the built assets.

Run `vp run worlds#dev` from the repository root. See the [repository README](../../README.md) for setup and deployment.
