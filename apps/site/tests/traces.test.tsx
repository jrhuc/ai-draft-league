// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { loadGameTraces, useGameTraces, type GameTraces } from "../src/lib/traces";

function fixture(id: string, decisions: GameTraces["decisions"] = []) {
  const traces: GameTraces = {
    runId: id,
    seriesId: "series-1",
    game: 1,
    franchises: ["franchise-0", "franchise-1"],
    decisions,
  };
  const digest = createHash("sha256").update(JSON.stringify(traces)).digest("hex");
  const manifest = {
    runId: id,
    generatedAt: "2026-09-05T12:00:00.000Z",
    archive: `${id}.jsonl.gz`,
    digests: { "series-1": { 1: digest } },
  };
  return { traces, manifest };
}

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("trace reads coalesce and reuse only the matching release fingerprint", async () => {
  const first = fixture("cache");
  const next = fixture("cache", [null]);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(first.traces))
    .mockResolvedValueOnce(Response.json(next.traces));
  vi.stubGlobal("fetch", fetch);
  const a = loadGameTraces(first.manifest, "series-1", 1);
  expect(loadGameTraces(first.manifest, "series-1", 1)).toBe(a);
  expect((await a).status).toBe("ready");
  expect((await loadGameTraces(next.manifest, "series-1", 1)).traces?.decisions).toEqual([null]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![0]).not.toBe(fetch.mock.calls[1]![0]);
});

for (const status of [404, 503]) {
  test(`HTTP ${status} failures are distinguishable and retryable`, async () => {
    const { traces, manifest } = fixture(`http-${status}`);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(Response.json(traces));
    vi.stubGlobal("fetch", fetch);
    expect((await loadGameTraces(manifest, "series-1", 1)).status).toBe(
      status === 404 ? "missing" : "failed",
    );
    expect((await loadGameTraces(manifest, "series-1", 1)).status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
}

for (const mutation of [
  { runId: "wrong" },
  { seriesId: "wrong" },
  { game: 2 },
  { decisions: [null] },
  { unknown: true },
]) {
  test(`rejects mismatched trace content: ${JSON.stringify(mutation)}`, async () => {
    const { traces, manifest } = fixture(`mismatch-${Object.keys(mutation)[0]}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...traces, ...mutation })));
    expect(await loadGameTraces(manifest, "series-1", 1)).toEqual({
      traces: null,
      status: "mismatch",
    });
  });
}

test("unreleased games do not trigger a fetch", async () => {
  const { manifest } = fixture("unreleased");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await loadGameTraces(manifest, "series-1", 2)).status).toBe("unreleased");
  expect(fetch).not.toHaveBeenCalled();
});

test("late responses from another run cannot replace the current trace", async () => {
  const first = fixture("old-hook");
  const next = fixture("new-hook");
  let resolveFirst: (response: Response) => void = () => {
    throw new Error("fetch not started");
  };
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(next.traces));
  vi.stubGlobal("fetch", fetch);
  function View({ manifest }: { manifest: typeof first.manifest }) {
    const state = useGameTraces(manifest, "series-1", 1);
    return createElement("output", null, `${state.status}:${state.traces?.runId ?? ""}`);
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(createElement(View, { manifest: first.manifest }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  root.render(createElement(View, { manifest: next.manifest }));
  await vi.waitFor(() => expect(document.body.textContent).toBe("ready:new-hook"));
  resolveFirst(Response.json(first.traces));
  await loadGameTraces(first.manifest, "series-1", 1);
  expect(document.body.textContent).toBe("ready:new-hook");
});
