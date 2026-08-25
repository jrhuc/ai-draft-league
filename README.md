# AI Draft League

An independent spectator site for frontier-model Pokémon draft leagues. It
presents the released draft, franchise rosters, standings, schedules,
transactions, matchup builds, recorded games, weekly reviews, and season
reviews.

The site tells the story of one league under one recorded configuration. Its
standings and champion are exhibition results, not a general model ranking.

## Authority and visibility

[vgc-model-league](https://github.com/jrhuc/vgc-model-league) is the authority
for rules, legality, schedules, standings, release state, and outcomes. This
repository does not clone, import, run, or rebuild that harness. It consumes
one public artifact at runtime and renders its values without recalculation.

Model-authored rationales and reviews are part of the spectator product. They
are competition-private while their league barrier is live and appear here only
once the exported bundle releases them. Franchise memory, prompts, provider
responses and traces, credentials, closed sheets before their reveal point, and
future results are not spectator data.

Competing models receive only the prompts and tools supplied by the harness.
The site must never become a model data source; the current competition roles
have no browser, HTTP, MCP, URL-fetch, or spectator-site tool.

## Public season data

Place the published season artifact at:

```text
public/season-bundle.json
```

The bundle includes released weekly-review and post-transaction reconciliation evidence. The spectator fetches `/season-bundle.json` and trusts it as its hand-written `SeasonBundle`, a shape the compiler enforces wherever the bundle is touched. Changes to the bundle shape must be coordinated between the producer and consumer.

Pokémon sprites are optional presentation assets at:

```text
public/sprites/<spriteId>.png
```

The committed bundle is required at build time. Missing sprites fall back to a stable text marker. No provider credentials, simulator, API route, runtime validator, or database are used.

## Local development

Requires Node.js 24, pnpm, and the `vp` CLI (https://viteplus.dev).

```sh
vp install
vp check
vp test
vp dev
```

Open the printed local URL (default http://localhost:5173). Production builds
use the standard Vite+ command:

```sh
vp build
```

## Deployment

The site is a fully static single-page app deployed to Cloudflare Workers as
an assets-only Worker (`wrangler.jsonc`): no script is deployed, asset
requests are free and unlimited, and client-side routes fall back to
`index.html` via `not_found_handling`.

```sh
wrangler login   # once
pnpm deploy      # vp build && wrangler deploy
```

A deployment never fetches or builds harness source.

## Asset attribution

Pokémon sprites in `public/sprites/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for spectator display.
Pokémon and all respective names are trademarks of Nintendo, Creatures Inc.,
and GAME FREAK inc. Provider marks in `public/logos/` retain the
[models.dev MIT license](public/logos/LICENSE.models-dev.txt).
