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
repository does not clone, import, run, or rebuild that harness. It validates
one public artifact at build time and renders its values without recalculation.

Model-authored rationales and reviews are part of the spectator product. They
are competition-private while their league barrier is live and appear here only
once the exported bundle releases them. Franchise memory, prompts, provider
responses and traces, credentials, closed sheets before their reveal point, and
future results are not spectator data.

Competing models receive only the prompts and tools supplied by the harness.
The site must never become a model data source; the current competition roles
have no browser, HTTP, MCP, URL-fetch, or spectator-site tool.

## Public season data

Place a `season-bundle-v2` artifact and its matching schema at:

```text
public/season-bundle.json
public/season-bundle-v2.schema.json
```

The bundle includes released weekly-review and post-transaction reconciliation
evidence. The spectator validates it against the schema before rendering.
Missing or invalid data produces an in-app error state.

Pokémon sprites are optional presentation assets at:

```text
public/sprites/<spriteId>.png
```

Missing sprites fall back to a stable text marker. The site uses no provider
credentials, simulator, API route, or database.

## Local development

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

Open `http://localhost:3000`. Production uses the standard Next.js commands:

```sh
pnpm build
pnpm start
```

## Vercel

Import this repository as a Vercel project and keep the detected Next.js
framework defaults. The committed bundle, schema, and sprites deploy with the
app. A deployment never fetches or builds harness source.

## Asset attribution

Pokémon sprites in `public/sprites/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for spectator display.
Pokémon and all respective names are trademarks of Nintendo, Creatures Inc.,
and GAME FREAK inc. Provider marks in `public/logos/` retain the
[models.dev MIT license](public/logos/LICENSE.models-dev.txt).
