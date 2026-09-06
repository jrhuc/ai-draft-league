# Harness improvement plan

The production workflow plays sequential weeks so adaptation and roster changes reach the next matchup. Public traces remain public; gameplay visibility is enforced at the model-input boundary. Changes must not add recommended picks, sets, moves, or strategic comparisons authored by the harness.

## 1. Batch factual queries

Implemented: battle decisions, game reflections, drafts, team builds, trade windows, and manager reviews offer `batch_tools`. It accepts an ordered `queries` array of `{name, arguments}` using the existing tools' schemas. A round executes at most 32 queries across native calls and batches combined. The budget counts individual queries, including cache hits. Unavailable tools, nested batches, malformed batches, and excess queries return explicit errors. Cancellation stops execution; each query keeps its own trace and ordinary reference-memory behavior.

The common dispatcher replaces separate standard/action-order limits and stage-specific per-round caps. Tool definitions are built once per manager tool loop so provider-side schema caching can reuse them across rounds. No tool-round, output-token, or reasoning-effort limits change in this step.

Validation covers mixed calculations against ordinary reference results, a twelve-query native response completed in one tool exchange, shared budgets across multiple batches, rejected queries, per-query failures, cancellation, battle-state binding, reference memory, and reflection scope. Real-model latency and cost improvements remain to be measured.

### Simplification follow-up

Implemented a single bounded lookup-cache helper instead of three copies of cache bookkeeping. Object key order, including nested keys, does not change query identity; array order and argument values do. Cache hits return the original result without appending harness prose. Every requested query still consumes budget and produces evidence. Live calculations are cached only within a decision; static references can survive across decisions under the engine's fixed simulator authority. Thrown failures are not cached.

Battle notebooks now support partial updates: supplied strings replace their fields, omissions preserve existing text, and empty strings clear a field. Validation checks the complete resulting notebook before committing anything. Stored snapshots remain complete, so resume does not depend on replaying patches. Invalid supplied values are reported as rejected updates, not silently treated as absent. Reflections may still rewrite all three fields at game boundaries. Operator cancellation now propagates out of reflection rather than recording a fallback review.

Context-stream reads start at the requested cursor and stop after finding a page and its lookahead, avoiding repeated full-history filtering. Cursor, kind-filter, snapshot, and resume semantics are unchanged.

Updated `ai` to 7.0.93 and `@ai-sdk/openai-compatible` to 3.0.44 for failed-tool metadata preservation and reasoning-stream continuity. A mocked streaming-transport regression covers batch serialization, complete results, call IDs, reasoning, and the follow-up request without paid provider calls. Other direct dependencies and the simulator pin are unchanged.

### Remaining tool/context priorities

Implemented canonical tool-call replay: executed calls and replayed assistant messages use the same normalized IDs, duplicate replies are removed, malformed inputs are refused, and non-tool content and provider metadata survive normalization. Mocked compatible-provider streaming tests cover SDK-coalesced duplicate IDs and invalid JSON; synthetic replay tests cover reasoning signatures. Live adapter coverage remains unmeasured.

1. Put stable team/format facts ahead of changing turn state and memory, with explicit cache boundaries. Keep full tool results in evidence; measure repeated-result input growth before replacing repeated context with references. Do not silently clip results or add generated strategic summaries.
2. Extend decision-session evidence with provider-round timing and retry relationships. Native call IDs survive, but flattened query results do not yet retain batch membership.
3. Consider exposing paged earlier observations to the in-process pilot, not only the external seat API. Keep the existing POV boundary and scope reads to already observed events; measure retrieval overhead against the compact timeline before expanding default context.

## 2. Correct mechanics and preserve model-authored handoffs

Implemented simulator-backed hit outcomes instead of KO certainty inferred solely from raw damage. Complete-turn regression tests cover ordinary lethal damage, full/damaged Focus Sash, Sturdy, Disguise, and subsequent hits after survival effects. The calculator resolves the native hit loop at deterministic endpoints and reports conditional endpoint outcomes, not exhaustive KO certainty. Hits are assumed to connect; action-level effects and multi-target hit allocation are outside this contract. Broader interaction coverage remains useful.

Implemented a typed pilot briefing containing the model's team plan and every per-set note, independently of mutable strategic memory. Registered sets remain in the authoritative team input. Tests preserve distinctive notes exceeding the notebook limit across pilot memory edits. No harness-authored strategy is added. Existing recorded series using the old initial-notebook scaffold fail their identity check on adoption; they require an explicit migration or the old harness, not silent reinterpretation.

## 3. Repair persistence and export ownership

Draft choices, franchise names, completed team builds, transaction events and results, weekly memory, season reviews, and series context commit only to `league.sqlite`. The former JSON and JSONL copies of that state are no longer written; prompts, responses, traces, and Showdown logs remain the only files.

