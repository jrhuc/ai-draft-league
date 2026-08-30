// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { App } from "../src/App";
import { TournamentProvider } from "../src/lib/context";
import bundle from "../public/tournament-bundle.json";

const roots: Root[] = [];

function mount(path: string): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(TournamentProvider, null, createElement(App)),
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

test("a failed bundle load can retry and show team selections", async () => {
  const fetchBundle = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response(JSON.stringify(bundle), { status: 200 }));
  vi.stubGlobal("fetch", fetchBundle);
  vi.stubGlobal("scrollTo", vi.fn());
  mount(`/matches/${bundle.bracket.rounds[0][0].match.seriesId}`);

  await until(() => document.body.textContent?.includes("Could not load the tournament") ?? false);
  document.querySelector<HTMLButtonElement>(".retry")?.click();
  await until(() => document.body.textContent?.includes("The 4 each model brought") ?? false);

  expect(fetchBundle).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Game by game");
  expect(document.querySelector(".ps-frame")).not.toBeNull();
  expect(document.querySelector<HTMLAnchorElement>(".repo-link")?.href).toBe(
    "https://github.com/jrhuc/ai-draft-league/tree/main/apps/worlds",
  );
  await until(() => document.title.includes("Quarterfinal"));
  expect(document.title).toContain("Quarterfinal");

  const frame = document.querySelector<HTMLIFrameElement>(".ps-frame");
  expect(frame?.srcdoc).toContain("battle-log-data");
  expect(frame?.srcdoc).toContain("ps-height");
  expect(frame?.contentWindow).not.toBeNull();
  const report = (source: Window | null, height: number) =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "ps-height", height }, source }),
    );
  report(null, 555);
  report(frame!.contentWindow, Number.NaN);
  expect(frame!.style.height).toBe("");
  report(frame!.contentWindow, 321.4);
  await until(() => frame!.style.height === "322px");
  report(frame!.contentWindow, 20);
  await until(() => frame!.style.height === "240px");
});
