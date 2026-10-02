import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { z } from "zod";
import {
  readRunDatabase,
  RUN_DATABASE_FILE,
  transact,
  withRunDatabase,
} from "../src/run-database.js";

const HOLD_MS = 400;

const LOCK_HOLDER = `
  const { DatabaseSync } = require("node:sqlite");
  const [file, mode, holdMs] = process.argv.slice(1);
  const database = new DatabaseSync(file);
  database.exec("BEGIN " + mode);
  database
    .prepare("INSERT INTO run_artifacts (namespace, artifact_key, artifact_json, committed_at) VALUES ('held', ?, '{}', 'now')")
    .run(mode);
  process.stdout.write("locked");
  setTimeout(() => {
    database.exec("COMMIT");
    database.close();
  }, Number(holdMs));
`;

async function whileLocked<T>(
  runDir: string,
  mode: "IMMEDIATE" | "EXCLUSIVE",
  task: () => T,
): Promise<T> {
  const holder = spawn(
    process.execPath,
    ["-e", LOCK_HOLDER, path.join(runDir, RUN_DATABASE_FILE), mode, String(HOLD_MS)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(holder, "exit");
  try {
    await Promise.race([
      once(holder.stdout, "data"),
      exited.then(() => {
        throw new Error("the lock holder exited before taking its lock");
      }),
    ]);
    return task();
  } finally {
    await exited;
  }
}

function heldRows(database: DatabaseSync): number {
  return z
    .object({ count: z.number() })
    .parse(
      database
        .prepare("SELECT count(*) AS count FROM run_artifacts WHERE namespace = 'held'")
        .get(),
    ).count;
}

test("a connection waits out another process's lock instead of failing on it", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-run-database-"));
  t.onTestFinished(() => fs.rmSync(runDir, { recursive: true, force: true }));
  withRunDatabase(runDir, () => undefined);

  const written = await whileLocked(runDir, "IMMEDIATE", () => transact(runDir, heldRows));
  assert.equal(written, 1, "the writer began only after the other process committed");

  const read = await whileLocked(runDir, "EXCLUSIVE", () => readRunDatabase(runDir, heldRows, 0));
  assert.equal(read, 2, "the reader saw the other process's commit rather than a locked database");
});
