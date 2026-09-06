// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vite-plus/test";
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
      fallback: false,
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
});

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>{location.search}</output>
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

test("deep links restore game, decision turn, and team; history restores selection", async () => {
  mount(replayPositionPath("series-1", 2, 2, "franchise-1"));
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
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === "History back")!
    .click();
  await vi.waitFor(() => expect(document.querySelector(".turn-selected")?.id).toBe("turn-2"));
  expect(document.querySelector(".game-tabs [aria-pressed=true]")?.textContent).toContain("Game 2");
});

test("invalid URL positions do not hide the replay or its teams", async () => {
  mount("/matches/series-1?game=99&turn=-4&seat=missing");
  await vi.waitFor(() => expect(document.querySelectorAll(".dec")).toHaveLength(6));
  expect(document.querySelector(".game-tabs [aria-pressed=true]")?.textContent).toContain("Game 1");
  expect(document.querySelector(".turn-selected")).toBeNull();
});
