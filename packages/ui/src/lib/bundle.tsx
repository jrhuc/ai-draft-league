import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PokeBall } from "../components/pokeball";

export function createBundle<T>(
  load: () => Promise<T>,
  siteTitle: (bundle: T) => string,
  failure: string,
  subscribe?: (refresh: () => void) => (() => void) | undefined,
) {
  const Context = createContext<T | null>(null);
  let pending: Promise<T> | null = null;
  const loadOnce = (): Promise<T> => {
    if (!pending) {
      const attempt = load();
      pending = attempt;
      void attempt.then(
        () => {
          if (pending === attempt) pending = null;
        },
        () => {
          if (pending === attempt) pending = null;
        },
      );
    }
    return pending;
  };

  function Provider({ children }: { children: ReactNode }) {
    const [bundle, setBundle] = useState<T | null>(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let live = true;
      let loading = false;
      let requested = false;
      setFailed(false);
      const refresh = async (): Promise<void> => {
        requested = true;
        if (loading) return;
        loading = true;
        while (live && requested) {
          requested = false;
          try {
            const value = await loadOnce();
            if (live) {
              setBundle(value);
              setFailed(false);
            }
          } catch {
            if (live) setFailed(true);
          }
        }
        loading = false;
      };
      void refresh();
      const unsubscribe = subscribe?.(() => void refresh());
      return () => {
        live = false;
        unsubscribe?.();
      };
    }, [attempt]);
    if (failed && !bundle) {
      return (
        <div className="boot" role="alert">
          <h1>{failure}</h1>
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
    return (
      <Context.Provider value={bundle}>
        {failed ? (
          <p className="watch-notice" role="status">
            Live refresh failed. Showing the last loaded season.{" "}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          </p>
        ) : null}
        {children}
      </Context.Provider>
    );
  }

  function useBundle(): T {
    const bundle = useContext(Context);
    if (!bundle) throw new Error("useBundle must be used inside its Provider");
    return bundle;
  }

  function useTitle(title?: string): void {
    const site = siteTitle(useBundle());
    useEffect(() => {
      document.title = title ? `${title} · ${site}` : site;
    }, [title, site]);
  }

  return { Provider, useBundle, useTitle };
}
