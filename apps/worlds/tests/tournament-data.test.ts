import { expect, test } from "vite-plus/test";
import { publicTournamentBundleSchema } from "league/protocol";
import bundleValue from "../public/tournament-bundle.json";
import { entrantStats } from "../src/lib/load";

test("the published tournament bundle has coherent selection evidence", () => {
  const bundle = publicTournamentBundleSchema.parse(bundleValue);
  for (const round of bundle.bracket.rounds) {
    for (const slot of round) {
      if (!slot.match) continue;
      const replay = bundle.replays[slot.match.seriesId];
      expect(replay).toBeDefined();
      expect(replay?.games).toHaveLength(slot.match.games.length);
      for (const game of slot.match.games) {
        for (const side of [0, 1] as const) {
          expect(game.brought[side]).toHaveLength(4);
        }
      }
    }
  }
});

test("the protect rate counts every protection move by its exact name", () => {
  const bundle = publicTournamentBundleSchema.parse(bundleValue);
  const [seriesId, replay] = Object.entries(bundle.replays)[0]!;
  const game = replay.games[0]!;
  const template = game.decisions.find((decision) => decision.phase === "turn")!;
  const selections = [
    ["Protect", "Rock Slide (both foes)"],
    ["Close Combat -> foe 1 (Kingambit)", "Detect + Mega Evolve"],
    ["Baneful Bunker [success rate reduced: Protected last turn]"],
    ["Spiky Shield"],
    ["King's Shield"],
    ["Obstruct"],
    ["Silk Trap"],
    ["Burning Bulwark"],
    ["Wide Guard (your side)", "Protective Pads"],
    ["Switch to Toxapex"],
  ];
  const decisions = selections.map((selection) => ({ ...template, automatic: false, selection }));
  const stats = entrantStats({
    ...bundle,
    replays: { [seriesId]: { ...replay, games: [{ ...game, decisions }] } },
  });
  expect(stats.find((row) => row.entrantId === template.entrantId)).toMatchObject({
    protectRate: 0.8,
    switchRate: 0.1,
  });
});
