# Deploy documentation and season bundles

This repository publishes documentation and spectator data as separate outputs. The dev-only watch surface is never deployed.

## Publish the documentation

In **Settings → Pages**, set **Source** to **GitHub Actions**. `.github/workflows/pages.yml` runs when `docs/`, the package lock, or the workflow changes. It renders the Markdown files as zero-runtime HTML and deploys `dist/docs`.

Build the same output locally:

```sh
pnpm run build:docs
```

The Pages artifact contains the documentation theme, text, and diagrams. It excludes league archives, replays, sprites, model logos, provider controls, local watch routes and run data.

## Export a season bundle

Build the harness, then export one explicit release boundary:

```sh
pnpm run build
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League"
```

The default output is `artifacts/public/seasons/<run-id>/season-bundle.json`. Pass `--out <file>` to write directly into a checked-out spectator repository's `public/` directory.

`--through-week` is required. Publication never advances because more private results exist locally. A released week must contain every completed series and a verified replay for each series, or export fails. Values past the last regular-season week release playoff rounds one at a time. Releasing the final round also releases season reviews and opens closed team sheets.

The exporter validates the projection before writing it. The spectator statically imports the committed artifact. It does not clone the harness, run Showdown, or recompute standings and outcomes.

See the [publication boundary](architecture.md#publication-boundary) for the season bundle's public evidence and exclusions.
