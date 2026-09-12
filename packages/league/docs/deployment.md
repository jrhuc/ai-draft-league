# Publish a season bundle

Export one validated artifact for an explicit release boundary, commit it to the spectator app, then deploy the static site. The development-only `/api/watch` surface is never deployed.

From `packages/league`:

```sh
pnpm run build
pnpm run export:season \
  --run run_id \
  --through-week 1 \
  --title "AI Draft League" \
  --out ../../apps/site/public/season-bundle.json \
  --traces-dir ../../apps/traces/dist/traces
```

Without `--out`, the exporter writes `artifacts/public/seasons/{run_id}/season-bundle.json`; without `--traces-dir`, the per-game decision traces and the `{run_id}.jsonl.gz` archive land in a `traces/` directory beside the bundle.

`--through-week` is required. Every planned series in a released week must be complete and have verified replay evidence. Each value past the regular season adds one playoff round; the boundary containing the final also releases season reviews and opens closed sheets.

The exporter validates the projection before writing it. Run `vp fmt apps/site/public` and commit `apps/site/public/season-bundle.json` so the build contains the release. The trace files are never committed: they are megabytes per game, so they deploy from the exporting machine as the separate `traces` assets-only Worker, routed at `/traces/*` on the site's zone. The exporter also writes `manifest.json` there; the site fetches it at boot and shows trace links and downloads only for the games it lists for the bundle's run, so a site deploy without a matching traces deploy simply shows no trace links.

From the repository root, deploy the spectator app and then the traces:

The trace contract includes `runId` in every game file and `digests` in the manifest, indexed by series and positive game number. This map is also the released-game index. Each digest is the SHA-256 of `JSON.stringify` applied to the schema-parsed game payload. The viewer validates that fingerprint before displaying a trace and refuses mismatched releases. Regenerate older trace exports before publishing this viewer; old manifests are rejected rather than treated as current. Rebuild the league package after protocol changes because the apps import its built protocol.

Exports replace their output files individually, writing traces and the archive before the manifest and bundle. Other files in the destination are preserved, including earlier exports. Use a fresh trace destination for a clean deployment set. Publication across the bundle and trace files is not transactional.

```sh
pnpm --filter site deploy
pnpm --filter traces deploy
```

The site reads the committed artifact. It does not run Pokémon Showdown or recompute standings. See the [publication boundary](architecture.md#read-and-publish-data) for included and excluded evidence.
