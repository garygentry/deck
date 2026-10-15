import type { UiStatusKind } from "@deck/module-sdk";

/**
 * How an `http-health` binding gives a bound card its status, as the UI manifest lists it
 * (`statusKinds`): the kind, its module and its status declaration. The server manifest's
 * `providerKinds` entry is built from it, and the portal's `BUILTIN_STATUS_KINDS` (its fallback
 * for when the UI manifest cannot be read) lists it, so the two cannot drift. Data only (no
 * runtime imports), so the browser bundle can load it.
 *
 * An `http-health` binding is its own provider, probing its URL; up on a 2xx or 3xx answer.
 */
export const HTTP_HEALTH_STATUS_KIND: UiStatusKind = {
  kind: "http-health",
  module: "http-health",
  status: {
    provider: "binding",
    up: [{ field: "up", in: [true] }],
  },
};
