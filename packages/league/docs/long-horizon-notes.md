# Long-horizon notes

Working notes for changes deliberately deferred. Not part of the published docs build.

## Retry unification (stealth/alpha review #6) — LANDED 2026-08-25, validated live same day

Implemented in `SdkProvider.complete` (providers.ts): `maxRetries: 0` on the SDK call, and one
infra-retry loop wrapping `completeAttempt` — non-terminal, non-truncation failures (rate_limit,
upstream, network, timeout) retry with equal-jitter exponential backoff (base 2s, cap 300s), honor
an advertised Retry-After/"try again in" cooldown (cap 600s), budgets 20 attempts total and 6 for
timeouts (each timeout holds the seat up to 1800s). Timed battles pass `failFast: true`
(llm-engine decision loop) so the battle clock keeps fail-fast semantics. Schema/legality/truncation
handling stays with the callers' existing small budgets — the split the review asked for falls out
naturally because those never throw through `complete`. Terminal classes (quota, 401/403/404, 402,
empty response) still throw immediately. `makeProvider` accepts `retry` overrides; tests exercising
failure paths pass `retry: { attempts: 1 }`. Each retry logs an `[infra-retry]` line to stderr.

This obsoletes the external supervisor/auto-resume pattern (memory: ox-alpha-outage-playbook) once
a run launches on the rebuilt dist.

Live evidence (2026-08-25, run df572de5 weekly-review resume): kimi-k3 hit repeated OpenRouter
429s across its review's tool rounds — every one absorbed inline (37 `[infra-retry]` lines, zero
failures surfaced). OpenCode Go then served its lying "Inference is temporarily unavailable" 400
for ~55 minutes; classified upstream/non-terminal, the loop burned the full 20-attempt budget
(~53 min of backoff at the 300s cap) before surfacing cleanly — the outer supervisor's single
relaunch found the provider healed and finished in 3 min. Judgment call to revisit with more
evidence: for unattended season runs, `attempts: 20` (~50 min of patience at cap) may be worth
raising — each extra attempt costs at most 5 min and outages of 1-2h are precedented (ox-alpha
2026-08-24). Not changed yet; the default matched this incident acceptably.

## Concurrency default 2 → 4 (review #10) — LANDED 2026-08-25

Default bumped in cli.ts and the `?? 2` fallbacks in draftleague/rotation/tournament (semifinal
cap of 2 kept). Safe now that rate-limit-aware backoff exists. Resumed runs keep their stored
concurrency from config.json.

## Timed-play items (review #1 and #9) — revisit when timed runs return

- Streaming early-commit: scan the stream for a syntactically complete choices object and abort
  early when bank time is low, instead of paying for trailing rationale tokens. Gate on the
  BANK_LOW_SECONDS branch. Chunk timestamps also give true inter-token pacing per request.
- Persist the observed tokens/second EMA into run config so the next run's first timed turns start
  from measured pace instead of the 75 tok/s assumption.

## Prompt-cache extensions

Landed: Anthropic ephemeral breakpoints (system + first user message) and JSON prefill on the
forced-final decision round, both for `messages`-API claude models only, in `providers.ts`.
Deliberately excluded, revisit with evidence:

- qwen / Go-minimax Messages-shaped gateways: unknown whether they tolerate `cache_control`;
  a 400 is terminal in the season phase today. Probe before widening the gate.
- OpenRouter claude seats: cache_control needs content-part passthrough the openai-compatible
  provider does not send; needs its own plumbing if claude-via-OpenRouter joins a roster.
- Prefill is disabled whenever reasoning is on (Anthropic rejects prefill with extended thinking),
  so it only lights up for non-reasoning claude seats.

## Timeout right-sizing (review #7) — rejected, do not revisit without new evidence

Deriving per-call timeouts from observed pace re-introduces the failure that forced the 1800s cap:
reasoning models stall for minutes then burst (120s killed hy3 teambuilds; 900s killed a deepseek
reflection). A hung stream is better handled by infra-class retries than a tighter clock.
