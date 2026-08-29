# Working principles

## Layout

- `packages/league` — the harness: draft engine, battle sim integration,
  provider clients, and the `vgcleague` CLI. Runs execute here; `runs/`,
  `records/`, and `.env` are local state and are never committed.
- `apps/site` — the spectator app, deployed to Cloudflare as static assets.
- `apps/worlds` — the Worlds exhibition microsite, deployed as a separate
  static-assets Worker from one exported tournament bundle.
- Repo-wide format, lint (anti-slop, type-aware), and type checks run from the
  root: `pnpm check`. League tests run with Vitest straight from source via
  `vp run league#test:unit`; the `tsc` build to `dist` still backs the
  `vgcleague` CLI and the site's dev-only live watch.

## Boundaries

The deployed site consumes exactly one data artifact: the exported
`apps/site/public/season-bundle.json`. It never reads `runs/` and never
recalculates competitive facts (standings, legality, winners) — the league
export is the authority. A dev-only live-watch surface may read local run
directories through the dev server; it must never ship in the production
bundle.

Site browser code imports league code only through pure modules (types,
parsers, formatters). Provider SDKs and anything that touches credentials stay
server/CLI-side.

Competing models see only what the harness gives them through authorized
prompts and tools. Don't add browser, HTTP, or spectator-site tools to
competition roles without deliberate design.

A season is an exhibition under one recorded configuration, not a general
model ranking.

## Code

This is a mutable personal project: delete obsolete protocols, compatibility
paths, and defensive machinery instead of layering around them. Near-zero
comments — a comment documents a constraint the code cannot express, in
`/** doc */` form, and never narrates the implementation. Reject an invalid
bundle rather than guessing around it.
