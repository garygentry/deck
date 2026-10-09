import { vi } from "vitest";

/**
 * Stub members of the `Bun` global (`serve`, `spawn`, …) for one test, on either runtime.
 *
 * Under Node there is no `Bun`: the stub goes in with `vi.stubGlobal`, and `unstubBun()` is
 * `vi.unstubAllGlobals()`, so it drops every global stub, not only `Bun`. Under Bun the global
 * is read-only and non-configurable, so `vi.stubGlobal`, assignment and `delete` all throw on
 * it. Its members are writable, though, so each stubbed member is swapped in place and
 * `unstubBun()` puts the original back. Members not named stay real under Bun, as they are in
 * production.
 */
const saved = new Map<string, unknown>();

function realBun(): Record<string, unknown> | undefined {
  return process.versions.bun ? (globalThis as unknown as { Bun: Record<string, unknown> }).Bun : undefined;
}

export function stubBun(members: Record<string, unknown>): void {
  const bun = realBun();
  if (bun === undefined) {
    vi.stubGlobal("Bun", members);
    return;
  }
  for (const [key, value] of Object.entries(members)) {
    if (!saved.has(key)) saved.set(key, bun[key]);
    bun[key] = value;
  }
}

/** Undo every `stubBun` since the last call; safe when nothing is stubbed. See `stubBun`. */
export function unstubBun(): void {
  const bun = realBun();
  if (bun === undefined) {
    vi.unstubAllGlobals();
    return;
  }
  for (const [key, value] of saved) bun[key] = value;
  saved.clear();
}
