import type { ProviderStatusDecl } from "@deck/module-sdk";

/**
 * How an `http-health` binding gives a bound card its status: the module's
 * `providerKinds[].status`, which the portal's web half also reads as its fallback for when the
 * UI manifest cannot be read. Data only (no runtime imports), so the browser bundle can load it.
 */

/** An `http-health` binding is its own provider, probing its URL; up on a 2xx or 3xx answer. */
export const HTTP_HEALTH_STATUS: ProviderStatusDecl = {
  provider: "binding",
  up: [{ field: "up", in: [true] }],
};
