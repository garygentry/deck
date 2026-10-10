import { POLL_DEFAULTS } from "@deck/contract";
import { BUILTIN_STATUS_KINDS } from "@deck/contract/modules/data-sources";
import type { UiStatusKind } from "@deck/module-sdk";
import type { Host } from "@deck/schema";
import type { DeckConfig } from "@deck/server";
import type { Group, PortalModuleConfig } from "../server/types.js";
import { useMemo, useRef } from "react";
import { useConfig, useProviders, useUiManifest, type UiManifestState } from "@/data/index.js";
import { resolveServiceBinding, type PortalData } from "./card-status.js";

const INITIAL_PORTAL_DATA: PortalData = {
  config: null,
  statusKinds: [],
  registered: null,
  envelopes: new Map(),
  pending: new Set(),
  loading: true,
};

/**
 * The status kinds a ready UI manifest lists (none when it lists none). When it cannot be read,
 * the built-in data sources', so cards keep their status; while it loads, none yet.
 */
export function statusKindsOf(manifest: UiManifestState): readonly UiStatusKind[] {
  if (manifest.status === "error") return BUILTIN_STATUS_KINDS;
  if (manifest.status === "loading") return [];
  const listed: unknown = manifest.manifest.statusKinds;
  if (!Array.isArray(listed)) return [];
  // A malformed entry is skipped rather than trusted.
  return listed.filter(
    (entry): entry is UiStatusKind =>
      typeof entry?.kind === "string" && typeof entry.status === "object" && entry.status !== null && Array.isArray(entry.status.up),
  );
}

/** The provider ids a ready manifest registers; `null` when it cannot be read (every one may exist). */
export function registeredProvidersOf(manifest: UiManifestState): ReadonlySet<string> | null {
  if (manifest.status !== "ready" || !Array.isArray(manifest.manifest.providers)) return null;
  return new Set(manifest.manifest.providers.flatMap((provider) => (typeof provider?.id === "string" ? [provider.id] : [])));
}

/**
 * The providers a portal widget's cards read, sorted: one per status binding of a visible
 * service that an item of a shown group names (every group when `groups` is absent). Hidden
 * services and services on hidden hosts are never polled, nor is any provider of a group the
 * widget does not show.
 */
export function cardProviderIds(
  config: DeckConfig | null,
  kinds: readonly UiStatusKind[],
  registered: ReadonlySet<string> | null,
  groups?: readonly string[],
): string[] {
  if (config === null || kinds.length === 0) return [];
  const hiddenHosts = new Set(((config.hosts ?? []) as Host[]).filter((host) => host.hidden === true).map((host) => host.name));
  const services = new Map(
    (config.services ?? [])
      .filter((service) => service.hidden !== true && !hiddenHosts.has(service.host))
      .map((service) => [`${service.host}/${service.name}`, service]),
  );
  const ids = new Set<string>();
  const visit = (item: { type: string; host?: string; name?: string; items?: unknown[] }): void => {
    if (item.type === "group") (item.items ?? []).forEach((child) => visit(child as typeof item));
    if (item.type !== "service") return;
    const service = services.get(`${item.host}/${item.name}`);
    const binding = service === undefined ? null : resolveServiceBinding(service, kinds, registered);
    if (binding !== null) ids.add(binding.providerId);
  };
  const all: readonly Group[] = (config.modules?.portal as PortalModuleConfig | undefined)?.groups ?? [];
  const shown = groups === undefined ? all : all.filter((group) => groups.includes(group.id));
  for (const group of shown) {
    for (const item of group.items) visit(item);
  }
  return [...ids].sort();
}

/**
 * The config, the status kinds and the envelopes of the providers a portal widget's cards read
 * (those of its `groups`, default all). Every request is shared: two portal widgets read the same
 * ones, and the config is read once per page load. A provider the estate never registered is not
 * polled. Loading lasts only until the config and the UI manifest first settle: a provider
 * still being read leaves only its own cards pending, and providers asked for later (the ids
 * changed) never bring the loading state back.
 */
export function usePortalData(
  groups?: readonly string[],
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): PortalData {
  const config = useConfig();
  const manifest = useUiManifest();
  // The manifest state is a new object each render; its document keeps its identity.
  const manifestKey = manifest.status === "ready" ? manifest.manifest : manifest.status;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statusKinds = useMemo(() => statusKindsOf(manifest), [manifestKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const registered = useMemo(() => registeredProvidersOf(manifest), [manifestKey]);
  const loadedConfig = config.status === "ready" ? config.config : null;
  const ids = useMemo(
    () => cardProviderIds(loadedConfig, statusKinds, registered, groups),
    [loadedConfig, statusKinds, registered, groups],
  );
  const providers = useProviders(ids, { intervalMs });
  const settled = useRef(false);
  if (config.status !== "loading" && manifest.status !== "loading") settled.current = true;
  const loading = !settled.current;
  // One object per change, so readers re-render only when the data does.
  return useMemo(
    () =>
      loading
        ? INITIAL_PORTAL_DATA
        : { config: loadedConfig, statusKinds, registered, envelopes: providers.envelopes, pending: providers.pending, loading: false },
    [loading, loadedConfig, statusKinds, registered, providers.envelopes, providers.pending],
  );
}
