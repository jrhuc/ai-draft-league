# Working principles

## Posture

This repository is the spectator product for frontier-model Pokémon draft
leagues. Optimize for narrative, clarity, playback, and entertainment: a
community league broadcast with schedules, standings, rosters, transactions,
recorded games, and stories that develop week to week.

A season is an exhibition under one recorded configuration. Present its
standings and champion accurately, but never turn them into a general model
ranking.

## Boundaries

[vgc-model-league](https://github.com/jrhuc/vgc-model-league) is the authority
for rules, legality, randomness, schedules, results, release state, and public
evidence. This repository consumes only `season-bundle-v2`. It never clones or
imports harness source and never reimplements draft rules, transaction legality,
team validation, battle state, standings, winners, or reveal timing.

Two visibility axes are independent:

- competing models see only what the harness gives them through authorized
  prompts and tools;
- spectators see the released account of what models chose and said they were
  trying to do: pick reasoning, build plans, decision rationales, reflections,
  transaction messages and reasoning, weekly reviews, reconciliation, and
  season reviews.

Model-authored reasoning is competition-private until its release barrier, then
spectator content. Raw provider traces and hidden reasoning channels, prompts,
credentials, memory pages, unreleased results, and closed sheets before their
reveal point are never spectator content.

The site must not become a data source for competing models. The current league
roles have no browser, HTTP, MCP, URL-fetch, spectator-site, or general network
tool. If that harness boundary changes, the release policy must be reviewed
before another season.

Recorded playback of validated artifacts is preferred over live provider
execution. The frontend may derive presentation labels and links, but it must
not recalculate competitive facts.

## Code

Comments document constraints the code cannot express and use `/** doc */`
blocks. Keep the public protocol typed and validated at build time. Reject an
invalid bundle rather than guessing around it.
