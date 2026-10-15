import type { UiStatusKind } from "@deck/module-sdk";

/**
 * How a `docker` binding gives a bound card its status, as the UI manifest lists it
 * (`statusKinds`): the kind, its module, its fixed provider id and its status declaration. The
 * server manifest's `providerKinds` entry is built from it, and the portal's
 * `BUILTIN_STATUS_KINDS` (its fallback for when the UI manifest cannot be read) lists it, so the
 * two cannot drift. Data only (no runtime imports), so the browser bundle can load it.
 *
 * A `docker` binding (`{ container }`) reads the container of that name in the fixed `docker`
 * provider; up while running and healthy (or without a health check).
 */
export const DOCKER_STATUS_KIND: UiStatusKind = {
  kind: "docker",
  module: "docker",
  fixedId: "docker",
  status: {
    provider: "fixed",
    match: { list: "containers", key: "name", binding: "container" },
    up: [
      { field: "state", in: ["running"] },
      { field: "health", in: ["healthy", "none"] },
    ],
  },
};
