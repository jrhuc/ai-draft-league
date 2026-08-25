import fs from "node:fs";
import path from "node:path";

import { z } from "zod";
import type { JsonObject } from "../src/types.js";

export const jsonObjectSchema = z.record(z.string(), z.json());

export interface PoolOutput {
  id: string;
  format: string;
  event?: JsonObject | null;
  spreads?: JsonObject;
  teams: JsonObject[];
  files: Record<string, string>;
  extra?: Record<string, string>;
}

interface PoolManifest {
  id: string;
  format: string;
  event?: JsonObject;
  spreads?: JsonObject;
  teams?: JsonObject[];
}

export function publishPool(poolDir: string, output: PoolOutput): string {
  const manifest: PoolManifest = {
    id: output.id,
    format: output.format,
  };
  if (output.event) manifest.event = output.event;
  if (output.spreads) manifest.spreads = output.spreads;
  manifest.teams = output.teams;
  const contents = {
    ...output.files,
    ...output.extra,
    "pool.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
  const names = Object.keys(contents);
  const blocked = names.map((name) => path.join(poolDir, name)).find((file) => fs.existsSync(file));
  if (blocked) throw new Error(`refusing to overwrite existing output: ${blocked}`);

  fs.mkdirSync(poolDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(poolDir), `.${path.basename(poolDir)}.`));
  try {
    for (const [name, body] of Object.entries(contents))
      fs.writeFileSync(path.join(staging, name), body, "utf8");
    const conflict = names
      .map((name) => path.join(poolDir, name))
      .find((file) => fs.existsSync(file));
    if (conflict) throw new Error(`refusing to overwrite existing output: ${conflict}`);
    const published: string[] = [];
    try {
      for (const name of names) {
        const target = path.join(poolDir, name);
        fs.linkSync(path.join(staging, name), target);
        published.push(target);
      }
    } catch (error) {
      for (const target of published.reverse()) fs.rmSync(target, { force: true });
      throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return path.join(poolDir, "pool.json");
}
