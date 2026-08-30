// @vitest-environment happy-dom
import { createElement } from "react";
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
    vi.fn(async () => new Response(JSON.stringify(season), { status: 200 })),
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
  for (let i = 0; i < 50 && !predicate(); i++)
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

test("unknown team route renders the not-found view", async () => {
  mount("/teams/not-a-team");
  await until(() => document.body.textContent?.includes("Nothing here"));
});
