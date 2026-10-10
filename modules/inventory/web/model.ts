import type { Host, ObservedHost, ObservedService, Service } from "@deck/schema";
import type { HostState, SnapshotProviderResult } from "@deck/contract";
import type { DeckConfig } from "@deck/server";
import type { SnapshotClientState } from "./use-inventory-data.js";

/** One row in the intent/reality hosts union. */
export interface HostRow {
  key: string;
  declared: Host | null;
  observed: ObservedHost | null;
  hostState: HostState | null;
  reality: "available" | "no-snapshot";
  declaredServiceCount: number;
  observedServiceCount: number;
}

/** Non-concatenated identity for a service row. */
export interface ServiceKey {
  host: string;
  name: string;
}

/** One row in the intent/reality services union. */
export interface ServiceRow {
  key: ServiceKey;
  declared: Service | null;
  observed: ObservedService | null;
  hostState: HostState | null;
  reality: "available" | "no-snapshot";
}

/** Immutable, response-scoped indexes shared by all four pages. */
export interface InventoryModel {
  hosts: readonly HostRow[];
  services: readonly ServiceRow[];
  hostByName: ReadonlyMap<string, HostRow>;
  serviceByHost: ReadonlyMap<string, ReadonlyMap<string, ServiceRow>>;
}

/**
 * Defensive host state used when an accepted available payload lacks a state for
 * a declared or observed host. The finding remains visible in the untouched result.
 */
const DEFENSIVE_UNREACHABLE_HOST_STATE: HostState = Object.freeze({
  state: "unreachable",
  collectedAt: null,
  ageMs: null,
  pastStaleThreshold: false,
});

/** Exact code-point comparator used for all default inventory ordering. */
export function compareOrdinal(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Encode a host name as its own route segment. */
export function hostHref(name: string): string {
  return `/hosts/${encodeURIComponent(name)}`;
}

/** Encode a service's host and name as two independent route segments. */
export function serviceHref(host: string, name: string): string {
  return `/services/${encodeURIComponent(host)}/${encodeURIComponent(name)}`;
}

/** Build immutable union rows and indexes from one committed response generation. */
export function buildInventoryModel(
  config: DeckConfig,
  snapshotState: SnapshotClientState,
): InventoryModel {
  const available = snapshotState.status === "available";
  const result: SnapshotProviderResult | null = available
    ? snapshotState.envelope.data
    : null;

  const declaredHosts = indexByKey(config.hosts ?? [], (host) => host.name);
  const declaredServices = indexNested(
    config.services ?? [],
    (service) => service.host,
    (service) => service.name,
  );

  const observedHosts = available
    ? indexByKey(result?.snapshot.hosts ?? [], (host) => host.name)
    : new Map<string, ObservedHost>();
  const observedServices = available
    ? indexNested(
        result?.snapshot.services ?? [],
        (service) => service.host,
        (service) => service.name,
      )
    : new Map<string, Map<string, ObservedService>>();

  const declaredCountByHost = countNested(declaredServices);
  const observedCountByHost = countNested(observedServices);

  // Resolve the host state for an available row, falling back defensively.
  const stateFor = (host: string): HostState | null =>
    available
      ? (result?.hostStates[host] ?? DEFENSIVE_UNREACHABLE_HOST_STATE)
      : null;

  // Host union: declared keys first, then observed-only keys.
  const hostKeys = unionKeys(declaredHosts, observedHosts);
  const hostByNameSource = new Map<string, HostRow>();
  for (const key of hostKeys) {
    hostByNameSource.set(
      key,
      Object.freeze({
        key,
        declared: declaredHosts.get(key) ?? null,
        observed: observedHosts.get(key) ?? null,
        hostState: stateFor(key),
        reality: available ? "available" : "no-snapshot",
        declaredServiceCount: declaredCountByHost.get(key) ?? 0,
        observedServiceCount: observedCountByHost.get(key) ?? 0,
      }),
    );
  }

  // Service union: declared (host,name) keys first, then observed-only identities.
  const serviceHostKeys = unionKeys(declaredServices, observedServices);
  const serviceByHostSource = new Map<string, ReadonlyMap<string, ServiceRow>>();
  const serviceRows: ServiceRow[] = [];
  for (const host of serviceHostKeys) {
    const declaredNames = declaredServices.get(host);
    const observedNames = observedServices.get(host);
    const names = unionKeys(
      declaredNames ?? new Map(),
      observedNames ?? new Map(),
    );
    const rowMap = new Map<string, ServiceRow>();
    for (const name of names) {
      const row: ServiceRow = Object.freeze({
        key: Object.freeze({ host, name }),
        declared: declaredNames?.get(name) ?? null,
        observed: observedNames?.get(name) ?? null,
        hostState: stateFor(host),
        reality: available ? "available" : "no-snapshot",
      });
      rowMap.set(name, row);
      serviceRows.push(row);
    }
    serviceByHostSource.set(host, freezeReadonlyMap(rowMap));
  }

  const hosts = [...hostByNameSource.values()].sort((a, b) =>
    compareOrdinal(a.key, b.key),
  );
  const services = serviceRows.sort(
    (a, b) =>
      compareOrdinal(a.key.host, b.key.host) ||
      compareOrdinal(a.key.name, b.key.name),
  );

  Object.freeze(hosts);
  Object.freeze(services);

  return Object.freeze({
    hosts,
    services,
    hostByName: freezeReadonlyMap(hostByNameSource),
    serviceByHost: freezeReadonlyMap(serviceByHostSource),
  });
}

/** Look up a host without exposing a mutable index. */
export function findHost(
  model: InventoryModel,
  name: string,
): HostRow | undefined {
  return model.hostByName.get(name);
}

/** Look up a service by its two independent identity segments. */
export function findService(
  model: InventoryModel,
  host: string,
  name: string,
): ServiceRow | undefined {
  return model.serviceByHost.get(host)?.get(name);
}

/**
 * Wrap a construction-private `Map` in a frozen `ReadonlyMap` facade. Unlike
 * `Object.freeze(new Map())`, the facade exposes no `set`/`delete`/`clear`, and
 * its `forEach` hands the facade (never the backing map) to the callback, so a
 * component cannot reach through and mutate the normalized index.
 */
function freezeReadonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const facade: ReadonlyMap<K, V> = {
    get size(): number {
      return source.size;
    },
    has(key: K): boolean {
      return source.has(key);
    },
    get(key: K): V | undefined {
      return source.get(key);
    },
    entries(): MapIterator<[K, V]> {
      return source.entries();
    },
    keys(): MapIterator<K> {
      return source.keys();
    },
    values(): MapIterator<V> {
      return source.values();
    },
    forEach(
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ): void {
      source.forEach((value, key) => {
        callback.call(thisArg, value, key, facade);
      });
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(facade);
}

function indexByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, item);
  }
  return map;
}

function indexNested<T>(
  items: readonly T[],
  hostOf: (item: T) => string,
  nameOf: (item: T) => string,
): Map<string, Map<string, T>> {
  const map = new Map<string, Map<string, T>>();
  for (const item of items) {
    const host = hostOf(item);
    const name = nameOf(item);
    const inner = map.get(host) ?? new Map<string, T>();
    if (!inner.has(name)) inner.set(name, item);
    map.set(host, inner);
  }
  return map;
}

function countNested<T>(nested: Map<string, Map<string, T>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [host, inner] of nested) counts.set(host, inner.size);
  return counts;
}

function unionKeys(
  first: Map<string, unknown>,
  second: Map<string, unknown>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of first.keys()) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  for (const key of second.keys()) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
