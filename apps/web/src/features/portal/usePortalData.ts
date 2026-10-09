import { POLL_DEFAULTS } from "@deck/contract";
import { BUILTIN_STATUS_KINDS } from "@deck/contract/modules/data-sources";
import type { UiStatusKind } from "@deck/module-sdk";
import type { DeckConfig } from "@deck/server";
import type { PortalModuleConfig } from "@deck/server/portal";
import { useMemo } from "react";
import { useConfig, useProviders, useUiManifest, type UiManifestState } from "../../data/index.js";
import { resolveServiceBinding, type PortalData } from "./card-status.js";

const INITIAL_PORTAL_DATA: PortalData = {
  config: null,
  statusKinds: [],
  envelopes: new Map(),
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

/**
 * The providers the portal's cards read, sorted: one per status binding of a service a group
 * item names. Only those are polled, so an estate's other bindings cost the browser nothing.
 */
export function cardProviderIds(config: DeckConfig | null, kinds: readonly UiStatusKind[]): string[] {
  if (config === null || kinds.length === 0) return [];
  const services = new Map((config.services ?? []).map((service) => [`${service.host}/${service.name}`, service]));
  const ids = new Set<string>();
  const visit = (item: { type: string; host?: string; name?: string; items?: unknown[] }): void => {
    if (item.type === "group") (item.items ?? []).forEach((child) => visit(child as typeof item));
    if (item.type !== "service") return;
    const service = services.get(`${item.host}/${item.name}`);
    const binding = service === undefined ? null : resolveServiceBinding(service, kinds);
    if (binding !== null) ids.add(binding.providerId);
  };
  for (const group of (config.modules?.portal as PortalModuleConfig | undefined)?.groups ?? []) {
    for (const item of group.items) visit(item);
  }
  return [...ids].sort();
}

/**
 * The config, the status kinds and the envelopes of the providers the portal's cards read.
 * Every request is shared: two portal widgets read the same ones, and the config is read once
 * per page load. A provider the estate never registered is not polled; its `null` renders the
 * same "unreachable" card.
 */
export function usePortalData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): PortalData {
  const config = useConfig();
  const manifest = useUiManifest();
  // The manifest state is a new object each render; its document keeps its identity.
  const manifestKey = manifest.status === "ready" ? manifest.manifest : manifest.status;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statusKinds = useMemo(() => statusKindsOf(manifest), [manifestKey]);
  const loadedConfig = config.status === "ready" ? config.config : null;
  const ids = useMemo(() => cardProviderIds(loadedConfig, statusKinds), [loadedConfig, statusKinds]);
  const providers = useProviders(ids, { intervalMs });
  const loading = config.status === "loading" || providers.loading;
  // One object per change, so readers re-render only when the data does.
  return useMemo(
    () =>
      loading
        ? INITIAL_PORTAL_DATA
        : { config: loadedConfig, statusKinds, envelopes: providers.envelopes, loading: false },
    [loading, loadedConfig, statusKinds, providers.envelopes],
  );
}
