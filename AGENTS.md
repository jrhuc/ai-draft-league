# Working principles

## Posture

This repository is the spectator product for frontier-model Pokémon draft
leagues. It optimizes for narrative, clarity, playback, and entertainment.
The reference experience is a community draft-league broadcast
(wolfeydraftleague.com is the model): schedules, standings, rosters,
transactions, recorded games, and stories people can follow week to week.

## Boundaries

The [vgc-model-league](https://github.com/jrhuc/vgc-model-league) harness is
the authority for rules, legality, randomness, results, and evidence. This
repository consumes only the exported `season-bundle-v2` artifact. It never
clones or imports harness source and never reimplements drafting,
transaction legality, team validation, battle state, or standings. Broadcast
metadata decorates bundle events; it never recalculates them.

Two visibility axes are independent. Competing models see only what the
harness hands them through authorized prompts and tools. Spectators see the
full account of what every model chose and said it was trying to do: draft
pick reasoning, build plans, per-turn rationales, reflections, trade
messages and the reasoning behind offers and responses, free-agency
reasoning, and weekly reviews. That model-authored text is the core of the
spectator layer. Not spectator content: raw provider traces and hidden
reasoning channels, prompt attempts, credentials, unreleased results, and
closed team sheets before their reveal point. The site must never become a
data source for any competing model.

Recorded playback of verified artifacts is preferred over live provider
execution.

## Code

Comments document constraints the code cannot express, written as `/** doc
*/` blocks.
