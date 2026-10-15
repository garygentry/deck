import { afterEach, describe, expect, it, vi } from "vitest";

import { settlesWithin } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("settlesWithin", () => {
  it("is true for a promise that resolves within the bound", async () => {
    await expect(settlesWithin(Promise.resolve("done"), 1_000)).resolves.toBe(true);
  });

  it("is true for a promise that rejects within the bound, and swallows the rejection", async () => {
    await expect(settlesWithin(Promise.reject(new Error("boom")), 1_000)).resolves.toBe(true);
  });

  it("is false once the bound passes with the promise still pending", async () => {
    vi.useFakeTimers();
    const result = settlesWithin(new Promise(() => {}), 500);
    await vi.advanceTimersByTimeAsync(499);
    let settled: boolean | undefined;
    void result.then((value) => (settled = value));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });

  it("clears its timer when the promise settles first", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const result = settlesWithin(new Promise<void>((r) => (resolve = r)), 10_000);
    expect(vi.getTimerCount()).toBe(1);
    resolve();
    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unrefs its timer so a pending wait never keeps the process alive", async () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      const realUnref = (timer as { unref?: () => unknown }).unref?.bind(timer);
      return Object.assign(timer, { unref: () => (unref(), realUnref?.()) });
    }) as typeof setTimeout);
    try {
      await settlesWithin(Promise.resolve(), 1_000);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
