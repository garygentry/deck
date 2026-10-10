import type { DeckConfigDocument } from "./types.js";

/** One host or service binding, with the provider id the kernel registers it under. */
export interface EstateBinding {
  /** The binding's provider kind (its key under `bindings`). */
  kind: string;
  /** `host:<name>` or `service:<host>:<name>`. */
  owner: string;
  /** The binding's own `id`, else `<kind>:<owner>`. */
  id: string;
  /** The binding value. */
  value: Readonly<Record<string, unknown>>;
  /** JSON pointer to the binding. */
  path: string;
}

/** One id in the estate's provider-id space, and where it is declared. */
export interface EstateProviderId {
  id: string;
  /** JSON pointer to the declaration. */
  path: string;
  collection: "integrations" | "sources" | "bindings";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A host binding's owner: `host:<name>`. */
export function hostOwner(name: string): string {
  return `host:${name}`;
}

/** A service binding's owner: `service:<host>:<name>`. */
export function serviceOwner(host: string, name: string): string {
  return `service:${host}:${name}`;
}

/**
 * The provider id a binding is registered under: its own string `id`, else `<kind>:<owner>`.
 * The one rule boot, config validation and the web's card status all use.
 */
export function bindingProviderId(kind: string, owner: string, value: Readonly<Record<string, unknown>>): string {
  return typeof value.id === "string" ? value.id : `${kind}:${owner}`;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Every host binding, then every service binding, in document order, with the provider id it
 * is registered under: the binding's own string `id`, else `<kind>:<owner>`. A binding value
 * that is not an object is skipped (it declares no provider). Boot registers bindings from
 * this list, and config validation checks ids with it, so the two cannot disagree.
 */
export function estateBindings(doc: Pick<DeckConfigDocument, "hosts" | "services">): EstateBinding[] {
  const bindings: EstateBinding[] = [];
  const collect = (raw: Record<string, unknown> | undefined, owner: string, pointer: string): void => {
    for (const [kind, value] of Object.entries(raw ?? {})) {
      if (!isObject(value)) continue;
      const id = bindingProviderId(kind, owner, value);
      bindings.push({ kind, owner, id, value, path: `${pointer}/bindings/${escapePointerSegment(kind)}` });
    }
  };
  for (const [index, host] of (doc.hosts ?? []).entries()) {
    collect(host.bindings, hostOwner(host.name), `/hosts/${index}`);
  }
  for (const [index, service] of (doc.services ?? []).entries()) {
    collect(service.bindings, serviceOwner(service.host, service.name), `/services/${index}`);
  }
  return bindings;
}

/**
 * The estate's provider ids: every `integrations[]` and `sources[]` id, then every binding's
 * ({@link estateBindings}). A provider that keeps one of these ids is an estate provider, and
 * two estate providers may not share an id, whatever their kinds.
 */
export function estateProviderIds(
  doc: Pick<DeckConfigDocument, "hosts" | "services" | "integrations" | "sources">,
): EstateProviderId[] {
  const ids: EstateProviderId[] = [];
  for (const collection of ["integrations", "sources"] as const) {
    for (const [index, item] of (doc[collection] ?? []).entries()) {
      if (isObject(item) && typeof item.id === "string") ids.push({ id: item.id, path: `/${collection}/${index}`, collection });
    }
  }
  for (const binding of estateBindings(doc)) ids.push({ id: binding.id, path: binding.path, collection: "bindings" });
  return ids;
}
