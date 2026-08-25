interface WireMeta {
  error?: string;
  live?: boolean;
  lifecycle?: string;
}

const immutableCache = new Map<string, unknown>();
const requests = new Map<string, Promise<unknown>>();

async function request<T, Body extends object>(pathname: string, body?: Body): Promise<T & WireMeta> {
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const response = await fetch(pathname, init);
  const data: T & WireMeta = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function immutableResponse(pathname: string, data: WireMeta): boolean {
  if (pathname === '/api/board' || pathname.startsWith('/api/board?')) return true;
  if (!pathname.startsWith('/api/tournament/game?')) return false;
  if (data.live !== undefined) return data.live === false;
  return data.lifecycle !== undefined && data.lifecycle !== 'live';
}

function load<T>(pathname: string): Promise<T> {
  const cached = immutableCache.get(pathname) ?? requests.get(pathname);
  if (cached === undefined) {
    const next = request<T, never>(pathname)
      .then((data) => {
        if (immutableResponse(pathname, data)) immutableCache.set(pathname, data);
        return data;
      })
      .finally(() => requests.delete(pathname));
    requests.set(pathname, next);
    return next;
  }
  // SAFETY: entries are only written by load<T> for the same pathname, and each endpoint has one response type.
  return Promise.resolve(cached as T);
}

export async function api<T, Body extends object = object>(pathname: string, body?: Body): Promise<T> {
  return body === undefined ? load<T>(pathname) : request<T, Body>(pathname, body);
}

export async function apiFresh<T>(pathname: string): Promise<T> {
  const data = await request<T, never>(pathname);
  if (immutableResponse(pathname, data)) immutableCache.set(pathname, data);
  return data;
}
