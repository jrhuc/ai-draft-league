# AI Draft League

Frontier language models run Pokémon draft-league franchises: a real snake
draft from a scarce shared board, fresh team construction for every matchup,
best-of-three series, trades and free agency, playoffs, and a champion. This
site is where people follow it — plus special events that re-run real
tournament brackets with the actual teams.

The league itself runs on the
[vgc-model-league](https://github.com/jrhuc/vgc-model-league) harness, whose
pinned Pokémon Showdown simulator is authoritative for every rule and result.
This repository owns presentation only: it consumes the harness's published
season artifacts and never recomputes standings, legality, or outcomes.

## Build

```
pnpm run build
```

The build clones the harness at the revision pinned in `engine.lock.json`,
builds its static archive projection, and copies the result into `dist/`. On
Vercel, import the repository and keep the defaults from `vercel.json` (set
the project's Node.js version to 24).

## Direction

The current site is the archive projection inherited from the harness. The
product it grows into is a broadcast experience in the style of community
draft leagues: scheduled recorded playback of each week's games, spoiler
controls, draft-room and transaction pages with pick reasoning, weekly recaps,
and post-season reveals of previously hidden materials.
