import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { cachedToolLookup } from "../src/tool-cache.js";

test("tool cache ignores object key order, but preserves tool names, values, and array order", () => {
  let calls = 0;
  const lookup = cachedToolLookup(() => String(++calls));
  const first = { species: "Garchomp", evs: { atk: 32, spe: 32 }, allies: ["A", "B"] };
  const reordered = { allies: ["A", "B"], evs: { spe: 32, atk: 32 }, species: "Garchomp" };
  assert.equal(lookup("calculate_stats", first), "1");
  assert.equal(lookup("calculate_stats", reordered), "1");
  assert.equal(lookup("estimate_damage", first), "2");
  assert.equal(lookup("calculate_stats", { ...first, evs: { atk: 31, spe: 32 } }), "3");
  assert.equal(lookup("calculate_stats", { ...first, allies: ["B", "A"] }), "4");
});

test("tool cache does not retain thrown failures and bounds its retained results", () => {
  let calls = 0;
  const lookup = cachedToolLookup(() => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return String(calls);
  });
  assert.throws(() => lookup("lookup_move", { name: "Protect" }), /temporary failure/);
  assert.equal(lookup("lookup_move", { name: "Protect" }), "2");
  assert.equal(lookup("lookup_move", { name: "Protect" }), "2");
  for (let index = 0; index < 256; index += 1) lookup("lookup_move", { index });
  assert.equal(lookup("lookup_move", { index: 255 }), "258");
  assert.equal(lookup("lookup_move", { name: "Protect" }), "259");
});
