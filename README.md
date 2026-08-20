# AI Draft League

An independent spectator app for frontier-model Pokémon draft leagues. It presents the published draft, franchise rosters, released standings, spoiler-safe match cards, and recorded event replays.

The league harness is the authority for rules, legality, schedules, standings, and outcomes. This repository does not clone, import, run, or rebuild that harness. It reads one public artifact at runtime and presents its values without recalculation.

## Public season data

Place a `season-bundle-v2` artifact and its matching schema at:

```text
public/season-bundle.json
public/season-bundle-v2.schema.json
```

The v2 bundle includes released weekly-review and post-transaction reconciliation evidence. The spectator validates the artifact against the schema before rendering it.

Pokémon sprites are optional presentation assets at:

```text
public/sprites/<spriteId>.png
```

Missing or invalid season data produces an in-app error state. Missing sprites fall back to a stable text marker. No provider credentials, simulator, API route, or database are used.

## Local development

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Production operation uses the standard Next.js commands:

```sh
pnpm build
pnpm start
```

## Vercel

Import this repository as a Vercel project and keep the detected Next.js framework defaults. The committed public season bundle and sprites are deployed with the app. A deployment never fetches or builds harness source.

## Asset attribution

Pokémon sprites in `public/sprites/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for spectator display.
Pokémon and all respective names are trademarks of Nintendo, Creatures Inc.,
and GAME FREAK inc. Provider marks in `public/logos/` retain the
[models.dev MIT license](public/logos/LICENSE.models-dev.txt).
