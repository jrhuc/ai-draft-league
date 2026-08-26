import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tool = path.resolve("tools/archive-run.mjs");

function runTool(dataDir: string, archiveDir: string, runId: string) {
  return spawnSync(process.execPath, [tool, runId], {
    encoding: "utf8",
    env: {
      ...process.env,
      VGC_LEAGUE_DATA_DIR: dataDir,
      VGC_RUN_ARCHIVE_DIR: archiveDir,
    },
  });
}

test("archive-run uses the configured league data directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-archive-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const archiveDir = path.join(root, "archives");
  const runDir = path.join(dataDir, "runs", "safe-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify({ mode: "rotation" }));

  const result = runTool(dataDir, archiveDir, "safe-run");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(archiveDir, "safe-run.tar.gz")), true);
  assert.equal(fs.existsSync(path.join(archiveDir, "safe-run.manifest.json")), true);
});

test("archive-run rejects parent-directory run ids", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-archive-tool-unsafe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const archiveDir = path.join(root, "archives");
  fs.mkdirSync(path.join(dataDir, "runs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ mode: "draft" }));

  const result = runTool(dataDir, archiveDir, "..");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skip \.\.: not a run directory/u);
  assert.deepEqual(fs.readdirSync(archiveDir), []);
});
