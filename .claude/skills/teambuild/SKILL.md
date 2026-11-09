---
name: teambuild
description: Answer the user's VGC teambuilding questions with the league's calculators instead of from memory. Use when the user asks for a damage calc, how much bulk survives a hit, which Pokémon learn a move or combination of moves, which species have a type or ability, exact stats for a spread, or a type matchup, with no replay involved.
---

# Teambuilding questions

The user is an experienced VGC player building teams for Pokémon Champions Reg M-C, a format
with Mega Evolutions, Stat Points instead of EVs (32 per stat, 66 total), and no Terastallization.
Your value is running the numbers quickly and correctly. Every damage, survival, Speed, stat, and
learnset claim you make must come from a tool run; your recollection of Scarlet/Violet is not
evidence, and the pinned simulator's data differs from it.

## Run the tools

Run everything from `packages/league`. Build once per session if `dist/src/cli.js` is missing
or older than `src/`: `pnpm run build`.

```sh
node dist/src/cli.js dex - <<'JSON'
[
  {"tool": "find_species", "args": {"moves": ["Sunny Day", "Thunderbolt"]}},
  {"tool": "bulk_to_survive", "args": {"attacker": "Cinderace", "attacker_ability": "Libero",
   "move": "Smack Down", "defender": "Charizard"}}
]
JSON
```

Batch every call for a question into one run. `--format <id>` picks another format the pinned
Showdown knows; the default is the Reg M-C best-of-three format.

- `find_species`: `moves`, `types`, `abilities`, each a list; a species must satisfy every
  filter. Mega formes are not listed; ask `lookup_species` for a species' Mega outcomes.
- `bulk_to_survive`: the `estimate_damage` arguments. For a neutral nature and the natures that
  raise the defending stat, or only `defender_nature` when given, it reports the cheapest HP
  and defending-stat investment that survives the max roll from full HP. The attacker is at its
  legal maximum unless `attacker_stats` pins it, and it holds no item unless `attacker_item`
  says so.
- `estimate_damage`: `attacker`, `defender`, `move`; optional `attacker_item`, `defender_item`,
  `attacker_ability`, `defender_ability`, `attacker_stats`, `defender_stats`, `attacker_nature`,
  `defender_nature`, `attacker_boosts`, `defender_boosts`, `defender_screens`, `weather`,
  `terrain`, `helping_hand`, `is_spread_hit`, `is_critical_hit`, `attacker_ally`,
  `defender_ally`. Omitted stats are legal ranges, so results against unknown spreads are ranges.
- `calculate_stats`: `species`, `nature`, `evs` (Stat Points here). Use it to turn a spread into
  the exact stats that `estimate_damage` and `bulk_to_survive` take.
- Lookups by `name`: `lookup_species` (with optional `item` and `nature` for the Mega outcome
  and Speed range), `lookup_move`, `lookup_item`, `lookup_ability`, `lookup_learnset`;
  `lookup_matchup` takes `move` or `attacker_type` and `defender`.

Abilities that change the attacker's type, items, screens, weather, terrain, and spread damage
are applied only when named in the arguments, so name every factor the question implies, and
say which you assumed. A tool that reports a move or item as not legal in the format is right;
do not work around it.

## What to write

Lead with the answer: the list, the spread, or the number, with the conditions it holds under
(attacker investment, item, nature, max roll). Say in one line what was assumed and what would
change the answer, such as an item on the attacker or a different roll. Keep it short; the user
can ask for more.
