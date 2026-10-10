import { POLL_DEFAULTS } from "@deck/contract";
import type { ProviderEnvelope } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { UiManifest } from "@deck/module-sdk";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import { getQueryClient } from "./query-client.js";
import { configQuery, isUiManifestUnavailable, providerQuery, queryKeys, uiManifestQuery } from "./queries.js";

export type ConfigState =
  | { status: "loading" }
  | { status: "ready"; config: DeckConfig }
  | { status: "error"; message: string };

/**
 * The estate config. Every caller shares one `/api/config` request per page load. A failed
 * read is not cached: it is asked again every poll interval until it succeeds (as the
 * per-feature pollers did), and on the next mount (a Retry that remounts its loader).
 */
export function useConfig(): ConfigState {
  const query = useQuery(
    {
      ...configQuery,
      refetchInterval: (q) => (q.state.status === "error" ? POLL_DEFAULTS.pollIntervalMs : false),
      refetchIntervalInBackground: true,
    },
    getQueryClient(),
  );
  // A failed read that is being asked again stays an error (TanStack reports a query with no
  // data as pending while it refetches), so readers do not flicker back to loading each tick.
  const lastError = useRef<string | null>(null);
  if (query.status === "success") {
    lastError.current = null;
    return { status: "ready", config: query.data };
  }
  if (query.status === "error") {
    lastError.current = query.error.message;
    return { status: "error", message: query.error.message };
  }
  if (lastError.current !== null && query.errorUpdatedAt > 0) return { status: "error", message: lastError.current };
  return { status: "loading" };
}

export type UiManifestState =
  | { status: "loading" }
  | { status: "ready"; manifest: UiManifest }
  | { status: "error"; message: string };

/** How often a page re-reads the UI manifest, which the server swaps when the `ui` config changes. */
export const UI_MANIFEST_REFRESH_MS = 60_000;

let refreshOnFocusInstalled = false;

/**
 * Re-read the UI manifest when the window regains focus or the page becomes visible again,
 * once per page: only the manifest (other queries keep the client's focus defaults), and one
 * read when both events fire together.
 */
function refreshManifestOnFocus(): void {
  if (refreshOnFocusInstalled || typeof window === "undefined") return;
  refreshOnFocusInstalled = true;
  const refresh = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void getQueryClient().refetchQueries({ queryKey: queryKeys.uiManifest, type: "active" }, { cancelRefetch: false });
  };
  window.addEventListener("focus", refresh);
  window.addEventListener("visibilitychange", refresh);
}

/**
 * The resolved UI manifest (`/api/ui`), shared by every reader: one read per page load, then
 * again when the window regains focus (or the page becomes visible) and every
 * {@link UI_MANIFEST_REFRESH_MS}, so a `ui` config change shows without a reload (an unchanged
 * manifest keeps its references). Once read, a failed re-read keeps it. When it cannot be read
 * at all the state is `error` (a settled answer), asked again every poll interval until it
 * succeeds; it never goes back to `loading` while it is asked again.
 */
export function useUiManifest(): UiManifestState {
  refreshManifestOnFocus();
  const query = useQuery(
    {
      ...uiManifestQuery,
      // While it is unavailable, ask again each poll interval so readers heal within a tick.
      refetchInterval: (q) => (isUiManifestUnavailable(q.state.data) ? POLL_DEFAULTS.pollIntervalMs : UI_MANIFEST_REFRESH_MS),
      refetchIntervalInBackground: true,
    },
    getQueryClient(),
  );
  if (query.status === "success") {
    return isUiManifestUnavailable(query.data)
      ? { status: "error", message: query.data.message }
      : { status: "ready", manifest: query.data };
  }
  if (query.status === "error") return { status: "error", message: query.error.message };
  return { status: "loading" };
}

/** A provider by id, or the provider of a kind (the first by id when several share it). */
export type ProviderRef = string | { kind: string };

export interface ProviderState<T> {
  /** The latest envelope, or `null` when the provider is not configured or unreadable. */
  envelope: ProviderEnvelope<T> | null;
  /** True until the first read settles (or it is known not to be configured). */
  loading: boolean;
}

/**
 * Whether the web should poll a provider, given the manifest: listed providers are polled,
 * unlisted ones are not (no console 404s). Without a manifest (it failed to load) every
 * provider is polled, so a transient failure never hides a configured one. `undefined`
 * while the manifest is still loading.
 */
