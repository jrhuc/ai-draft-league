# Season review

Each franchise manager writes one retrospective when its season ends. The review records that manager's account of the season without changing any completed result.

## Review timing

The harness starts reviews as soon as each franchise finishes:

- Teams outside the playoff cut review after the round-robin standings are final
- Semifinal losers review after their semifinal
- The runner-up and champion review after the final

The harness does not wait until every game has finished. Eliminated round-robin seats can review while the semifinals run, and semifinal losers can review during the final. Seats in the same review batch respond concurrently.

The run waits for all outstanding reviews before returning. If a review fails, the run reports that failure after any concurrent games finish.

## Available evidence

The review can use the manager's season outcome, draft or roster preset, builds, transaction windows, match records, final roster, and final memory. It uses the same manager identity and dex-tool access as the draft and transaction prompts, with a separate prompt policy. Spectator-facing franchise names stay out of the prompt.

The prompt contains:

- How the franchise's season ended
- Final standings
- Its draft in pick order, including the original reasoning when a live draft occurred
- Its offers, responses, and free-agent decisions from every transaction window
- Each other seat's public transaction decisions
- Its final roster
- Each of its series in order
- Its final memory, with every page in full

The instruction asks the manager to separate drafting or roster construction, registration of six Pokémon, and battle piloting as possible causes of a series loss. It also asks what worked. The harness does not analyze the play or steer the manager toward specific picks.

A season review cannot change the season or reach another active seat. [Interpret league evidence](measurement.md#how-to-interpret-reviews) explains how to compare its statements with earlier plans and recorded actions. Access and release follow the [publication boundary](architecture.md#publication-boundary).

## Reply shape

The manager returns one JSON object:

```json
{
  "summary": "",
  "did_well": "",
  "did_poorly": "",
  "would_change": ""
}
```

## Persistence and resume

The run directory stores one row per manager in `season.jsonl`. Per-seat prompt and response-attempt traces live under `season/`.

On resume, the league replays an existing row instead of requesting another retrospective from a manager whose season has ended.
