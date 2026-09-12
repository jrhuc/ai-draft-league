# Pokémon Champions Regulation M-C

Verified September 9, 2026 against the [official announcement](https://asia-press.portal-pokemon.com/press-release/pokemon-champions_20260830/), the [launch roster notice](https://www.pokemon.com/us/news/get-ready-for-regulation-set-m-c-in-pokemon-champions), and official Pokémon Showdown commit [`3ab832905b012da47c355009e141b1660fa36808`](https://github.com/smogon/pokemon-showdown/tree/3ab832905b012da47c355009e141b1660fa36808).

The regulation runs from **September 9, 2026 at 02:00 UTC through December 2, 2026 at 01:59 UTC**. The harness uses `gen9championsvgc2026regmcbo3`, backed by Showdown's `champions` mod.

## Battle rules

- Register six Pokémon and bring four to each doubles game, at level 50.
- Species Clause and Item Clause apply. Mythical and restricted legendary Pokémon are banned.
- Best of three with open team sheets by default. The harness supports an explicit closed-sheet option.
- Mega Evolution is available once per side per game, including Z Mega Evolution. Multiple stone holders can be registered and brought.
- No Terastallization, Dynamax, or Z-Moves. A Z Mega Stone enables Mega Evolution.
- Champions Stat Points use a total of 66, at most 32 per stat, with fixed maximum IVs.
- Base move PP is capped at 20; the simulator applies Champions' battle PP calculation.
- Showdown supplies the VGC timer. Harness battles remain untimed unless a timer scale is explicitly requested.

## Added Pokémon

The official notice counts 24 newly available Pokémon plus six Mega Evolutions. Showdown exposes **35 new legal entries** when alternate formes are included:

- Wigglytuff, Persian, Persian-Alola, Farfetch’d, Mr. Mime, Swalot, Salamence, Gogoat, Golisopod.
- Rillaboom, Cinderace, Inteleon, Thievul, Toxtricity and Toxtricity-Low-Key, Grapploct, Perrserker, Sirfetch’d, Pincurchin, Indeedee and Indeedee-F.
- Pawmot, Arboliva, Squawkabilly's four colours, Mabosstiff, Baxcalibur.
- Mega Absol Z, Mega Garchomp Z, Mega Lucario Z, Mega Salamence, Mega Golisopod, Mega Baxcalibur.

Mega Absol Z is Dark/Ghost with **Sharpness**. Mega Garchomp Z is pure Dragon with **Levitate**. Mega Lucario Z is Fighting/Steel with **Aura Guard**, which halves contact-move damage. Mega Salamence has Aerilate and Mega Golisopod has Tough Claws. The pinned simulator supplies all stats, abilities and learnsets, including Mega Baxcalibur's implementation.

The new `regmc-202609` draft board has **343 entries**, including **82 Mega entries**, with a 100-point budget and 10 picks per franchise. Prices combine the earlier board, historical M-B usage adjustments, draft-specific carryover corrections, and provisional estimates for M-C additions. The generator records pricing anchors; retained usage figures are historical M-B measurements, not M-C rankings.

## Added items

The pin has **166 legal held items**, adding 18:

- Absolite Z, Baxcalibrite, Garchompite Z, Golisopite, Lucarionite Z, Salamencite.
- Air Balloon, Binding Band, Eject Button, Electric Seed, Grassy Seed, Leek, Misty Seed, Normal Gem, Psychic Seed, Red Card, Rocky Helmet, Terrain Extender.

Assault Vest, Eviolite, Safety Goggles and Booster Energy remain unavailable. Team-building prompts derive free-choice items from the format dex; Mega Stones are locked to their drafted Mega entries. Both spectator apps use regenerated item-icon indexes and sprites.

## Maintaining the format

`showdown.lock.json` records the full official simulator commit. `setup:showdown` verifies and builds that checkout. `build-board` regenerates the M-C board, and `fetch-sprites` refreshes the shared spectator assets. Move, item and ability descriptions use Showdown's format-aware `dex.text` API.

Recorded M-B boards, event pools and public bundles retain their original rules and provenance. Their format resolves to Showdown's `championsregmb` mod. Create a new input ID for later board repricing or newly sourced team pools.
