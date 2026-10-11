import type { ProviderStatusDecl, UiStatusKind } from "@deck/module-sdk";

/**
 * How the built-in status-capable data sources give a bound card its status: each module's
 * `providerKinds[].status`, shared with the web as the fallback for when the UI manifest
 * (which lists every enabled kind's, `statusKinds`) cannot be read. Data only (no runtime
 * imports), so the browser bundle can load it.
 */

/** A `docker` binding (`{ container }`) reads the container of that name; up while running and healthy (or without a health check). */
export const DOCKER_STATUS: ProviderStatusDecl = {
  provider: "fixed",
  match: { list: "containers", key: "name", binding: "container" },
  up: [
    { field: "state", in: ["running"] },
    { field: "health", in: ["healthy", "none"] },
  ],
};

/** A `gatus` binding (`{ endpoint }`) reads the endpoint with that key; up when gatus says so. */
export const GATUS_STATUS: ProviderStatusDecl = {
  provider: "fixed",
  match: { list: "endpoints", key: "key", binding: "endpoint" },
  up: [{ field: "up", in: [true] }],
};

/** An `http-health` binding is its own provider, probing its URL; up on a 2xx or 3xx answer. */
export const HTTP_HEALTH_STATUS: ProviderStatusDecl = {
  provider: "binding",
  up: [{ field: "up", in: [true] }],
};

/** The built-in status kinds as the UI manifest lists them, by kind. */
export const BUILTIN_STATUS_KINDS: readonly UiStatusKind[] = [
  { kind: "docker", module: "docker", fixedId: "docker", status: DOCKER_STATUS },
  { kind: "gatus", module: "gatus", fixedId: "gatus", status: GATUS_STATUS },
  { kind: "http-health", module: "http-health", status: HTTP_HEALTH_STATUS },
];
