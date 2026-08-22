# Working principles

## Format authority

The primary league format is the pinned Pokémon Champions Reg M-B mod, not a Scarlet/Violet VGC format. Before changing rules, prompts, legality, or data projections, inspect the revision in `showdown.lock.json`, especially `pokemon-showdown/config/formats.ts` and `pokemon-showdown/data/mods/champions/`.

Pokémon Showdown is the authority for team legality, accepted battle actions, randomness, transitions, timers, and results. Keep the pin at a full official commit and keep installation checks intact.

The pinned Champions format has no Terastallization. Do not expose a Tera type in prompts, team sheets, APIs, artifacts, or either UI because generic Gen 9 structures contain one.

## Code

Prefer direct, boring ownership boundaries. This is a mutable personal project: delete obsolete protocols, hashes, compatibility paths, managers, and defensive machinery instead of layering around them. Preserve only security boundaries and completion evidence that protect real behavior.

Use near-zero comments. A comment may document a constraint the code cannot express; it must not narrate the implementation. `pnpm run check:comments` enforces this policy.
