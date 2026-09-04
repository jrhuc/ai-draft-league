import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PokeBall } from "../components/pokeball";

/**
 * A fetched, schema-parsed bundle behind a context: one Provider that boots,
 * retries, and optionally re-polls, plus the hooks pages read it through.
 */
export function createBundle<T>(
  load: () => Promise<T>,
  siteTitle: (bundle: T) => string,
  failure: string,
  pollMs: () => number | null = () => null,
) {
  const Context = createContext<T | null>(null);
  let pending: Promise<T> | null = null;
  const loadOnce = (): Promise<T> => {
    if (!pending) {
      const attempt = load();
      pending = attempt;
      void attempt.catch(() => {
        if (pending === attempt) pending = null;
      });
    }
    return pending;
  };

  function Provider({ children }: { children: ReactNode }) {
    const [bundle, setBundle] = useState<T | null>(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let live = true;
      setFailed(false);
      loadOnce().then(
        (value) => {
          if (live) setBundle(value);
        },
        () => {
          if (live) setFailed(true);
        },
      );
      const interval = pollMs();
      const timer =
        interval === null
          ? null
          : setInterval(() => {
              void load().then(
                (value) => {
                  if (live) setBundle(value);
                },
                () => undefined,
              );
            }, interval);
      return () => {
        live = false;
        if (timer !== null) clearInterval(timer);
      };
    }, [attempt]);
    if (failed) {
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
    return <Context.Provider value={bundle}>{children}</Context.Provider>;
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
