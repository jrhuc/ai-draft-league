import { expect, test } from "vite-plus/test";
import { publicTournamentBundleSchema } from "league/protocol";
import bundleValue from "../public/tournament-bundle.json";

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
          expect(game.brought[side].length).toBeLessThanOrEqual(4);
          expect(game.broughtComplete[side]).toBe(game.brought[side].length === 4);
        }
      }
    }
  }
});
