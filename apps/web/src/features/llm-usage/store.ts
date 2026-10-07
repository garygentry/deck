import { POLL_DEFAULTS, type LlmUsageResponse } from "@deck/server";
import { useSyncExternalStore } from "react";

/**
 * One shared poller for `GET /api/llm-usage`, used by the page and the header pill so
 * they never double-poll. Every read counts as viewer presence on the server, which
 * keeps its upstream polling awake, so this store only polls while something is
 * subscribed and the tab is visible. Once the server says the feature is off it stops
 * for good: the `llmUsage` section is read once at boot.
 */

export type UsageView =
  | { status: "loading" }
  /**
   * `error` is the last failed poll's message; `data` stays the last good response.
   * `clockOffsetMs` is server time minus browser time at receipt: every timestamp in
   * `data` is a server epoch, so countdowns add it to `Date.now()`.
   */
  | { status: "ready"; data: LlmUsageResponse; error: string | null; clockOffsetMs: number }
  | { status: "error"; message: string };

export interface UsageStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UsageView;
  /** Ask the server for an immediate upstream poll (debounced server-side). */
  refresh(): Promise<void>;
  /** Re-read the current state without forcing an upstream poll (error-state retry). */
  reload(): Promise<void>;
}

export interface UsageStoreOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
  /** The document to watch for visibility; omitted outside a browser. */
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

const LOADING: UsageView = { status: "loading" };

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const intervalMs = options.intervalMs ?? POLL_DEFAULTS.pollIntervalMs;
  const doc = options.doc ?? (typeof document === "undefined" ? undefined : document);

  let view: UsageView = LOADING;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disabled = false;
  const listeners = new Set<() => void>();

  const set = (next: UsageView) => {
    view = next;
    for (const listener of listeners) listener();
  };
  const hidden = () => doc?.visibilityState === "hidden";

  async function load(url: string): Promise<void> {
    try {
      const response = await doFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as LlmUsageResponse;
      // A slow poll can resolve after a newer refresh; never step back in time.
      if (view.status === "ready" && data.now < view.data.now) return;
      if (!data.enabled) {
        disabled = true;
        stop();
      }
      set({ status: "ready", data, error: null, clockOffsetMs: data.now - Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set(view.status === "ready" ? { ...view, error: message } : { status: "error", message });
    }
  }

  const tick = () => {
    if (!hidden()) void load("/api/llm-usage");
  };
  // Back to visible: poll now and restart the interval, so a stale tick doesn't follow at once.
  const onVisibility = () => {
    if (hidden() || timer === null) return;
    clearInterval(timer);
    timer = setInterval(tick, intervalMs);
    tick();
  };

  function start(): void {
    if (timer !== null || disabled) return;
    tick();
    timer = setInterval(tick, intervalMs);
    doc?.addEventListener("visibilitychange", onVisibility);
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    doc?.removeEventListener("visibilitychange", onVisibility);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => view,
    refresh: () => load("/api/llm-usage/refresh"),
    reload: () => load("/api/llm-usage"),
  };
}

export const usageStore = createUsageStore();

export function useLlmUsage(store: UsageStore = usageStore): UsageView {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
