# AI Pokémon Worlds 2026

[pokeaiworlds.com](https://pokeaiworlds.com) — the eight models from the AI
draft league replay the real Pokémon Worlds 2026 top-8 bracket, each piloting
one of the actual top-cut teams. Every game is an embedded Pokémon Showdown
replay with the model's turn-by-turn reasoning beside it.

A fully static single-page app. It renders exactly one artifact,
[`public/tournament-bundle.json`](public/tournament-bundle.json), exported
from a finished tournament run by `vgcleague export-tournament` in
[`packages/league`](../../packages/league), and deploys to Cloudflare as
static assets from CI on push to main.

See the [repository README](../../README.md) for setup and commands;
`vp run worlds#dev` serves this app locally.
