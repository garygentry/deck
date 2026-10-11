import { POLL_DEFAULTS } from "@deck/contract";
import type { LlmUsageResponse } from "../server/types.js";
import { focusManager, QueryObserver, type Query, type QueryClient, type QueryState } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getQueryClient } from "@/data/query-client.js";

/**
 * `GET /api/llm-usage` on the shared query client, read by the page, the header pill and the
 * portal card, so they never double-poll. Every read counts as viewer presence on the server,
 * which keeps its upstream polling awake, so it polls only while something reads it and the
 * tab is visible (back to visible: one poll at once, and the interval restarts after it). Once
 * the server says the feature is off it stops for good: the `modules.llm-usage` section is
 * read once at boot.
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
  /** The query client; the shared one (resolved per subscription) by default. */
  client?: QueryClient;
  fetch?: typeof fetch;
  intervalMs?: number;
}

export const LLM_USAGE_URL = "/api/llm-usage";
export const LLM_USAGE_REFRESH_URL = "/api/llm-usage/refresh";
export const llmUsageKey = ["module", "llm-usage"] as const;

/** One response, with the clock offset measured when it arrived. */
interface UsageReading {
  data: LlmUsageResponse;
  clockOffsetMs: number;
}

type UsageQuery = Query<UsageReading, Error, UsageReading, typeof llmUsageKey>;

const LOADING: UsageView = { status: "loading" };

/** The view of the query's state: the last good reading, with the latest failure if newer. */
function toView(state: QueryState<UsageReading, Error> | undefined): UsageView {
  if (state?.data === undefined) {
    return state?.status === "error" && state.error !== null ? { status: "error", message: state.error.message } : LOADING;
  }
  const error = state.status === "error" && state.error !== null ? state.error.message : null;
  return { status: "ready", data: state.data.data, error, clockOffsetMs: state.data.clockOffsetMs };
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const intervalMs = options.intervalMs ?? POLL_DEFAULTS.pollIntervalMs;
  const client = () => options.client ?? getQueryClient();

  async function read(url: string, signal?: AbortSignal): Promise<UsageReading> {
    const response = await doFetch(url, signal === undefined ? {} : { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as LlmUsageResponse;
    // A slow poll can resolve after a newer refresh; never step back in time.
    const current = client().getQueryData<UsageReading>(llmUsageKey);
    if (current !== undefined && data.now < current.data.now) return current;
    return { data, clockOffsetMs: data.now - Date.now() };
  }

  // One query function serves every read of the key, so the query's cached function is always
  // this one (a refetch from anywhere reads `/api/llm-usage`). A refresh asks it, once, for the
  // refresh route instead.
  let refreshNext = false;
  const queryFn = ({ signal }: { signal?: AbortSignal }) => {
    const url = refreshNext ? LLM_USAGE_REFRESH_URL : LLM_USAGE_URL;
    refreshNext = false;
    return read(url, signal);
  };

  const off = (query: UsageQuery) => query.state.data?.data.enabled === false;
  const observerOptions = {
    queryKey: llmUsageKey,
    queryFn,
    // Hidden or switched off: no mount read, no interval tick, nothing to refetch on return.
    enabled: (query: UsageQuery) => !off(query) && focusManager.isFocused(),
    refetchInterval: intervalMs,
    // A reader that joins within an interval of the last read reuses it.
    staleTime: intervalMs,
  };

  // The view is recomputed only when the query's state changes, so React sees a stable snapshot.
  let seen: QueryState<UsageReading, Error> | undefined;
  let view: UsageView = LOADING;
  const getSnapshot = () => {
    const state = client().getQueryState<UsageReading, Error>(llmUsageKey);
    if (state !== seen) {
      seen = state;
      view = toView(state);
    }
    return view;
  };

  const listeners = new Set<() => void>();
  let stopObserving: (() => void) | null = null;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** Read now, through the query so a failure lands in its state; never throws. */
  async function fetchNow(refresh: boolean): Promise<void> {
    // A refresh is newer than a poll in flight, so it must not join it.
    if (refresh) {
      await client().cancelQueries({ queryKey: llmUsageKey });
      refreshNext = true;
    }
    await client()
      .fetchQuery({ queryKey: llmUsageKey, queryFn, staleTime: 0 })
      .catch(() => undefined)
      .finally(() => {
        refreshNext = false;
      });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const observer = new QueryObserver<UsageReading, Error, UsageReading, UsageReading, typeof llmUsageKey>(client(), observerOptions);
        const stopNotifying = observer.subscribe(notify);
        // Back to visible: poll now. The shared client is not mounted, so focus never reaches
        // its cache; the read restarts the observer's interval, so a stale tick doesn't follow.
        const stopWatching = focusManager.subscribe((focused) => {
          if (focused && !off(observer.getCurrentQuery())) void observer.refetch({ cancelRefetch: false });
        });
        stopObserving = () => {
          stopWatching();
          stopNotifying();
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopObserving?.();
          stopObserving = null;
        }
      };
    },
    getSnapshot,
    refresh: () => fetchNow(true),
    reload: () => fetchNow(false),
  };
}

export const usageStore = createUsageStore();

export function useLlmUsage(store: UsageStore = usageStore): UsageView {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
