import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  emptyMemory,
  MEMORY_LIMITS,
  parseMemoryReply,
  readMemoryPage,
  renderMemory,
  validateMemory,
} from "../src/franchise-memory.js";
import { accepted, rejection } from "./asserts.js";

test("memory limits reject with the reason instead of clipping", () => {
  assert.equal(validateMemory(emptyMemory("x".repeat(MEMORY_LIMITS.pageChars))), undefined);
  assert.match(
    rejection(validateMemory(emptyMemory("x".repeat(MEMORY_LIMITS.pageChars + 1)))),
    /limit is 8000/,
  );
  assert.match(
    rejection(validateMemory({ notebook: "", "Bad Name": "x" })),
    /page name "Bad Name"/,
  );
  const many = Object.fromEntries([
    ["notebook", ""],
    ...Array.from({ length: MEMORY_LIMITS.pages }, (_, index) => [`p${index}`, "x"]),
  ]);
  assert.match(rejection(validateMemory(many)), /17 pages; the limit is 16/);
  const heavy = Object.fromEntries([
    ["notebook", ""],
    ...Array.from({ length: 7 }, (_, index) => [`p${index}`, "x".repeat(MEMORY_LIMITS.pageChars)]),
  ]);
  assert.match(rejection(validateMemory(heavy)), /totals 56000 characters/);
});

test("a reply changes only what it names: set_pages merges, delete_pages removes, omissions keep", () => {
  const current = { notebook: "old", lessons: "keep", scouting: "drop" };
  const kept = accepted(parseMemoryReply({ notebook: " new " }, current));
  assert.deepEqual(kept.memory, { notebook: "new", lessons: "keep", scouting: "drop" });
  const merged = accepted(
    parseMemoryReply({ set_pages: { lessons: "revised", plans: "new page" } }, current),
  );
  assert.deepEqual(merged.memory, {
    notebook: "old",
    lessons: "revised",
    plans: "new page",
    scouting: "drop",
  });
  const pruned = accepted(
    parseMemoryReply({ notebook: "old", delete_pages: ["scouting", "missing"] }, current),
  );
  assert.deepEqual(pruned.memory, { notebook: "old", lessons: "keep" });
  const unchanged = accepted(parseMemoryReply({}, current));
  assert.deepEqual(unchanged.memory, current);
  assert.match(
    rejection(parseMemoryReply({ set_pages: { notebook: "x" } }, current)),
    /may not contain/,
  );
  assert.match(rejection(parseMemoryReply({ set_pages: ["x"] }, current)), /must be an object/);
  assert.match(
    rejection(parseMemoryReply({ notebook: 3 }, current)),
    /"notebook" must be a string/,
  );
  assert.match(
    rejection(parseMemoryReply({ delete_pages: "scouting" }, current)),
    /must be an array/,
  );
  assert.match(
    rejection(parseMemoryReply({ delete_pages: ["notebook"] }, current)),
    /cannot be deleted/,
  );
  assert.match(
    rejection(
      parseMemoryReply({ set_pages: { lessons: "x" }, delete_pages: ["lessons"] }, current),
    ),
    /both set and deleted/,
  );
  assert.match(
    rejection(parseMemoryReply({ notebook: "n", pages: {} }, current)),
    /"pages" is not a field/,
  );
});

test("the prompt shows the notebook in full and indexes the other pages", () => {
  const memory = {
    notebook: "Lead Garchomp.",
    "opp.beta": "Beta brings Trick Room.\nSecond line.",
    lessons: "",
  };
  const index = renderMemory(memory).join("\n");
  assert.match(index, /^YOUR NOTEBOOK:\nLead Garchomp\./);
  assert.match(
    index,
    /YOUR MEMORY PAGES \(name \| characters \| first line\):\n- lessons \| 0 \| \n- opp\.beta \| 36 \| Beta brings Trick Room\./,
  );
  assert.doesNotMatch(index, /Second line/);
  assert.match(
    renderMemory(memory, "full").join("\n"),
    /YOUR MEMORY PAGE opp\.beta:\nBeta brings Trick Room\.\nSecond line\./,
  );
  assert.deepEqual(renderMemory(emptyMemory()), ["YOUR NOTEBOOK:", "(empty)"]);
  assert.equal(
    readMemoryPage(memory, { name: "opp.beta" }),
    "Beta brings Trick Room.\nSecond line.",
  );
  assert.equal(readMemoryPage(memory, { name: "lessons" }), "(empty)");
  assert.match(
    readMemoryPage(memory, { name: "missing" }),
    /no page named "missing". Your pages: notebook, lessons, opp.beta/,
  );
});
