import { useEffect, useRef, useState } from 'preact/hooks';

import type { AppStateResponse } from '../api';
import { CLIENT_CAPABILITIES } from './capabilities.js';
import { api } from './http';
import { type OperationalStatus, OperationalWorkspace } from './operational-loader.js';
import {
  hrefForRoute,
  hrefForView,
  navigationFor,
  type Route,
  routeForView,
  routeFromHash,
  titleForRoute,
  type ViewId,
} from './routes';
import { TournamentsView } from './views/tournaments';

const NAV_SETS = navigationFor(CLIENT_CAPABILITIES);

function focusMainContent(event: MouseEvent, main: HTMLElement | null): void {
  event.preventDefault();
  main?.focus();
}

export function App() {
  const [app, setApp] = useState<AppStateResponse | null>(null);
  const [stateError, setStateError] = useState('');
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash, CLIENT_CAPABILITIES));
  const [recordsEpoch, setRecordsEpoch] = useState(0);
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatus | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const skipLinkRef = useRef<HTMLAnchorElement | null>(null);
  const routeFocusReady = useRef(false);

  useEffect(() => {
    let current = true;
    api<AppStateResponse>('/api/state')
      .then((state) => {
        if (!current) return;
        setApp(state);
        setStateError('');
      })
      .catch((error: Error) => {
        if (current) setStateError(error.message);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const link = skipLinkRef.current;
    if (!link) return;
    const onClick = (event: MouseEvent) => focusMainContent(event, mainRef.current);
    link.addEventListener('click', onClick);
    return () => link.removeEventListener('click', onClick);
  }, [app]);

  useEffect(() => {
    const onRouteChange = () => setRoute(routeFromHash(window.location.hash, CLIENT_CAPABILITIES));
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
    return () => {
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
    };
  }, []);

  useEffect(() => {
    document.title = `${titleForRoute(route)} · VGC Model League`;
    if (!routeFocusReady.current) {
      routeFocusReady.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [route]);

  const drillRoute = (next: Route) => {
    setRoute(next);
    const href = hrefForRoute(next);
    if (`${window.location.hash || '#'}` !== href) history.pushState(null, '', href);
    window.scrollTo(0, 0);
  };

  const navigate = (next: ViewId) => drillRoute(routeForView(next));
  const openTournament = (runId: string) =>
    drillRoute(runId ? { view: 'tournaments', run: runId } : { view: 'tournaments' });
  const view = route.view;

  return (
    <>
      <a ref={skipLinkRef} class="skip-link" href="#main-content" aria-controls="main-content">
        Skip to main content
      </a>
      <header class={`app-header ${operationalStatus ? 'has-aside' : ''}`}>
        <button type="button" class="brand" aria-label="VGC Model League live view" onClick={() => navigate('arena')}>
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-name">
            VGC MODEL LEAGUE<small>Model decisions in a pinned VGC simulator</small>
          </span>
        </button>
        <nav class="primary-nav" aria-label="Main navigation">
          {NAV_SETS.map((set) => (
            <div class="nav-set" key={set.label}>
              <span class="nav-set-label">{set.label}</span>
              <div class="nav-set-items">
                {set.items.map((item) => (
                  <a
                    key={item.id}
                    href={hrefForView(item.id)}
                    class={`nav-button ${view === item.id ? 'on' : ''}`}
                    aria-current={view === item.id ? 'page' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(item.id);
                    }}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {operationalStatus ? (
          <div class="header-aside">
            <div class={`header-state ${operationalStatus.tone}`}>
              <span class="live-dot" />
              <span>{operationalStatus.label}</span>
            </div>
          </div>
        ) : null}
      </header>
      <main id="main-content" class="shell" tabIndex={-1} ref={mainRef}>
        <OperationalWorkspace
          app={app}
          stateError={stateError}
          view={view}
          navigate={navigate}
          openTournament={openTournament}
          onPools={(pools) => setApp((previous) => (previous ? { ...previous, pools } : previous))}
          onRunSettled={() => setRecordsEpoch((epoch) => epoch + 1)}
          onStatus={setOperationalStatus}
        />
        {view === 'tournaments' ? (
          <section class="view on">
            <TournamentsView epoch={recordsEpoch} run={route.run} onOpenRun={openTournament} />
          </section>
        ) : null}
      </main>
    </>
  );
}
