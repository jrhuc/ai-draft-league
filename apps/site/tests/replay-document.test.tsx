// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ShowdownPlayer, type Team } from "ui/components/replay";

let root: Root;
afterEach(() => {
  root.unmount();
  document.body.innerHTML = "";
});

const raw = [
  "|player|p1|openai:gpt-5|1|",
  "|player|p2|anthropic:claude-opus-4|2|",
  "|turn|1",
  "|move|p1a: Pikachu|Thunderbolt|p2a: Eevee",
  "|-damage|p2a: Eevee|50/100",
  "|win|anthropic:claude-opus-4",
].join("\n");

async function replayDocument(names: [string, string]): Promise<Document> {
  const teams: [Team, Team] = [
    { id: "franchise-0", name: names[0], tone: "red", model: "openai:gpt-5" },
    { id: "franchise-1", name: names[1], tone: "blue", model: "anthropic:claude-opus-4" },
  ];
  root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(createElement(ShowdownPlayer, { game: { number: 1, raw }, teams }));
  await vi.waitFor(() => expect(document.querySelector(".ps-frame")).not.toBeNull());
  const frame = document.querySelector<HTMLIFrameElement>(".ps-frame")!;
  return new DOMParser().parseFromString(frame.srcdoc, "text/html");
}

/** The read replay-embed.js performs on `script.battle-log-data`. */
function embeddedLog(doc: Document): string {
  return doc.querySelector("script.battle-log-data")!.textContent.replace(/\\\//g, "/");
}

test("team names reach the Showdown embed as written", async () => {
  const doc = await replayDocument(["Salt & Pepper", "Cash $& <Carry>"]);
  expect(embeddedLog(doc)).toBe(
    raw
      .replaceAll("openai:gpt-5", () => "Salt & Pepper")
      .replaceAll("anthropic:claude-opus-4", () => "Cash $& <Carry>"),
  );
  expect(doc.title).toBe("Salt & Pepper vs Cash $& <Carry> — Game 1");
});

test("a team name cannot split a log line or close the log script", async () => {
  const doc = await replayDocument(["A|B", "</script><b>Late"]);
  const lines = embeddedLog(doc).split("\n");
  expect(lines[0]).toBe("|player|p1|AB|1|");
  expect(lines[1]).toBe("|player|p2|</script><b>Late|2|");
  expect(lines).toHaveLength(raw.split("\n").length);
  expect(doc.querySelectorAll("script[src]")).toHaveLength(2);
  expect(doc.querySelector("b")).toBeNull();
  expect(doc.title).toBe("A|B vs </script><b>Late — Game 1");
});
