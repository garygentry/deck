import { afterEach, describe, expect, it, vi } from "vitest";

import { installChunkReload } from "../src/shell/chunk-reload.js";

function fakeWindow(storage: Map<string, string> | "blocked") {
  const target = new EventTarget();
  const reload = vi.fn();
  const sessionStorage = {
    getItem: (k: string) => {
      if (storage === "blocked") throw new Error("blocked");
      return storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storage === "blocked") throw new Error("blocked");
      storage.set(k, v);
    },
  };
  const win = Object.assign(target, { sessionStorage, location: { reload } }) as unknown as Window;
  return { win, reload };
}

function fire(win: Window): Event {
  const event = new Event("vite:preloadError", { cancelable: true });
  win.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installChunkReload", () => {
  it("reloads once on a failed chunk and swallows the error", () => {
    const { win, reload } = fakeWindow(new Map());
    installChunkReload(win);
    const event = fire(win);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets a repeat failure right after a reload reach the error boundary", () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    const first = fakeWindow(storage);
    installChunkReload(first.win);
    fire(first.win);

    vi.advanceTimersByTime(2_000);
    const second = fakeWindow(storage);
    installChunkReload(second.win);
    const event = fire(second.win);
    expect(second.reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("reloads again for a later, unrelated upgrade", () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    const first = fakeWindow(storage);
    installChunkReload(first.win);
    fire(first.win);

    vi.advanceTimersByTime(60_000);
    const second = fakeWindow(storage);
    installChunkReload(second.win);
    fire(second.win);
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads when storage is blocked (no loop guard)", () => {
    const { win, reload } = fakeWindow("blocked");
    installChunkReload(win);
    expect(fire(win).defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
