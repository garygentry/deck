import { notifyManager, QueryClient } from "@tanstack/react-query";

// Deliver cache updates to components on a microtask rather than the default zero-delay
// timeout, as a settled fetch did before the cache existed: a paused or mocked clock (a
// test, a frozen-time visual capture) must not hold back a render.
notifyManager.setScheduler(queueMicrotask);

/**
 * The query client every data hook and store shares, so one request serves every reader of
 * the same resource. Defaults keep the timing deck had before a cache existed: a failed
 * request is not retried (the next poll or a Retry action asks again), and returning to the
 * tab does not refetch on its own.
 */
export function createDeckQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Keep an unobserved result for the page session: the config, the UI manifest and
        // the last provider envelope are cheap to hold and costly to refetch on every mount.
        gcTime: Infinity,
      },
    },
  });
}

let client = createDeckQueryClient();

export function getQueryClient(): QueryClient {
  return client;
}

/** Test seam: drop every cached query (and the client holding them). */
export function resetQueryClient(): void {
  client.clear();
  client = createDeckQueryClient();
}
