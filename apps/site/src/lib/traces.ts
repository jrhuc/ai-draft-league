import { useEffect, useState } from "react";
import {
  type PublicGameTraces,
  publicGameTracesSchema,
  type PublicTracesManifest,
  publicTracesManifestSchema,
} from "league/protocol";
import { liveRunId } from "./live";
import type { Season } from "./season";

export type GameTraces = PublicGameTraces;
export type DecisionTrace = NonNullable<GameTraces["decisions"][number]>;
type TraceStatus = "loading" | "ready" | "unreleased" | "missing" | "failed" | "mismatch";
type TraceState = { traces: GameTraces | null; status: TraceStatus };

function tracesRoot(): string {
  const live = import.meta.env.DEV ? liveRunId() : null;
  return live ? `/api/watch/runs/${live}/traces` : "/traces";
}

export function gameTracesUrl(seriesId: string, game: number, digest?: string): string {
  const root = tracesRoot();
  const path =
    root === "/traces"
      ? `${root}/${seriesId}/game-${game}.json`
      : `${root}/${seriesId}/game-${game}`;
  return digest ? `${path}?v=${digest}` : path;
}

export function traceArchiveUrl(manifest: PublicTracesManifest): string {
  return `/traces/${manifest.archive}`;
}

export function decisionTracePath(seriesId: string, game: number, index: number): string {
  return `/matches/${seriesId}/games/${game}/decisions/${index + 1}`;
}

export async function loadTraceManifest(): Promise<PublicTracesManifest | null> {
  const root = tracesRoot();
  const url = root === "/traces" ? `${root}/manifest.json` : `${root}/manifest`;
  try {
    const response = await fetch(url, { cache: "no-cache" });
    return response.ok ? publicTracesManifestSchema.parse(await response.json()) : null;
  } catch {
    return null;
  }
}

export function deployedTraces(season: Season): PublicTracesManifest | null {
  return season.traces?.runId === season.season.id ? season.traces : null;
}

export function gameHasTraces(season: Season, seriesId: string, game: number): boolean {
  const manifest = deployedTraces(season);
  return Boolean(manifest?.digests[seriesId]?.[game]);
}

const loaded = new Map<string, Promise<TraceState>>();

export function loadGameTraces(
  manifest: PublicTracesManifest,
  seriesId: string,
  game: number,
): Promise<TraceState> {
  const digest = manifest.digests[seriesId]?.[game];
  if (!digest) return Promise.resolve({ traces: null, status: "unreleased" });
  const url = gameTracesUrl(seriesId, game, digest);
  const key = `${manifest.runId}:${url}`;
  const cached = loaded.get(key);
  if (cached) return cached;
  const pending = (async (): Promise<TraceState> => {
    try {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok)
        return { traces: null, status: response.status === 404 ? "missing" : "failed" };
      const parsed = publicGameTracesSchema.safeParse(await response.json());
      if (!parsed.success) return { traces: null, status: "mismatch" };
      const traces = parsed.data;
      if (traces.runId !== manifest.runId || traces.seriesId !== seriesId || traces.game !== game)
        return { traces: null, status: "mismatch" };
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(traces)),
      );
      const actual = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return actual === digest ? { traces, status: "ready" } : { traces: null, status: "mismatch" };
    } catch {
      return { traces: null, status: "failed" };
    }
  })();
  loaded.set(key, pending);
  if (loaded.size > 8) loaded.delete(loaded.keys().next().value!);
  void pending.then((state) => {
    if (state.status !== "ready" && loaded.get(key) === pending) loaded.delete(key);
  });
  return pending;
}

export function useGameTraces(
  manifest: PublicTracesManifest | null,
  seriesId: string,
  game: number,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TraceState & { key: string }>({
    key: "",
    traces: null,
    status: "loading",
  });
  const key = `${manifest?.runId}:${manifest?.digests[seriesId]?.[game]}:${seriesId}:${game}:${attempt}`;
  useEffect(() => {
    let live = true;
    if (!manifest) return;
    void loadGameTraces(manifest, seriesId, game).then((result) => {
      if (live) setState({ ...result, key });
    });
    return () => {
      live = false;
    };
  }, [manifest, seriesId, game, key]);
  const current: TraceState = !manifest
    ? { traces: null, status: "unreleased" }
    : state.key === key
      ? state
      : { traces: null, status: "loading" };
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}
