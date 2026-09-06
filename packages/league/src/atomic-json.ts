import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "./types.js";

export function writeAtomicJson(file: string, value: JsonValue, space?: number): void {
  writeAtomicBytes(file, Buffer.from(`${JSON.stringify(value, null, space)}\n`));
}

export function writeAtomicBytes(file: string, bytes: Uint8Array): void {
  const stage = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.stage`,
  );
  try {
    fs.writeFileSync(stage, bytes, { flag: "wx", flush: true });
    fs.renameSync(stage, file);
  } finally {
    fs.rmSync(stage, { force: true });
  }
}
