import type { ProviderStatusDecl } from "@deck/module-sdk";

/**
 * How a `docker` binding gives a bound card its status: the module's `providerKinds[].status`,
 * which the portal's web half also reads as its fallback for when the UI manifest cannot be
 * read. Data only (no runtime imports), so the browser bundle can load it.
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
