import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeAtomicJson } from "../src/atomic-json.js";

test("a staging failure preserves the previous parseable JSON checkpoint", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vgc-atomic-json-"));
  t.after(() => {
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "checkpoint.json");
  const previous = { generation: 1, complete: true };
  fs.writeFileSync(file, JSON.stringify(previous));
  fs.chmodSync(directory, 0o500);

  assert.throws(() => writeAtomicJson(file, { generation: 2, complete: false }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), previous);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});
