// @vitest-environment happy-dom
import { createElement } from "react";
import { createHash } from "node:crypto";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { App } from "../src/App";
import { SeasonProvider } from "../src/lib/season-context";

// season-bundle.json is the producer's exported artifact; SeasonBundle declares its
// shape, and the season-data suite verifies that declaration holds.
import season from "../public/season-bundle.json";

const roots: Root[] = [];

function mount(path: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/season-bundle.json")
        ? new Response(JSON.stringify(season), { status: 200 })
        : url.endsWith("/api/watch/runs")
          ? new Response("[]", { status: 200 })
          : new Response(null, { status: 404 }),
    ),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(SeasonProvider, null, createElement(App)),
    ),
  );
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("home renders standings from the fetched bundle", async () => {
  mount("/");
  await until(() => document.querySelector("table") !== null);
  expect(document.body.textContent).toContain("Standings");
  expect(document.body.textContent).toContain("muse-spark-1.2");
  expect(document.body.textContent).not.toContain("muse-spark-1.2-contributor");
  expect(document.querySelector('[title*="contributor"]')).toBeNull();
});

test("a match page embeds the Showdown replay with the sheets folded beneath it", async () => {
  const seriesId = Object.keys(season.replays)[0]!;
  mount(`/matches/${seriesId}`);
  await until(() => document.querySelector(".ps-frame") !== null);
  const frame = document.querySelector<HTMLIFrameElement>(".ps-frame");
  expect(frame?.srcdoc).toContain("battle-log-data");
  expect(frame?.srcdoc).toMatch(/<script src="[^"]*replay-frame[^"]*">/);
  expect(document.querySelector("details.sheets")).not.toBeNull();
  expect(document.body.textContent).toContain("Game by game");
});

test("unknown team route renders the not-found view", async () => {
  mount("/teams/not-a-team");
  await until(() => document.body.textContent?.includes("Nothing here"));
});

test("team timeline links registered builds and preserves model-authored reviews", async () => {
  const team = season.franchises[0]!;
  mount(`/teams/${team.id}`);
  await until(() => document.querySelector(".team-timeline") !== null);
  expect(document.body.textContent).toContain("Adaptation timeline");
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    '.team-timeline a[href^="#build-"]',
  ))
    expect(document.getElementById(link.hash.slice(1))).not.toBeNull();
  const reviews = season.weeklyReviews.filter((entry) => entry.franchiseId === team.id);
  expect(document.querySelectorAll(".timeline-review")).toHaveLength(reviews.length);
  for (const review of reviews)
    expect(document.querySelector(".team-timeline")?.textContent).toContain(
      review.reasoning.trim() || "No stated reason recorded.",
    );
});

test("a decision's full trace page loads the game's trace file beside the stated reason", async () => {
  const replay = Object.values(season.replays)[0]!;
  const seriesId = replay.seriesId;
  const index = replay.games[0]!.decisions.findIndex((decision) => decision.reasoningChars);
  expect(index).toBeGreaterThanOrEqual(0);
  const decision = replay.games[0]!.decisions[index]!;
  const traces = {
    runId: season.season.id,
    seriesId,
    game: 1,
    franchises: replay.franchises,
    decisions: replay.games[0]!.decisions.map((entry) =>
      entry.reasoningChars === null
        ? null
        : {
            franchiseId: entry.franchiseId,
            turn: entry.turn,
            phase: entry.phase,
            selection: entry.selection,
            prompt: "THE_PROMPT",
            toolCalls: [
              { name: "lookup_move", arguments: { name: "Protect" }, result: "MOVE_RESULT" },
              { name: "lookup_item", arguments: { name: "Focus Sash" }, result: "ITEM_RESULT" },
            ],
            reasoning: "THE_FULL_TRACE",
            response: "{}",
            usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
            latencyMs: 1000,
            maxTokens: null,
            timer: null,
            fallback: false,
            error: null,
            failedAttempts: [],
          },
    ),
  };
  const manifest = {
    runId: season.season.id,
    generatedAt: season.generatedAt,
    archive: `${season.season.id}.jsonl.gz`,
    digests: {
      [seriesId]: { 1: createHash("sha256").update(JSON.stringify(traces)).digest("hex") },
    },
  };
  let gameAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/season-bundle.json")
        ? new Response(JSON.stringify(season), { status: 200 })
        : url.endsWith("/traces/manifest.json")
          ? new Response(JSON.stringify(manifest), { status: 200 })
          : url.includes("/traces/")
            ? ++gameAttempts === 1
              ? new Response(null, { status: 503 })
              : new Response(JSON.stringify(traces), { status: 200 })
            : new Response("[]", { status: 200 }),
    ),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/matches/${seriesId}/games/1/decisions/${index + 1}`] },
      createElement(SeasonProvider, null, createElement(App)),
    ),
  );
  await until(() => document.body.textContent?.includes("Retry trace") ?? false);
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === "Retry trace")!
    .click();
  await until(() => document.body.textContent?.includes("THE_FULL_TRACE") ?? false);
  expect(document.body.textContent).toContain("Stated reason");
  expect(document.body.textContent).toContain(decision.rationale.slice(0, 40));
  expect(document.querySelector<HTMLDetailsElement>("details.trace-fold")?.open).toBe(false);
  expect(document.querySelector('a[href$=".jsonl.gz"]')).not.toBeNull();
  expect(document.body.textContent).toContain("100 input tokens");
  expect(document.body.textContent).toContain("40 cached input");
  expect(document.body.textContent).toContain("Cost unknown");
  const nextIndex = replay.games[0]!.decisions.findIndex(
    (entry, position) =>
      position > index &&
      entry.franchiseId === decision.franchiseId &&
      entry.reasoningChars !== null,
  );
  expect(document.querySelector(".trace-nav a:last-child")?.getAttribute("href")).toBe(
    `/matches/${seriesId}/games/1/decisions/${nextIndex + 1}`,
  );
  const back = document.querySelector<HTMLAnchorElement>(".trace-actions a")!;
  expect(back.search).toContain(`turn=${decision.turn}`);
  expect(back.search).toContain(`seat=${decision.franchiseId}`);
  const filter = document.querySelector<HTMLSelectElement>(".trace-filters select")!;
  filter.value = "lookup_item";
  filter.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => !document.body.textContent?.includes("MOVE_RESULT"));
  expect(document.body.textContent).toContain("ITEM_RESULT");
});

test("trace links appear only once a manifest for the bundle's run is deployed", async () => {
  const replay = Object.values(season.replays)[0]!;
  mount(`/matches/${replay.seriesId}`);
  await until(() => document.querySelector(".dec") !== null);
  expect(document.querySelector("a.trace")).toBeNull();
  expect(document.querySelector(".downloads")).toBeNull();
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = "";

  const manifest = {
    runId: season.season.id,
    generatedAt: season.generatedAt,
    archive: `${season.season.id}.jsonl.gz`,
    digests: { [replay.seriesId]: { 1: "a".repeat(64) } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/traces/manifest.json")
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : url.endsWith("/season-bundle.json")
          ? new Response(JSON.stringify(season), { status: 200 })
          : new Response("[]", { status: 200 }),
    ),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/matches/${replay.seriesId}`] },
      createElement(SeasonProvider, null, createElement(App)),
    ),
  );
  await until(() => document.querySelector("a.trace") !== null);
  expect(document.querySelector(".downloads")?.textContent).toContain("Game 1");
  expect(document.querySelector(".downloads")?.textContent).not.toContain("Game 2");
});
