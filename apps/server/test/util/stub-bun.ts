/**
 * Stub members of the `Bun` global (`serve`, `spawn`, …) for one test, on either runtime, and
 * undo them with `unstubBun()`. Both runtimes behave the same way: calls accumulate member by
 * member, and `unstubBun()` restores only what `stubBun` changed, never other global stubs.
 *
 * - Under Node there is no `Bun`: the first call installs one fake object as the global and
 *   later calls add members to it. A member never stubbed is absent, so calling it throws.
 * - Under Bun the global is read-only and non-configurable (`vi.stubGlobal`, assignment and
 *   `delete` all throw), but its members are writable: each stubbed member is swapped in place.
 *   A member never stubbed stays real, as in production.
 *
 * So a test must stub every member the code under test calls. The parity harness, for one,
 * stubs `serve` (no listener) and `spawn` (throws: no process ever starts) explicitly rather
 * than relying on either runtime's default.
 */
const saved = new Map<string, unknown>();
let nodeStub: { previous: PropertyDescriptor | undefined; members: Record<string, unknown> } | undefined;

function realBun(): Record<string, unknown> | undefined {
  return process.versions.bun ? (globalThis as unknown as { Bun: Record<string, unknown> }).Bun : undefined;
}

export function stubBun(members: Record<string, unknown>): void {
  const bun = realBun();
  if (bun === undefined) {
    if (nodeStub === undefined) {
      nodeStub = { previous: Object.getOwnPropertyDescriptor(globalThis, "Bun"), members: {} };
      Object.defineProperty(globalThis, "Bun", { value: nodeStub.members, configurable: true, writable: true });
    }
    Object.assign(nodeStub.members, members);
    return;
  }
  for (const [key, value] of Object.entries(members)) {
    if (!saved.has(key)) saved.set(key, bun[key]);
    bun[key] = value;
  }
}

/** Undo every `stubBun` since the last call; safe when nothing is stubbed. */
export function unstubBun(): void {
  if (nodeStub !== undefined) {
    if (nodeStub.previous === undefined) delete (globalThis as { Bun?: unknown }).Bun;
    else Object.defineProperty(globalThis, "Bun", nodeStub.previous);
    nodeStub = undefined;
  }
  const bun = realBun();
  if (bun === undefined) return;
  for (const [key, value] of saved) bun[key] = value;
  saved.clear();
}
