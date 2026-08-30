# Interpret league evidence

League artifacts support claims about recorded behavior, not private model beliefs. Use the narrowest artifact that proves each statement.

## Identify the authority

Pokémon Showdown decides legal teams, accepted actions, random outcomes, battle transitions, timers, and winners. League code decides draft ownership, budgets, roster rules, schedules, transactions, and release boundaries. Model text has no authority in either layer.

## Match claims to artifacts

- Game logs support battle events and results
- Completion markers bind canonical logs and results to a finished game
- Decision rows support submitted choices, stated rationale, defaults, and substitutions
- Draft and build artifacts support roster ownership, registered sets, and plans
- Canonical game summaries support brought Pokémon, Mega Evolution, and faints
- Transaction artifacts support offers, responses, and roster changes
- Review rows support memory and reasoning recorded at a completed barrier
- Season bundles support facts released to spectators

Derived archive and spectator views are projections. They do not change the recorded result or legality.

## Describe recorded behavior

State that a choice was submitted, a fallback occurred, a Pokémon was drafted or brought, a move succeeded, or a series ended with a score. Attribute rationale as stated reasoning, not hidden intent.

Do not infer belief, honesty, deception, enjoyment, understanding, or exploitability from model text. Do not turn one season's standings into a model ranking or treat provider retries and helper labels as outcomes.

When comparing runs, report models and seating, seed, board and format, Showdown revision, timer and sheet policy, schedule, and released evidence.

## Interpret reviews

Weekly and season reviews record what a manager states at a completed barrier. Compare them with recorded draft picks, builds, brought Pokémon, and battle use to assess consistency.

A review does not establish belief, causation, self-awareness, or deliberate earlier behavior. A fluent retrospective is not a calibrated explanation.

Semantic scoring requires:

- A preregistered rubric
- Traces with model identities removed
- Independent graders
- Reported grader disagreement
- Blinded human audit

Review text alone cannot prove a notebook handoff or behavioral change. Recorded prompts and responses can show that one stage received earlier notes. Testing whether that handoff changed behavior requires a versioned intervention and a complete prompt-to-action chain.

## Respect visibility

A manager sees only the prompts, tools, public game state, and private memory supplied to its calls. Other seats' memory, raw responses, traces, and unreleased reasoning remain private. The [publication boundary](architecture.md#read-and-publish-data) defines what spectators can receive.
