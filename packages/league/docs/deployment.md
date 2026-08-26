# Publish a season bundle

The harness exports one artifact per release boundary. The dev-only watch
surface is never deployed.

Build the harness, then export one explicit release boundary:

```sh
pnpm run build
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League"
```

The default output is `artifacts/public/seasons/<run-id>/season-bundle.json`.
Pass `--out ../../apps/site/public/season-bundle.json` to write the spectator
site's committed artifact directly; commit it so builds and deployments carry
the release.

`--through-week` is required. Publication never advances because more private
results exist locally. A released week must contain every completed series and
a verified replay for each series, or export fails. Values past the last
regular-season week release playoff rounds one at a time. Releasing the final
round also releases season reviews and opens closed team sheets.

The exporter validates the projection before writing it. The site statically
imports the committed artifact. It does not run Showdown or recompute standings
and outcomes.

See the [publication boundary](architecture.md#publication-boundary) for the season bundle's public evidence and exclusions.
