import { expect, test } from "vite-plus/test";
import { buildChanges } from "../src/lib/build-changes";
import type { Match } from "../src/lib/season";

const build: Match["builds"][number] = {
  franchiseId: "franchise-0",
  prepared: ["rotom", "pikachu"],
  rationale: "MODEL_PLAN",
  attempts: 1,
  sets: [
    {
      species: "Rotom-Wash",
      spriteId: "rotomwash",
      item: "Sitrus Berry",
      ability: "Levitate",
      nature: "Bold",
      moves: ["Protect", "Thunderbolt"],
      evs: { hp: 252, def: 252, spd: 4 },
    },
    {
      species: "Pikachu",
      spriteId: "pikachu",
      item: "Light Ball",
      ability: "Static",
      nature: "Timid",
      moves: ["Protect"],
      evs: { spe: 252 },
    },
  ],
};

test("registration changes and per-set changes are separate", () => {
  const current = structuredClone(build);
  current.prepared[1] = "eevee";
  current.sets![1] = { ...current.sets![1]!, species: "Eevee" };
  current.sets![0]!.item = "Choice Scarf";
  expect(buildChanges(build, current)).toEqual({
    added: ["eevee"],
    removed: ["pikachu"],
    setsVisible: true,
    sets: [{ species: "Rotom-Wash", field: "Item", before: "Sitrus Berry", after: "Choice Scarf" }],
  });
});

test("set, move, and EV key ordering do not invent changes", () => {
  const current = structuredClone(build);
  current.sets![0]!.moves.reverse();
  current.sets![0]!.evs = { spd: 4, atk: 0, def: 252, hp: 252 };
  current.prepared.reverse();
  current.sets!.reverse();
  expect(buildChanges(build, current)).toEqual({
    added: [],
    removed: [],
    sets: [],
    setsVisible: true,
  });
});

test("form changes on the same draft slot remain visible", () => {
  const current = structuredClone(build);
  current.sets![0]!.species = "Rotom-Heat";
  expect(buildChanges(build, current).sets).toEqual([
    { species: "Rotom-Heat", field: "Species", before: "Rotom-Wash", after: "Rotom-Heat" },
  ]);
});

test("closed set details are unavailable, not unchanged", () => {
  expect(buildChanges({ ...build, sets: null }, build)).toEqual({
    added: [],
    removed: [],
    sets: [],
    setsVisible: false,
  });
});
