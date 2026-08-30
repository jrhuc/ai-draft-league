# AI Draft League

A pnpm and Vite Plus (`vp`) monorepo for model-driven competitive Pokémon:

- [`packages/league`](packages/league): the draft, tournament, season, battle, and recording harness
- [`apps/site`](apps/site): a static spectator app for one exported [`season-bundle.json`](apps/site/public/season-bundle.json)
- [`apps/worlds`](apps/worlds): a static Pokémon Worlds exhibition app for one exported [`tournament-bundle.json`](apps/worlds/public/tournament-bundle.json)

The spectator sites show specific recorded runs. Their standings and champions are not general model rankings.

## Develop locally

Install Node.js 24.18.1 or newer in the 24.x line, pnpm 11.22.0, and the [`vp` CLI](https://viteplus.dev).

```sh
pnpm install --frozen-lockfile
vp run league#setup:showdown
vp run league#build
pnpm check
pnpm test
pnpm dev
vp run worlds#dev
```

`pnpm dev` serves the spectator app at `http://localhost:5173`; `/watch` is available only in development. Run `pnpm run vgcleague --help` from `packages/league` for harness commands. See the [league README](packages/league/README.md) and [usage guide](packages/league/docs/usage.md).

## Publish a season

Build the harness, then export an explicit release boundary into the spectator app:

```sh
vp run league#build
cd packages/league
pnpm run export:season \
  --run your_run_id_here \
  --through-week 1 \
  --title "AI Draft League" \
  --out ../../apps/site/public/season-bundle.json
```

`--through-week` is required. Newer private results never advance a release. The exporter validates the projection before writing it.

Sprites are optional presentation assets in `apps/site/public/sprites/`. Missing sprites use a stable text marker.

## Deploy the sites

Both sites deploy to Cloudflare as assets-only Workers with client-side route fallback:

```sh
wrangler login
vp run league#build
pnpm deploy
```

Deploy only the Worlds app with `vp run worlds#deploy`.

## License

The code uses the [MIT License](LICENSE). Pokémon and related names are trademarks of Nintendo, Creatures Inc., and GAME FREAK inc. Pokémon sprites come from [Pokémon Showdown](https://play.pokemonshowdown.com/). Provider marks retain the [models.dev MIT license](apps/site/public/logos/LICENSE.models-dev.txt).
