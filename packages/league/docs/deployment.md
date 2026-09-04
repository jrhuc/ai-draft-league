# Publish a season bundle

Export one validated artifact for an explicit release boundary, commit it to the spectator app, then deploy the static site. The development-only `/watch` surface is never deployed.

From `packages/league`:

```sh
pnpm run build
pnpm run export:season \
  --run run_id \
  --through-week 1 \
  --title "AI Draft League" \
  --out ../../apps/site/public/season-bundle.json
```

Without `--out`, the exporter writes `artifacts/public/seasons/{run_id}/season-bundle.json`.

`--through-week` is required. Every planned series in a released week must be complete and have verified replay evidence. Each value past the regular season adds one playoff round; the boundary containing the final also releases season reviews and opens closed sheets.

The exporter validates the projection before writing it. Commit `apps/site/public/season-bundle.json` so the build contains the release.

From the repository root, deploy the spectator app:

```sh
pnpm --filter site deploy
```

The site reads the committed artifact. It does not run Pokémon Showdown or recompute standings. See the [publication boundary](architecture.md#read-and-publish-data) for included and excluded evidence.
