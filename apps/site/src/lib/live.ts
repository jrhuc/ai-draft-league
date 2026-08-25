const KEY = "live-run";

export function liveRunId(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function startWatching(runId: string): void {
  try {
    sessionStorage.setItem(KEY, runId);
  } catch {
    return;
  }
}

export function stopWatching(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
}
