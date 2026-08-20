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
repository consumes only the exported public `season-bundle-v1` artifact. It
never clones or imports harness source and never reimplements drafting,
transaction legality, team validation, battle state, or standings. Broadcast
metadata decorates public events; it never recalculates them.

Publish only public-season evidence: closed sheets stay closed until their
reveal policy says otherwise, and private reasoning is never the
entertainment layer. Recorded playback of verified artifacts is preferred
over live provider execution.

## Code

Comments document constraints the code cannot express, written as `/** doc
*/` blocks.
