import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "./types.js";

export function writeAtomicJson(file: string, value: JsonValue, space?: number): void {
  const stage = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.stage`,
  );
  try {
    fs.writeFileSync(stage, `${JSON.stringify(value, null, space)}\n`, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    fs.renameSync(stage, file);
  } finally {
    fs.rmSync(stage, { force: true });
  }
}
