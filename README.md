# AI Draft League

A pnpm + `vp` monorepo for frontier-model Pokémon draft leagues:

- [`packages/league`](packages/league) -- harness. Models draft from a
  shared board, build teams, negotiate transaction windows, choose a bring and
  lead, play best-of-three matches, and review their season. The embedded,
  pinned [Pokémon Showdown](https://pokemonshowdown.com/) simulator is authoritative for rules, legality,
  randomness, state transitions, and results; every decision is recorded as a
  replayable event. Also supports tournaments.
- [`apps/site`](apps/site) -- draft spectator site. A single-page app
  that consumes [`apps/site/public/season-bundle.json`](apps/site/public/season-bundle.json),
  and renders it.
- [`apps/worlds`](apps/worlds) -- the Pokémon Worlds exhibition microsite. It
  renders one exported tournament bracket from
  [`apps/worlds/public/tournament-bundle.json`](apps/worlds/public/tournament-bundle.json).

## Local development

Requires Node.js 24, pnpm 11, and the `vp` CLI (https://viteplus.dev).

```sh
vp install
vp run league#build          # required once so cross-package types resolve
vp check                     # format, lint, typecheck across the workspace
vp test                      # site tests; league unit tests run from dist
vp run league#test:unit
vp dev                       # spectator app at http://localhost:5173 (/watch is dev-only)
vp run worlds#dev            # Worlds microsite on its own Vite dev server
```

`league` commands run through `pnpm run vgcleague --help` from
`packages/league`; see its [README](packages/league/README.md) and
[usage](packages/league/docs/usage.md).

## Publishing a season release

Build the harness, then export a release into the
site's committed artifact location:

```sh
cd packages/league
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League" \
  --out ../../apps/site/public/season-bundle.json
```

## Deployment

Both sites deploy to Cloudflare Workers as assets-only Workers: no script is
deployed, and client-side routes fall back to `index.html`.

```sh
wrangler login   # once
vp run league#build
pnpm deploy      # builds and deploys apps/site and apps/worlds
```

Deploy only Worlds with `vp run worlds#deploy` after building `league`.

## License

The code uses the [MIT License](LICENSE). Pokémon and all
respective names are trademarks of Nintendo, Creatures Inc., and GAME FREAK
inc. Pokémon sprites in `apps/site/public/sprites/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for spectator display.
Provider marks in `apps/site/public/logos/` retain the
[models.dev MIT license](apps/site/public/logos/LICENSE.models-dev.txt).
