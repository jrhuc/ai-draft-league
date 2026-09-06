# Understand the harness architecture

The harness separates season orchestration, model calls, battle simulation, persistence, and publication. Each boundary has one authority.

<figure class="doc-diagram">
  <img src="assets/system-architecture.svg" alt="System architecture: the CLI starts runDraftLeague, whose LeagueCoordinator runs manager stages and recorded series against one SQLite run database. Manager stages and battle pilots call model providers. MatchRunner uses Pokémon Showdown as outcome authority and exposes each pilot through PerspectiveState. buildLeague projects run evidence for local inspection or export." loading="lazy">
  <figcaption>The run directory connects execution, local inspection, and public export. Model providers and Pokémon Showdown remain external.</figcaption>
</figure>

See [Franchise manager state](manager-model.md) for the context supplied to model calls.

## Orchestrate and persist a run

`runDraftLeague` constructs one `LeagueCoordinator`, which owns phase order and carries one cancellation signal through the run. Its `FranchiseState` entries keep each coach's durable memory, roster and budget, opponent dossiers, and series notes together. Stage functions (draft, team build, series, weekly review, transaction window, reconciliation, playoffs, season review) each adopt what the database already holds before doing new work, so resuming a run is re-running the season from the draft: completed stages replay without provider calls and the first unfinished stage continues.

`league.sqlite` is the sole mutable-state authority. It records validated league transitions, every immutable roster version, draft choices and names, franchise memory checkpoints, team builds, transaction events and results, series identities and attempts, agent context, resolved games, independent per-side adaptations, and season reviews. `config.json` is the readable run specification: models and seating, seed, board and format, Showdown revision, concurrency, timer and sheet policy, schedule, transactions, and provider specifications. Only explicit promotion from draft-only mode changes the specification.

Prompts, responses, decisions, traces, and Showdown logs remain append-only files that are never re-read as state. Resume verifies each referenced canonical game log by digest. `records/results.jsonl` is a cross-run projection of completed series, appended once per series and regenerated from the database when missing.

Runs created before `league.sqlite` are neither resumable nor exportable until migrated; the harness does not read their files.

## Resolve battles

`MatchRunner` runs a best-of-three against the pinned simulator. Pokémon Showdown decides team legality, accepted actions, randomness, battle transitions, timers, and results. League code enforces draft ownership, budgets, roster size, and Mega Evolution locks.

For each game, `MatchRunner` commits Showdown's result, canonical log digest, and both prepared adaptation tasks before calling either coach. Each adaptation is independently durable. A restart completes only missing adaptations and never replays a resolved game. If the external result projection was interrupted, it is rebuilt from the completed database series. The next game starts only after both adaptations are complete.

`PerspectiveState` consumes only the requesting side's Showdown protocol stream. It is the authorized model projection, never outcome authority and never a second simulator.

All model stages use `DecisionSession`. It owns conversation history, cancellation, tool execution, and aggregate execution ceilings. Untimed play has no wall-clock deadline; the optional Showdown clock remains the only gameplay deadline.

`showdown.lock.json` names the full official commit. Setup verifies the installation before a run starts.

## Read and publish data

`league-store` reads the run specification and draft state for resume. `buildLeague` joins the run database, series evidence files, and series records for local inspection and export. The spectator app's development server can read run directories through `/watch`; public pages read only exported bundles.

`exportSeasonBundle` is the only publication path. It requires an explicit release boundary, validates the projection, and writes `season-bundle.json`. Every planned series in a released week must be complete and have verified replay evidence. Each boundary step past the regular season adds one playoff round; a boundary containing the final also releases season reviews and opens closed sheets.

The bundle includes released rosters, builds, standings, games, decisions, transactions, reviews available at that boundary, and the bracket. Prompts, model responses, reasoning, and tool results from released games are published separately as decision traces. These can include model memory and team details. Gameplay visibility is enforced in the inputs supplied to each model; spectator trace publication does not change those inputs. Credentials and future results are excluded.

## Enforce trust boundaries

- Setup verifies the Showdown pin before execution
- Provider keys remain in process memory and never enter run files or public bundles
- Run and series identifiers are validated before filesystem access
- User cancellation aborts the run; provider adapters own infrastructure retries, timeouts, and error classification
- The optional Showdown timer owns gameplay deadlines

## Open work

- Whole-release transactional publication: exports replace files atomically, but a release is not yet one transaction
- Provider-round timing and retry relationships in decision-session evidence; flattened batch query results do not retain batch membership
- A verified frame bridge between the replay animation and the decision list
- Notebook diffs on team timelines, which need notebook text snapshots in the public artifact
