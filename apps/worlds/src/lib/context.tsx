import { publicTournamentBundleSchema } from "league/protocol";
import { createBundle } from "ui/lib/bundle";
import type { TournamentBundle } from "./tournament";

async function fetchBundle(): Promise<TournamentBundle> {
  const response = await fetch("/tournament-bundle.json");
  if (!response.ok) throw new Error(`tournament-bundle.json responded ${response.status}`);
  const value: unknown = await response.json();
  return publicTournamentBundleSchema.parse(value);
}

const bundle = createBundle(
  fetchBundle,
  () => "AI Pokémon Worlds 2026",
  "Could not load the tournament",
);

export const TournamentProvider = bundle.Provider;
export const useTournament = bundle.useBundle;
export const useTitle = bundle.useTitle;
