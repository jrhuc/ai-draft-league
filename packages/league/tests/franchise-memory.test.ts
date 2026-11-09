import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  emptyMemory,
  MEMORY_LIMITS,
  MemoryRejection,
  parseMemoryReply,
  readMemoryPage,
  renderMemory,
  validateMemory,
} from "../src/franchise-memory.js";
import { rejection } from "./asserts.js";

const PLAN = { notebookField: "plan" };

function memoryRejection(attempt: () => void): MemoryRejection {
  try {
    attempt();
  } catch (error) {
    assert.ok(error instanceof MemoryRejection);
    return error;
  }
  throw new Error("expected a MemoryRejection");
}

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

test("an oversized page is the only thing not saved and the rejection carries the rest", () => {
  const current = { notebook: "old", keep: "k" };
  const attempt = () =>
    parseMemoryReply(
      {
        notebook: "x".repeat(MEMORY_LIMITS.pageChars + 1),
        set_pages: { fine: "ok", big: "y".repeat(MEMORY_LIMITS.pageChars + 40) },
      },
      current,
      PLAN,
    );
  const partial = memoryRejection(attempt);
  assert.deepEqual(partial.memory, { notebook: "old", keep: "k", fine: "ok" });
  assert.match(
    partial.message,
    /Not saved: plan is 8001 characters; the limit is 8000, so cut at least 1/,
  );
  assert.match(partial.message, /page "big" is 8040 characters/);
  assert.match(partial.message, /Saved: page "fine"; every other page is kept/);
  assert.match(
    partial.message,
    /Memory now: plan 3, page "fine" 2, page "keep" 1 \(6 of 48000 characters\)/,
  );
  const full = Object.fromEntries([
    ["notebook", "n".repeat(7000)],
    ...Array.from({ length: 5 }, (_, index) => [`p${index}`, "x".repeat(MEMORY_LIMITS.pageChars)]),
  ]);
  const overflow = memoryRejection(() =>
    parseMemoryReply({ set_pages: { p6: "z".repeat(2000) } }, full, PLAN),
  );
  assert.match(
    overflow.message,
    /page "p6" would take the memory to 49000 characters; the limit is 48000, so it needs to be at least 1000 characters shorter/,
  );
  assert.deepEqual(overflow.memory, full);
  const rescued = parseMemoryReply(
    { set_pages: { p6: "z".repeat(2000), p0: "x".repeat(1000) } },
    full,
    PLAN,
  );
  assert.equal(rescued.memory.p6?.length, 2000);
  assert.equal(rescued.memory.p0?.length, 1000);
});

test("a reply changes only what it names: set_pages merges, delete_pages removes, omissions keep", () => {
  const current = { notebook: "old", lessons: "keep", scouting: "drop" };
  const kept = parseMemoryReply({ notebook: " new " }, current, PLAN);
  assert.deepEqual(kept.memory, { notebook: "new", lessons: "keep", scouting: "drop" });
  const merged = parseMemoryReply(
    { set_pages: { lessons: "revised", plans: "new page" } },
    current,
    PLAN,
  );
  assert.deepEqual(merged.memory, {
    notebook: "old",
    lessons: "revised",
    plans: "new page",
    scouting: "drop",
  });
  const pruned = parseMemoryReply(
    { notebook: "old", delete_pages: ["scouting", "missing"] },
    current,
    PLAN,
  );
  assert.deepEqual(pruned.memory, { notebook: "old", lessons: "keep" });
  const unchanged = parseMemoryReply({}, current, PLAN);
  assert.deepEqual(unchanged.memory, current);
  assert.throws(
    () => parseMemoryReply({ set_pages: { notebook: "x" } }, current, PLAN),
    /"set_pages" may not contain "notebook"; that page is the "plan" field/,
  );
  assert.throws(
    () => parseMemoryReply({ delete_pages: ["notebook"] }, current, PLAN),
    /the "notebook" page cannot be deleted; replace it with "plan"/,
  );
  assert.throws(
    () =>
      parseMemoryReply({ set_pages: { lessons: "x" }, delete_pages: ["lessons"] }, current, PLAN),
    /both set and deleted/,
  );
  assert.throws(
    () => parseMemoryReply({ set_pages: { "Bad Name": "x" } }, current, PLAN),
    /page name "Bad Name" must be 1-48 lowercase letters/,
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
