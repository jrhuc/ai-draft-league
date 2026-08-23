import type { ClientCapabilities } from './capability-contract.js';

export type ViewId = 'arena' | 'tournaments' | 'fixtures';

interface RouteDefinition {
  readonly id: ViewId;
  readonly hash: string;
  readonly label: string;
  readonly section: 'Operator';
  readonly capability?: keyof ClientCapabilities;
}

const ROUTES = [
  { id: 'arena', hash: 'live', label: 'Live', section: 'Operator', capability: 'monitorRuns' },
  { id: 'tournaments', hash: 'tournaments', label: 'Tournaments', section: 'Operator' },
  { id: 'fixtures', hash: 'new-run', label: 'New run', section: 'Operator', capability: 'startRuns' },
] as const satisfies readonly RouteDefinition[];

export type Route = { view: Exclude<ViewId, 'tournaments'> } | { view: 'tournaments'; run?: string };

export interface NavigationSet {
  label: 'Operator';
  items: ReadonlyArray<{ id: ViewId; label: string }>;
}

function decodeHashSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function routeEnabled(route: RouteDefinition, capabilities: Readonly<ClientCapabilities>): boolean {
  return route.capability === undefined || capabilities[route.capability];
}

export function navigationFor(capabilities: Readonly<ClientCapabilities>): NavigationSet[] {
  const items = ROUTES.filter((route) => routeEnabled(route, capabilities)).map((route) => ({
    id: route.id,
    label: route.label,
  }));
  return items.length > 0 ? [{ label: 'Operator', items }] : [];
}

export function routeForView(view: ViewId): Route {
  return view === 'tournaments' ? { view } : { view };
}

export function routeFromHash(hash: string, capabilities: Readonly<ClientCapabilities>): Route {
  const segments = hash.replace(/^#/, '').split('/').map(decodeHashSegment);
  const [head = '', run = ''] = segments;
  const definition = ROUTES.find((route) => route.hash === head && routeEnabled(route, capabilities));
  if (!definition) return { view: 'arena' };
  if (definition.id === 'tournaments') {
    const route: Route = { view: definition.id };
    if (run) route.run = run;
    return route;
  }
  return { view: definition.id };
}

export function titleForRoute(route: Route): string {
  if (route.view === 'tournaments' && route.run) return 'Tournament';
  return ROUTES.find((definition) => definition.id === route.view)?.label ?? 'Live';
}

export function hrefForRoute(route: Route): string {
  if (route.view === 'tournaments' && route.run) return `#tournaments/${encodeURIComponent(route.run)}`;
  const hash = ROUTES.find((definition) => definition.id === route.view)?.hash ?? 'live';
  return `#${hash}`;
}

export function hrefForView(view: ViewId): string {
  return hrefForRoute(routeForView(view));
}
