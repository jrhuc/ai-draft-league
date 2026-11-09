// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { Frame } from "ui/components/frame";
import { ReplayViewer, type ReplayGameView, type Team } from "ui/components/replay";
import { replayPositionPath } from "ui/lib/replay-position";

const teams: [Team, Team] = [
  { id: "franchise-0", name: "Alpha", tone: "red", model: "openai/gpt-5" },
  { id: "franchise-1", name: "Beta", tone: "blue", model: "openai/gpt-5" },
];
const games: ReplayGameView[] = [1, 2].map((number) => ({
  number,
  turns: 3,
  winner: teams[0],
  raw: "|turn|1",
  events: [],
  reflections: [],
  decisions: [0, 1, 2].flatMap((turn) =>
    teams.map((team) => ({
      team,
      turn,
      phase: "turn",
      action: "move 1",
      selection: ["Protect"],
      rationale: `Reason ${team.name}`,
      automatic: false,
      latencyMs: 100,
      reasoningTokens: 0,
    })),
  ),
}));

let root: Root;
afterEach(() => {
  root.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>{location.search}</output>
      <button type="button" onClick={() => void navigate("/elsewhere#turn-1")}>
        Elsewhere
      </button>
      <button type="button" onClick={() => void navigate(-1)}>
        History back
      </button>
    </>
  );
}

function mount(path: string) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      <>
        <Location />
        <ReplayViewer games={games} teams={teams} />
      </>,
    ),
  );
}

function mountFramed(path: string) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      <Frame wordmark="League" release="Week 1" repo="https://example.test" footer={null}>
        <Location />
        <ReplayViewer games={games} teams={teams} />
      </Frame>,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}

async function settled(search: string): Promise<void> {
  await vi.waitFor(() => expect(document.querySelector("output")?.textContent).toBe(search));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("replay controls inside the frame keep the scroll position and focus", async () => {
  const scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  mountFramed("/matches/series-1?game=2&turn=2&seat=franchise-1#turn-2");
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("main"));
  scrollTo.mockClear();

  const tab = document.querySelector<HTMLButtonElement>(".game-tabs button")!;
  tab.focus();
  tab.click();
  await settled("?game=1&seat=franchise-1");
  expect(scrollTo).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(tab);

  const turn = document.querySelector<HTMLSelectElement>(".replay-position select")!;
  turn.focus();
  turn.value = "1";
  turn.dispatchEvent(new Event("change", { bubbles: true }));
  await settled("?game=1&seat=franchise-1&turn=1");
  expect(scrollTo).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(turn);
});

test("a new page focuses main and still reaches its fragment target", async () => {
  vi.stubGlobal("scrollTo", vi.fn());
  const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
  mountFramed("/matches/series-1");
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("main"));
  expect(scrollIntoView).not.toHaveBeenCalled();

  const elsewhere = button("Elsewhere");
  elsewhere.focus();
  elsewhere.click();
  await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
  expect(scrollIntoView.mock.contexts).toEqual([document.getElementById("turn-1")]);
  expect(document.activeElement?.id).toBe("main");
});

test("deep links restore game, decision turn, and team; history restores selection", async () => {
  const path = replayPositionPath("series-1", 2, 2, "franchise-1");
  expect(path).toBe("/matches/series-1?game=2&turn=2&seat=franchise-1");
  mount(path);
  await vi.waitFor(() =>
    expect(document.querySelector(".game-tabs [aria-pressed=true]")?.textContent).toContain(
      "Game 2",
    ),
  );
  expect(document.querySelector(".turn-selected")?.id).toBe("turn-2");
  expect([...document.querySelectorAll(".dec .who")].map((row) => row.textContent)).toEqual([
    "Beta",
    "Beta",
    "Beta",
  ]);
  document.querySelector<HTMLButtonElement>(".game-tabs button")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector("output")?.textContent).toBe("?game=1&seat=franchise-1"),
  );
  expect(document.querySelector(".turn-selected")).toBeNull();
  button("History back").click();
  await vi.waitFor(() => expect(document.querySelector(".turn-selected")?.id).toBe("turn-2"));
  expect(document.querySelector(".game-tabs [aria-pressed=true]")?.textContent).toContain("Game 2");
});

test("invalid URL positions do not hide the replay or its teams", async () => {
  mount("/matches/series-1?game=99&turn=-4&seat=missing");
  await vi.waitFor(() => expect(document.querySelectorAll(".dec")).toHaveLength(6));
  expect(document.querySelector(".game-tabs [aria-pressed=true]")?.textContent).toContain("Game 1");
  expect(document.querySelector(".turn-selected")).toBeNull();
});
