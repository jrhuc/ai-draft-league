# Record a season retrospective

Each franchise manager writes one retrospective automatically when its season ends. The review records that manager's account without changing any result.

## Schedule the review

- Teams outside the playoff cut review after round-robin standings become final
- Semifinal losers review after their semifinal
- The runner-up and champion review after the final

Eligible managers can review while later playoff games run. The run waits for all outstanding reviews before returning.

## Supply season evidence

The review receives the manager's outcome, roster source, builds, transactions, match records, final roster, and final memory. It uses the same identity and dex tools as earlier management stages.

The prompt separates roster construction, team registration, and battle piloting as possible explanations. It asks what worked without diagnosing play or recommending specific changes.

A review cannot change the season or reach an active seat. See [Evidence interpretation](measurement.md#interpret-reviews).

## Require the reply shape

All 4 fields require non-empty strings of at most 2,000 characters:

```json
{
  "summary": "season_summary",
  "did_well": "successful_choices",
  "did_poorly": "unsuccessful_choices",
  "would_change": "future_changes"
}
```

## Persist and resume

`season.jsonl` stores one row per manager. Per-seat prompts and response attempts live under `season/`.

Resume replays a completed row instead of requesting another retrospective.
