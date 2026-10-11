/**
 * Recursively freeze an object graph so any mutation attempt throws in strict mode.
 * Used to prove the library never mutates its inputs.
 * Cycles are not expected in fixture/document inputs; a WeakSet guards anyway.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value as object);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, seen);
    }
    Object.freeze(value);
  }
  return value;
}
