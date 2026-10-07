import type { ProvidersResponse } from "@deck/server";

/**
 * The registered-provider discovery list (`GET /api/providers`). The provider
 * set is fixed at server boot, so this is cached for the page session: the first
 * caller fetches it, later callers reuse the result. Feature hooks consult it
 * before polling a provider so the web never requests `/api/providers/<id>` for a
 * provider the estate did not declare — which is what produced the console 404s.
 *
 * A failed read is NOT cached and yields `null`, which callers treat as "index
 * unavailable, poll anyway": a transient discovery failure degrades to the old
 * ungated behavior rather than wrongly hiding a configured provider.
 */

let cache: ReadonlySet<string> | null = null;
let inflight: Promise<ReadonlySet<string> | null> | null = null;

async function loadIndex(): Promise<ReadonlySet<string> | null> {
  try {
    const response = await fetch("/api/providers");
    if (!response.ok) return null;
    const body = (await response.json()) as ProvidersResponse;
    cache = new Set(body.providers.map((descriptor) => descriptor.id));
    return cache;
  } catch (error) {
    // Discovery failure → null → callers fall back to polling anyway; leave a
    // breadcrumb so the failure is diagnosable rather than silent.
    console.warn("[deck] provider discovery failed; falling back to polling", error);
    return null;
  } finally {
    inflight = null;
  }
}

/**
 * The set of registered provider ids, or `null` when the index cannot be read.
 * The successful result is memoized for the page session.
 */
export function getRegisteredProviderIds(): Promise<ReadonlySet<string> | null> {
  if (cache) return Promise.resolve(cache);
  inflight ??= loadIndex();
  return inflight;
}

/**
 * Whether the web should poll `/api/providers/<id>`. True when the provider is
 * registered, or when the index is unavailable (fall back to polling). False
 * only when the index loaded and does not list the provider.
 */
export async function isProviderPollable(id: string): Promise<boolean> {
  const ids = await getRegisteredProviderIds();
  return ids === null || ids.has(id);
}

/** Test seam: drop the memoized index between cases. */
export function resetProvidersIndexCache(): void {
  cache = null;
  inflight = null;
}
