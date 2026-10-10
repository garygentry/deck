import { afterEach, describe, expect, it, vi } from "vitest";

import { stubBun, unstubBun } from "./util/stub-bun.js";

const bunGlobal = () => (globalThis as { Bun?: Record<string, unknown> }).Bun;

afterEach(() => {
  unstubBun();
  vi.unstubAllGlobals();
});

describe("stubBun", () => {
  it("accumulates members across calls", () => {
    const serve = () => "serve";
    const spawn = () => "spawn";
    stubBun({ serve });
    stubBun({ spawn });
    expect(bunGlobal()?.serve).toBe(serve);
    expect(bunGlobal()?.spawn).toBe(spawn);
  });

  it("restores Bun, and only Bun", () => {
    const before = bunGlobal();
    const realServe = before?.serve;
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    stubBun({ serve: () => "stub" });
    unstubBun();
    // Under Node the global is gone again; under Bun it is the real object with its real serve.
    expect(bunGlobal()).toBe(before);
    expect(bunGlobal()?.serve).toBe(realServe);
    expect(globalThis.fetch).toBe(fetchStub);
  });

  it("is safe to undo when nothing is stubbed", () => {
    const before = bunGlobal();
    unstubBun();
    expect(bunGlobal()).toBe(before);
  });
});
