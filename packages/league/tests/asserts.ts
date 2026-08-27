import assert from "node:assert/strict";

export function accepted<T extends object>(result: T | string, message?: string): T {
  if (result instanceof Object) return result;
  assert.fail(message ?? result);
}

export function rejection<T extends object>(
  result: T | string | undefined,
  message?: string,
): string {
  if (result instanceof Object || result === undefined)
    assert.fail(message ?? `expected a rejection reason, got ${JSON.stringify(result)}`);
  return result;
}
