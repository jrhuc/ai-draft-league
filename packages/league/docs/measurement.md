# Interpret league evidence

This page defines what each league artifact can support and how to report claims without assigning unsupported meaning to model text.

## Source authority

Pokémon Showdown determines legal teams, accepted actions, random outcomes, battle transitions, timers, and winners. League code determines draft ownership, budgets, roster rules, schedules, transactions, and release boundaries. Model text has no authority in either layer.

## What each artifact supports

Use the narrowest artifact that supports a claim:

- Game logs and completion markers support claims about battle events and results
- Decision rows support claims about submitted choices, stated rationale, defaults, and substitutions
- Draft and teambuild artifacts support claims about roster ownership, registered sets, and plans
- Canonical game summaries support claims about brought Pokémon, Mega Evolution, and faints
- Transaction artifacts support claims about offers, responses, and roster changes
- Review rows support claims about the memory and reasoning recorded at a completed barrier
- The season bundle supports claims about facts released to spectators

Derived archive and spectator views are projections. They do not change the underlying result or legality.

## How to state claims

Describe observable behavior. A choice was submitted, a fallback was used, a Pokémon was drafted or brought, a move succeeded, or a series ended with a score. Attribute rationale as stated reasoning rather than hidden intent.

Do not infer belief, honesty, deception, enjoyment, understanding, or exploitability from model-authored text. Do not turn one season's standings into a model ranking. Pokémon variance, draft order, rosters, opponents, schedules, provider conditions, and small samples remain part of every result.

When comparing runs, report the models and seating, seed, board and format, pinned Showdown revision, timer and sheet policy, schedule, and released evidence. Do not use provider retry counts or helper labels as outcomes.

## How to interpret reviews

Weekly and season reviews record what a franchise manager states at a completed barrier. You can compare a season review with earlier plans and mechanically observed `drafted-to-built-to-brought-to-used` links to assess statement consistency.

A review does not directly establish belief, causal attribution, self-awareness, or deliberate earlier behavior. A loss cannot identify a specific draft or piloting decision as its cause. A fluent retrospective is not a calibrated explanation.

Any semantic plan-fidelity or attribution score requires:

- A preregistered observable rubric
- Identity-stripped traces
- Several independent graders
- Reported grader disagreement
- Blinded human audit

A season review occurs after that franchise manager's last action in the season. It cannot demonstrate a notebook handoff, behavioral change, learning, or causal transfer. Prompt context and the expectation of a later review can still affect its text.

Evaluate a reflection intervention separately. Assign the intervention a version and bind its complete reflection-to-later-prompt-to-action chain.

## Visibility and publication

A franchise manager sees only the prompts, tools, public game state, and private memory supplied to that seat's calls. Another seat's memory, raw provider responses, traces, and unreleased reasoning remain private.

The exporter enforces the [publication boundary](architecture.md#publication-boundary). It releases only completed weeks and playoff rounds, keeps closed sets hidden until their reveal point, and excludes prompts, memory pages, provider responses, traces, credentials, and future results. The spectator displays that projection without recomputing authority facts.
