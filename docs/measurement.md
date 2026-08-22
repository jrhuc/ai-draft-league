# Evidence interpretation

The harness records what happened in a Pokémon series and what a model submitted. It does not establish why a model acted, whether its explanation was faithful, or how capable the model is in general.

## Authority

Pokémon Showdown determines legal teams, accepted actions, random outcomes, battle transitions, timers, and winners. League code determines draft ownership, budgets, roster rules, schedules, transactions, and release boundaries. Model text is never an authority for either layer.

Use the narrowest artifact that supports a claim:

- game logs and completion markers for battle events and results;
- decision rows for submitted choices, stated rationale, defaults, and substitutions;
- draft and teambuild artifacts for roster ownership, registered sets, and plans;
- canonical game summaries for brought Pokémon, Mega Evolution, and faints;
- transaction artifacts for offers, responses, and roster changes;
- review rows for the memory and reasoning recorded at a completed barrier;
- the season bundle for facts released to spectators.

Derived archive and spectator views are projections. They do not change the underlying result or legality.

## Claims

Describe observable behavior: a choice was submitted, a fallback was used, a Pokémon was drafted or brought, a move succeeded, or a series ended with a score. Attribute rationale as stated reasoning, not hidden intent.

Do not infer belief, honesty, deception, enjoyment, understanding, or exploitability from model-authored text. Do not turn one season's standings into a model ranking. Pokémon variance, draft order, rosters, opponents, schedules, provider conditions, and small samples remain part of every result.

When comparing runs, report the models and seating, seed, board and format, pinned Showdown revision, timer and sheet policy, schedule, and released evidence. Do not use provider retry counts or helper labels as outcomes.

## Visibility

A franchise sees only the prompts, tools, public game state, and private memory explicitly provided to its calls. Another franchise's memory, raw provider responses, traces, and unreleased reasoning remain private.

The exporter is the publication boundary. It releases only completed weeks and playoff rounds, keeps closed sets hidden until their reveal point, and excludes prompts, memory pages, provider responses, traces, credentials, and future results. The spectator displays that projection without recomputing authority facts.