export function resolveProvider(ref: ProviderRef, manifest: UiManifestState): { id: string | null } | undefined {
  if (manifest.status === "loading") return undefined;
  const providers = manifest.status === "ready" ? listedProviders(manifest.manifest) : null;
  if (typeof ref === "string") {
    return { id: providers === null || providers.some((p) => p.id === ref) ? ref : null };
  }
  if (providers === null) return { id: ref.kind };
  const match = providers.filter((p) => p.kind === ref.kind).map((p) => p.id).sort()[0];
  return { id: match ?? null };
}

/**
 * Poll one provider's envelope every `intervalMs` (the shell default). Every caller of the
 * same provider shares one request per tick, wherever it is mounted; a caller that joins
 * within an interval of the last read reuses it. Without a manifest every provider is polled
 * (the manifest query leaves the warning).
 */
export function useProvider<T>(
  ref: ProviderRef,
  options: { intervalMs?: number } = {},
): ProviderState<T> {
  const resolved = resolveProvider(ref, useUiManifest());
  const id = resolved?.id ?? null;
  const query = useQuery(
    {
      ...providerQuery<T>(id ?? "", options.intervalMs ?? POLL_DEFAULTS.pollIntervalMs),
      enabled: id !== null,
      refetchInterval: options.intervalMs ?? POLL_DEFAULTS.pollIntervalMs,
      // Keep polling in a background tab, as the interval pollers did.
      refetchIntervalInBackground: true,
    },
    getQueryClient(),
  );
  if (resolved === undefined) return { envelope: null, loading: true };
  if (id === null) return { envelope: null, loading: false };
  return { envelope: query.data ?? null, loading: query.status === "pending" };
}

export interface ProvidersState<T> {
  /** Each asked provider's latest envelope, by id; `null` when it is not configured or unreadable. */
  envelopes: ReadonlyMap<string, ProviderEnvelope<T> | null>;
  /** True until every read settles (or each is known not to be configured). */
  loading: boolean;
  /** The asked providers whose first read has not settled yet (all of them while the manifest loads). */
  pending: ReadonlySet<string>;
}

/**
 * Poll several providers by id, as {@link useProvider} polls one: the same shared query per
 * provider, so a page and a pill reading one provider make one request per tick. Unlisted
 * providers are not polled. The ids may change between renders.
 */
export function useProviders<T>(ids: readonly string[], options: { intervalMs?: number } = {}): ProvidersState<T> {
  const manifest = useUiManifest();
  const intervalMs = options.intervalMs ?? POLL_DEFAULTS.pollIntervalMs;
  const resolved = ids.map((id) => resolveProvider(id, manifest)?.id ?? null);
  const results = useQueries(
    {
      queries: resolved.map((id) => ({
        ...providerQuery<T>(id ?? "", intervalMs),
        enabled: id !== null,
        refetchInterval: intervalMs,
        refetchIntervalInBackground: true,
      })),
    },
    getQueryClient(),
  );
  const pending = manifest.status === "loading";
  const envelopes = new Map<string, ProviderEnvelope<T> | null>();
  const waiting = new Set<string>();
  ids.forEach((id, index) => {
    const result = results[index]!;
    const listed = resolved[index] !== null;
    envelopes.set(id, pending || !listed ? null : (result.data ?? null));
    if (pending || (listed && result.status === "pending")) waiting.add(id);
  });
  const loading = waiting.size > 0;
  // The same answer as last render keeps its identity, so readers can memoise on it.
  const last = useRef<ProvidersState<T> | null>(null);
  if (
    last.current === null ||
    !sameEnvelopes(last.current.envelopes, envelopes) ||
    !sameMembers(last.current.pending, waiting)
  ) {
    last.current = { envelopes, loading, pending: waiting };
  }
  return last.current;
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function sameEnvelopes<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, value] of a) if (!b.has(id) || b.get(id) !== value) return false;
  return true;
}

/**
 * Whether `/api/providers/<id>` should be polled, for code outside React (stores). True when
 * the manifest lists the provider or cannot be read; false only when it loaded without it.
 */
export async function isProviderPollable(id: string): Promise<boolean> {
  let answer;
  try {
    answer = await getQueryClient().fetchQuery(uiManifestQuery);
  } catch {
    // Only an abort reaches here (the query settles failures as "unavailable"): poll anyway.
    return true;
  }
  const providers = isUiManifestUnavailable(answer) ? null : listedProviders(answer);
  return providers === null || providers.some((provider) => provider.id === id);
}

/** The manifest's provider list, or `null` when the document has none (not a manifest). */
function listedProviders(manifest: UiManifest): UiManifest["providers"] | null {
  return Array.isArray(manifest?.providers) ? manifest.providers : null;
}