Deleted recursive removal of caller-selected trace directories. Exports atomically replace individual output files, then write the manifest and bundle after the traces and archive succeed. Tests cover shared destinations, unrelated files, and archive-write failure preserving the previous manifest and bundle. The digest map is the sole released-game index; JSON and byte writes share one atomic writer. Whole-release transactional publication remains open.

## 4. Make scheduling explicit and deterministic

Implemented one causal production schedule: every round-robin week completes and every franchise commits its review before the next week's builds start. Removed the blind cross-week mode and its CLI/configuration path. Series within one week remain concurrency-limited.

Implemented a validated league transition journal in `league.sqlite`. It rejects a newly skipped or reversed phase and refuses to cross a completed-week barrier until every franchise has a durable memory checkpoint. A state already on the journal is a no-op, so resume re-runs the season and re-emits its transitions.

Transaction exits are barriers too: a changed roster cannot become the next active roster version until that franchise's reconciliation memory is committed.

## 5. Consolidate decision execution and completion records

Implemented persistence consolidation in `league.sqlite`. `LeagueCoordinator` owns phase movement, immutable roster versions, and franchise checkpoints. The database also owns draft choices and names, team builds, transaction events and results, series identities and attempts, model context, resolved games, per-side adaptations, and season reviews. Raw prompts, responses, traces, and Showdown logs remain evidence. Resume has no separate preflight: every stage adopts committed state, and `results.jsonl` is a projection regenerated when missing.

Implemented `DecisionSession` as the common provider/tool loop used directly by battle choices and reflections and by every manager stage through the shared dex loop. Its untimed aggregate ceiling is deliberately liberal: 96 provider calls, 64 tool rounds, 1,024 queries, and 2,097,152 output tokens per decision. It has no latency deadline when the Showdown timer is off.

Provider-attempt timing and retry relationships remain an observability extension, not mutable season state. Existing per-seat evidence retains messages, usage, tool calls, and failures, while provider adapters own bounded infrastructure retries.

Implemented game-first commits. The canonical Showdown log, normalized result, and both immutable adaptation tasks commit atomically before reflection. Each coach memory then commits independently; resume runs only missing adaptations, and the next game waits for both.

## 6. Measure prompt reuse and request concurrency

Move stable team and format reference ahead of changing state, preserving the information available to models. Coordinate provider requests consistently across battles, team building, and reviews; series concurrency alone does not bound review requests.

Evaluate against matched positions and seeded runs with seat swaps. Report legal completion, substitutions, latency distributions, provider calls, input/output/cache tokens, known cost coverage, and game/series outcomes. Separate provider waiting from generation and tool execution. Do not claim that lower tokens alone improve play.

The September 4 review inspected 137 decision-trace rows from the sequential run `20260823T225120.275000Z-df572de5`: about 5.03 million input tokens, 1.49 million output tokens, 420 tool rounds, 81-second median latency, and 22-minute p95. Cost was present on 96 rows. This is historical trace evidence, not a controlled benchmark of the new implementation.

## Spectator UX implementation

UI work resumed September 5 at the user's request. Spoiler hiding is not planned. The Browser skill could not connect to any browser, so validation is through component tests and production builds, not a visual audit.

1. **Replay navigation: implemented for the decision list.** Game, turn, and team selection live in the URL in both spectator apps. Trace links return to the selected game and highlighted decision turn; history restores selection. Animation controls remain independent. A verified frame bridge for animation synchronization remains open.
2. **Adaptation timeline: implemented for released regular-season weeks.** Team pages join results, registered-team additions/removals, field-level set changes, model-authored weekly reviews, completed trades/swaps, and reconciliation. Links reach the original registered teams and transaction explanations. Reordering sets, moves, or EV keys does not invent changes; closed sets are unavailable rather than unchanged. Notebook text snapshots are not in the public artifact, so notebook diffs remain pending.
3. **Compact trace inspector: implemented.** Reasoning, tools, response, and prompt are separate disclosures. Same-team navigation, copyable links, tool-name/text filtering, input/output/cache tokens, and explicit unknown cost are available. Supplied memory remains within the recorded prompt. Structured tool-error filtering and provider-round grouping await corresponding evidence fields; results are not classified by guessing from prose.
4. **Recoverable, release-aware trace loading: implemented.** Trace payloads carry run identity; manifests carry per-game SHA-256 fingerprints. The bounded eight-game cache and fetch URL include content identity. The loader checks schema, run, series, game, and fingerprint; the page checks alignment with released decisions. Failed reads are retryable and late responses cannot replace a newer selection. Existing trace exports must be regenerated; old manifests are not reinterpreted.

Validation: 29 UI tests and 402 league tests pass, alongside repo-wide format, lint, and type checks. No live deployment or paid model calls were made.
