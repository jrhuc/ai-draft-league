---
name: review-replay
description: Review the user's own Pokémon Showdown VGC games after they are over, from replay links, as a coach with the league's calculators. Use when the user pastes replay.pokemonshowdown.com links or replay ids, or asks to review, critique, or go over a game or a best-of-three they played.
---

# Reviewing a Showdown replay

The user is an experienced VGC player preparing for tournaments. You are a second pair of eyes
with a calculator, not a stronger player: your value is checking the numbers they could not check
mid-game and noticing patterns across games. This is for finished games only. Never advise on a
game that is still being played.

## Get the game

Run everything from `packages/league`. Build once per session if `dist/src/cli.js` is missing or
older than `src/`: `pnpm run build`.

```sh
node dist/src/cli.js replay <url-or-id>... --team replays/team.txt
```

- Pass every game of a best-of-three together; they print in game order.
- `replays/team.txt` is the user's own team export with stat points. It is what makes their stats
  exact; without `--team` both sides are ranges. If the file is missing, ask for the export once,
  save it there, and carry on. `replays/` is local and never committed.
- The player is found from the team file. In a mirror match, or without a team file, add
  `--as <their Showdown name>`.

The output is each game as the user saw it: both sheets at team preview, then for every turn the
state at the decision followed by the Showdown log of what happened. `p1`/`p2` in the log are named
in the first lines. Opposing Pokémon show `HP ?` until they are revealed, so the state at a turn
holds only what the user knew then.

## Check before you claim

Every damage, KO, or Speed claim in your review must come from a calculator run, not from memory.
The format is Pokémon Champions Reg M-C, with Mega Evolutions and stat formulas you have not seen
before; the type lines under each state and the lookup tools are the authority, your recollection
of Scarlet/Violet is not.

```sh
node dist/src/cli.js replay <url-or-id> --team replays/team.txt --calc - <<'JSON'
[
  {"turn": 3, "tool": "estimate_damage",
   "args": {"attacker": "ally 1", "defender": "foe 2", "move": "Draco Meteor"}},
  {"turn": 3, "tool": "compare_action_order",
   "args": {"first": "ally 2", "second": "foe 1", "first_move": "Fake Out", "second_move": "Protect"}}
]
JSON
```

`turn` is the state at the start of that turn; `0` is team preview. Batch calls in one run.

- `estimate_damage`: `attacker`, `defender`, `move`; optional `attacker_mega`, `defender_mega`,
  `attacker_replaces`/`defender_replaces` (the active Pokémon a benched one would come in for),
  `weather`, `terrain`, `helping_hand`, `is_critical_hit`. Boosts, items, abilities, HP, screens,
  and field come from the state.
- `compare_action_order`: `first`, `second`; optional `first_move`, `second_move` (a move name or
  `"switch"`), `first_mega`, `second_mega`, `weather`.
- Lookups, all taking `name`: `lookup_species`, `lookup_move`, `lookup_item`, `lookup_ability`,
  `lookup_learnset`. Also `lookup_matchup` and `calculate_stats`.
- Name a Pokémon by slot (`ally 1`, `foe 2`) or species. When both sides have the species, prefix
  it: `ally Garchomp`, `foe Garchomp`.

The opponent's stat points are hidden, so results against them are ranges. When your conclusion
changes inside the range, say which end it needs. A hit that did land in the log tells you where
in the range they sit: compare the observed percentage with the estimate and say what it implies.

## Play it differently

The header of each game says whether the simulator rebuilt it line for line (or up to which
turn), the stat points it assumed for any side without a team file, and Speed facts it read off
the order things moved in. Those Speed facts are real evidence about their spread: "needs at
least 21" means their Pokémon moved before something that only 21 or more explains.

From a rebuilt turn you can fork the game:

```sh
node dist/src/cli.js replay <url-or-id> --team replays/team.txt --fork - <<'JSON'
[
  {"turn": 4, "do": "options"},
  {"turn": 4, "do": "play", "you": "move 4, move 1 +2", "samples": 200},
  {"turn": 4, "do": "table"}
]
JSON
```

- `options`: every legal choice for both sides as Showdown commands with readable labels, and
  what each side actually played. Copy commands from here; never guess the numbers.
- `play`: one choice of yours against one of theirs (`you` and `they` default to what was
  played) over many rolls of the dice: how often each Pokémon is knocked out, where HP lands,
  and the turn as it goes with ordinary rolls. Use it to answer "what if I had done X".
- `table`: every choice of yours against every reply of theirs, each played once with ordinary
  rolls, ranked by the worst reply; then the replies that hurt the played line most, and the
  best choices against what they actually did. It takes about ten seconds a turn, so run it on
  the turns that decided the game, not on every turn.

What the table measures is this turn's trade of HP and knockouts and nothing after it. A
Protect line looks safe in it because its cost arrives next turn; speed control, set-up, and
keeping a win condition alive score nothing. Treat it as evidence for a claim about risk ("was
there a line that lost less to their best answer?"), not as the verdict. Their stat points are
assumed, unseen bench Pokémon are not offered as switches, and a what-if only works on turns
before the point the simulator stopped following the log.

## How to judge

- **Decision, not outcome.** Judge a line by the state at that decision and by what the opponent
  could have clicked, not by what they did click. A good line that lost to a read is not a
  mistake; a bad line that worked is. Use later reveals only when labelled as hindsight.
- **The game before the turn.** Start from the plan: the bring and lead against their six, what
  each side needed to win, and what each trade did to that. Track the resources a turn-by-turn
  reading misses: Fake Out and Protect availability, the Mega, Intimidate cycles, speed control
  and field turns left, and which Pokémon each side must keep.
- **Safe lines first.** The user plays high-expected-value lines that do not lose to the
  opponent's best reply, and gambles only when forced. Measure a turn against that standard: what
  did the chosen line lose to, and was there a line that lost to less?
- **Few turns.** Most turns are fine. Pick the two to four that decided the game and leave the
  rest out.
- **Luck.** Name the rolls, crits, misses, and Speed ties that swung it, and whether the plan
  depended on them.
- **What the log cannot show.** A Pokémon that fainted or flinched before acting chose something
  you cannot see, and you do not know what the user was reading. Ask when it matters; do not
  invent an intent to criticise.

In a best-of-three, also review the adaptation: what each game revealed about their bring, items,
and Speed, and whether the next bring and lead used it.

## What to write

Lead with the verdict in two or three sentences: why the game was won or lost. Then the pivotal
turns, each with what was chosen, the alternative worth weighing, the numbers from the
calculators and the forks, and a plain call: fine, close, or mistake. End with at most three things to take into the next games. Keep a game
under about 400 words unless asked for more.

Then append a dated entry to `replays/log.md`: opponent archetype, both brings and leads, result,
and the one lesson. Read that log first on every review and say so when a pattern repeats across
games; a repeated pattern is worth more than any single turn.
