// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { LiveRunSnapshot } from "league/protocol";
import { SiteRouter } from "../src/site-router";

class LiveEvents extends EventTarget {
  static instances: LiveEvents[] = [];
  onopen?: () => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(readonly url: string) {
    super();
    LiveEvents.instances.push(this);
  }
  snapshot(value: LiveRunSnapshot): void {
    this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(value) }));
  }
}

let root: Root;
afterEach(() => {
  root.unmount();
  document.body.innerHTML = "";
  LiveEvents.instances = [];
  vi.unstubAllGlobals();
});

test("watches an unfinished run without a season export and updates the player without reloading it", async () => {
  vi.stubGlobal("EventSource", LiveEvents);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(
    createElement(MemoryRouter, { initialEntries: ["/live/test-run"] }, createElement(SiteRouter)),
  );
  await vi.waitFor(() => expect(LiveEvents.instances).toHaveLength(1));
  const events = LiveEvents.instances[0]!;
  expect(events.url).toBe("/api/watch/runs/test-run/events");
  expect(fetcher).not.toHaveBeenCalled();
  const snapshot: LiveRunSnapshot = {
    runId: "test-run",
    generation: "attempt-1",
    state: "running",
    revision: 0,
    updatedAt: "2026-09-10T12:00:00Z",
    agents: [
      {
        session: "seat-a",
        task: "decision-1",
        model: "openai:gpt-5",
        activity: "reasoning",
      },
    ],
    games: [
      {
        seriesId: "series-a",
        game: 1,
        attempt: "one",
        players: { p1: "openai:gpt-5", p2: "anthropic:claude-opus-4" },
        score: { p1: 0, p2: 0 },
        raw: "|turn|1\n",
        turn: 1,
        winner: null,
        state: "playing",
      },
    ],
  };
  events.snapshot(snapshot);
  await vi.waitFor(() => expect(document.querySelector(".ps-frame")).not.toBeNull());
  expect(document.body.textContent).toContain("Reasoning");
  const frame = document.querySelector<HTMLIFrameElement>(".ps-frame")!;
  const doc = frame.srcdoc;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  window.dispatchEvent(
    new MessageEvent("message", { data: { type: "ps-ready" }, source: frame.contentWindow }),
  );
  expect(post).toHaveBeenCalledWith({ type: "ps-live", raw: "|turn|1\n", follow: true }, "*");
  document.querySelector<HTMLInputElement>(".live-follow input")!.click();
  await vi.waitFor(() =>
    expect(post).toHaveBeenLastCalledWith(
      { type: "ps-live", raw: "|turn|1\n", follow: false },
      "*",
    ),
  );
  snapshot.games[0]!.raw += "|turn|2\n";
  snapshot.games[0]!.turn = 2;
  snapshot.agents[0]!.activity = "tool";
  snapshot.agents[0]!.tool = "board_search";
  snapshot.agents[0]!.usage = { cost: 0.0123, inputTokens: 1500, outputTokens: 200 };
  events.snapshot(snapshot);
  await vi.waitFor(() => expect(document.body.textContent).toContain("Calling board_search"));
  expect(document.body.textContent).toContain("$0.0123");
  expect(document.querySelector(".ps-frame")).toBe(frame);
  expect(frame.srcdoc).toBe(doc);
  expect(post).toHaveBeenLastCalledWith(
    { type: "ps-live", raw: "|turn|1\n|turn|2\n", follow: false },
    "*",
  );
  events.onerror?.();
  await vi.waitFor(() => expect(document.body.textContent).toContain("reconnecting"));
  expect(document.querySelector(".ps-frame")).toBe(frame);
  snapshot.generation = "attempt-2";
  snapshot.agents = [];
  snapshot.games[0]!.raw = "|turn|1\n";
  snapshot.games[0]!.turn = 1;
  events.snapshot(snapshot);
  await vi.waitFor(() => expect(document.querySelector(".ps-frame")).not.toBe(frame));
  root.unmount();
  expect(events.close).toHaveBeenCalledOnce();
});
