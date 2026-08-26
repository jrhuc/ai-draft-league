# AI Draft League

A pnpm + `vp` monorepo for frontier-model Pokémon draft leagues:

- [`packages/league`](packages/league) — the harness. Models draft from a
  shared board, build teams, negotiate transaction windows, choose a bring and
  lead, play best-of-three matches, and review their season. The embedded,
  pinned Pokémon Showdown simulator is authoritative for rules, legality,
  randomness, state transitions, and results; every decision is recorded as a
  replayable event.
- [`apps/site`](apps/site) — the spectator site. A fully static single-page app
  that consumes exactly one artifact,
  [`apps/site/public/season-bundle.json`](apps/site/public/season-bundle.json),
  and renders it without recalculating competitive facts.

The site tells the story of one league under one recorded configuration. Its
standings and champion are exhibition results, not a general model ranking.

## Competition boundaries

Model-authored rationales and reviews are part of the spectator product. They
are competition-private while their league barrier is live and appear only once
the exported bundle releases them. Franchise memory, prompts, provider
responses and traces, credentials, closed sheets before their reveal point, and
future results never leave the harness.

Competing models receive only the prompts and tools supplied by the harness.
The site must never become a model data source: current competition roles have
no browser, HTTP, MCP, URL-fetch, or spectator-site tool.

## Local development

Requires Node.js 24, pnpm 11, and the `vp` CLI (https://viteplus.dev).

```sh
vp install
vp run league#build          # required once so cross-package types resolve
vp check                     # format, lint, typecheck across the workspace
vp test                      # site tests; league unit tests run from dist
vp run league#test:unit
vp dev                       # spectator app at http://localhost:5173 (/watch is dev-only)
```

`league` commands run through `pnpm run vgcleague --help` from
`packages/league`; see its [README](packages/league/README.md) and
[usage](packages/league/docs/usage.md).

## Publishing a season release

Build the harness, then export one explicit release boundary directly into the
site's committed artifact location:

```sh
cd packages/league
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League" \
  --out ../../apps/site/public/season-bundle.json
```

`--through-week` is mandatory; publication never advances because more private
results exist locally. The exporter validates the projection before writing it.
Sprites are optional presentation assets mirrored into
`apps/site/public/sprites/`. Missing sprites fall back to a stable text marker.

## Deployment

The site deploys to Cloudflare Workers as an assets-only Worker: no script is
deployed, asset requests are free and unlimited, and client-side routes fall
back to `index.html`.

```sh
wrangler login   # once
pnpm deploy      # from apps/site: vp build && wrangler deploy
```

Pushes to `main` auto-deploy through GitHub Actions once the repository has a
`CLOUDFLARE_API_TOKEN` secret (the "Edit Cloudflare Workers" token template);
deploys run only after the verify job passes. CI also fails if any trace of the
dev-only `/api/watch` surface reaches `apps/site/dist/`.

A deployment never fetches or builds harness source.

## License

The code uses the [MIT License](LICENSE). Pokémon and all
respective names are trademarks of Nintendo, Creatures Inc., and GAME FREAK
inc. Pokémon sprites in `apps/site/public/sprites/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for spectator display.
Provider marks in `apps/site/public/logos/` retain the
[models.dev MIT license](apps/site/public/logos/LICENSE.models-dev.txt).
