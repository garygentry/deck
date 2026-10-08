import type { Layer } from "./types.js";

/** The authored layer responsible for a config key, or its structural role. */
export type Owner = Layer | "both" | "container";

/**
 * How an array's elements are identified: fixed fields, or per-`type` fields for an array
 * of discriminated items.
 */
export type IdentitySpec = readonly string[] | Readonly<Record<string, readonly string[]>>;

/**
 * Kernel identity fields for arrays whose elements merge by identity rather than position.
 * Modules add rows for arrays in their own section; see `composeConfig`.
 */
export const IDENTITY = {
  hosts: ["name"],
  services: ["host", "name"],
  "hosts[].links": ["href"],
  "services[].links": ["href"],
  sources: ["id"],
  integrations: ["id"],
  "ui.nav.groups": ["id"],
  "ui.nav.items": ["id"],
} as const satisfies Record<string, IdentitySpec>;

/**
 * Kernel per-key ownership. Deeper keys inherit their nearest listed ancestor. Modules add
 * rows under `modules.<id>`; see `composeConfig`.
 */
export const OWNERSHIP = {
  schemaVersion: "both",

  estate: "container", hosts: "container", services: "container",

  "estate.name": "base", "estate.domains": "base", "estate.timezone": "base",
  "estate.freshness": "overlay",

  "hosts[].name": "base", "hosts[].kind": "base", "hosts[].purpose": "base",
  "hosts[].hypervisor": "base", "hosts[].vmid": "base", "hosts[].addresses": "base",
  "hosts[].access": "base", "hosts[].backup": "base", "hosts[].managedConfigs": "base",
  "hosts[].stacksRoot": "base", "hosts[].secrets": "base",
  "hosts[].links": "overlay", "hosts[].bindings": "overlay", "hosts[].hidden": "overlay",

  "services[].name": "base", "services[].host": "base", "services[].kind": "base",
  "services[].purpose": "base", "services[].status": "base", "services[].stack": "base",
  "services[].secrets": "base", "services[].backup": "base",
  "services[].links": "overlay", "services[].bindings": "overlay",
  "services[].hidden": "overlay",

  sources: "overlay", integrations: "overlay", ui: "overlay", modules: "container",
} as const satisfies Record<string, Owner>;

/** A key path with an explicit ownership row. */
export type KeyPath = keyof typeof OWNERSHIP;

/** Resolve an exact ownership row or the single nearest-ancestor row. */
export function resolveOwner(
  path: KeyPath | string,
  table: Readonly<Record<string, Owner>> = OWNERSHIP,
): Owner {
  let candidate: string = path;
  while (candidate.length > 0) {
    if (Object.prototype.hasOwnProperty.call(table, candidate)) {
      return table[candidate]!;
    }
    candidate = parentPath(candidate);
  }
  throw new Error(`resolveOwner: no ownership row for path "${path}"`);
}

function parentPath(path: string): string {
  if (path.endsWith("[]")) return path.slice(0, -2);
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}
