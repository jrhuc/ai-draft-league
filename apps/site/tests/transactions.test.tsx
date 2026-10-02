// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { App } from "../src/App";
import { SeasonProvider } from "../src/lib/season-context";
import type { SeasonBundle } from "../src/lib/season";
import season from "../public/season-bundle.json";

let root: Root;
afterEach(() => {
  root.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

type Transactions = SeasonBundle["transactions"];

async function mount(transactions: Transactions, status: string): Promise<void> {
  const bundle = { ...season, season: { ...season.season, status }, transactions };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/season-bundle.json")
        ? new Response(JSON.stringify(bundle), { status: 200 })
        : new Response(null, { status: 404 }),
    ),
  );
  vi.stubGlobal("scrollTo", vi.fn());
  root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/transactions"] },
      createElement(SeasonProvider, null, createElement(App)),
    ),
  );
  await vi.waitFor(() => expect(document.querySelector(".hero .sub")).not.toBeNull());
}

function offerLines(afterWeek: number): string[] {
  return [...document.querySelectorAll(`#after-week-${afterWeek} .offer .arrow`)].map(
    (line) => line.textContent,
  );
}

const [a, b, c] = season.franchises.map((franchise) => franchise.id);
const pass = {
  to: null,
  give: null,
  get: null,
  message: null,
  accepted: null,
  offerReasoning: "Nothing improves the roster.",
  responseReasoning: "",
};
const windows: Transactions = [
  {
    afterWeek: 1,
    order: [a!, b!, c!],
    offers: [
      {
        from: a!,
        to: b!,
        give: season.board[0]!.id,
        get: season.board[1]!.id,
        message: "Straight swap?",
        accepted: false,
        offerReasoning: "Covers a weakness.",
        responseReasoning: "Not for us.",
      },
      { ...pass, from: a! },
      { ...pass, from: c! },
    ],
    moves: [],
  },
  { afterWeek: 3, order: [c!, a!, b!], offers: [{ ...pass, from: c! }], moves: [] },
];

test("a team that offered and then passed is not shown as making no offer", async () => {
  await mount(windows, "regular-season");
  expect(offerLines(1)).toEqual([
    `offers ${season.board[0]!.name} for ${season.board[1]!.name} to`,
    "made no further offer",
    "made no offer",
  ]);
  expect(offerLines(3)).toEqual(["made no offer"]);
});

test("the intro counts the released windows instead of stating a fixed rule", async () => {
  await mount(windows, "regular-season");
  const intro = () => document.querySelector(".hero .sub")?.textContent;
  expect(intro()).toContain(
    "So far 2 transaction windows have been released, after weeks 1 and 3.",
  );
  expect(intro()).not.toContain("one trade");
  root.unmount();
  document.body.innerHTML = "";

  await mount(windows.slice(1), "complete");
  expect(intro()).toContain("This season had 1 transaction window, after week 3.");
  root.unmount();
  document.body.innerHTML = "";

  await mount([], "regular-season");
  expect(intro()).toMatch(/^In a transaction window, each team may offer trades/);
  expect(document.body.textContent).toContain("No transaction window has been released yet.");
});

test("the published season lists each franchise's pass at most once per window", async () => {
  await mount(season.transactions, season.season.status);
  for (const window of season.transactions) {
    const offered = new Set(window.offers.flatMap((offer) => (offer.to ? [offer.from] : [])));
    const lines = offerLines(window.afterWeek);
    expect(lines.filter((line) => line === "made no offer")).toHaveLength(
      window.offers.filter((offer) => !offer.to && !offered.has(offer.from)).length,
    );
    expect(lines.filter((line) => line === "made no further offer")).toHaveLength(
      window.offers.filter((offer) => !offer.to && offered.has(offer.from)).length,
    );
  }
});
