import type { Layer } from "./types.js";

/** The authored layer responsible for a config key, or its structural role. */
export type Owner = Layer | "both" | "container";

/** Identity fields for arrays whose elements merge by identity rather than position. */
export const IDENTITY = {
  hosts: ["name"],
  services: ["host", "name"],
  groups: ["id"],
  "groups[].items": { service: ["host", "name"], link: ["href"], group: ["id"] },
  "groups[].items[].items": { service: ["host", "name"], link: ["href"] },
  "hosts[].links": ["href"],
  "services[].links": ["href"],
  sources: ["id"],
  integrations: ["id"],
  actions: ["id"],
  "actions[].params": ["name"],
  agents: ["id"],
} as const;

/** Per-key ownership. Deeper keys inherit their nearest listed ancestor. */
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

  groups: "overlay", sources: "overlay", integrations: "overlay", llmUsage: "overlay",
  actions: "overlay", agents: "overlay",
} as const satisfies Record<string, Owner>;

/** A key path with an explicit ownership row. */
export type KeyPath = keyof typeof OWNERSHIP;

/** Resolve an exact ownership row or the single nearest-ancestor row. */
export function resolveOwner(path: KeyPath | string): Owner {
  let candidate: string = path;
  while (candidate.length > 0) {
    if (Object.prototype.hasOwnProperty.call(OWNERSHIP, candidate)) {
      return OWNERSHIP[candidate as KeyPath];
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
