import { z } from "zod";
import { insertOnce, readRunDatabase, transact } from "./run-database.js";
import type { JsonValue } from "./types.js";

const storedArtifactSchema = z.strictObject({
  artifact_key: z.string().min(1),
  artifact_json: z.string().min(1),
});

export interface StoredRunArtifact {
  key: string;
  value: JsonValue;
}

export function commitRunArtifact(
  runDir: string,
  namespace: string,
  key: string,
  value: JsonValue,
): void {
  transact(runDir, (database) =>
    insertOnce(
      database,
      "run_artifacts",
      {
        namespace,
        artifact_key: key,
        artifact_json: JSON.stringify(z.json().parse(value)),
        committed_at: new Date().toISOString(),
      },
      ["namespace", "artifact_key"],
      `${namespace} artifact ${key}`,
    ),
  );
}

export function readRunArtifacts(runDir: string, namespace: string): StoredRunArtifact[] {
  return readRunDatabase(
    runDir,
    (database) =>
      database
        .prepare(
          "SELECT artifact_key, artifact_json FROM run_artifacts WHERE namespace = ? ORDER BY artifact_key",
        )
        .all(namespace)
        .map((value) => {
          const row = storedArtifactSchema.parse(value);
          return { key: row.artifact_key, value: z.json().parse(JSON.parse(row.artifact_json)) };
        }),
    [],
  );
}
