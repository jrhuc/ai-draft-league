import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { publicTournamentBundleSchema } from "league/protocol";
import { PokeBall } from "@/components/pokeball";
import type { TournamentBundle } from "./tournament";

let bundlePromise: Promise<TournamentBundle> | null = null;

async function fetchBundle(): Promise<TournamentBundle> {
  const response = await fetch("/tournament-bundle.json");
  if (!response.ok) throw new Error(`tournament-bundle.json responded ${response.status}`);
  const value: unknown = await response.json();
  return publicTournamentBundleSchema.parse(value);
}

function loadBundle(): Promise<TournamentBundle> {
  if (!bundlePromise) {
    const pending = fetchBundle();
    bundlePromise = pending;
    void pending.catch(() => {
      if (bundlePromise === pending) bundlePromise = null;
    });
  }
  return bundlePromise;
}

const TournamentContext = createContext<TournamentBundle | null>(null);

export function TournamentProvider({ children }: { children: ReactNode }) {
  const [bundle, setBundle] = useState<TournamentBundle | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadBundle().then(
      (value) => {
        if (live) setBundle(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  if (failed) {
    return (
      <div className="boot" role="alert">
        <h1>Could not load the tournament</h1>
        <p>Check your connection, then try again.</p>
        <button className="retry" type="button" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="boot" role="status">
        <PokeBall size={30} className="boot-ball" />
        Loading…
      </div>
    );
  }
  return <TournamentContext.Provider value={bundle}>{children}</TournamentContext.Provider>;
}

export function useTournament(): TournamentBundle {
  const bundle = useContext(TournamentContext);
  if (!bundle) throw new Error("useTournament must be used inside <TournamentProvider>");
  return bundle;
}

export function useTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${title} · AI Pokémon Worlds 2026` : "AI Pokémon Worlds 2026";
  }, [title]);
}
