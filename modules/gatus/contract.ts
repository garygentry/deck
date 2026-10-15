import type { ProviderStatusDecl } from "@deck/module-sdk";

/**
 * How a `gatus` binding gives a bound card its status: the module's `providerKinds[].status`,
 * which the portal's web half also reads as its fallback for when the UI manifest cannot be
 * read. Data only (no runtime imports), so the browser bundle can load it.
 */

/** A `gatus` binding (`{ endpoint }`) reads the endpoint with that key; up when gatus says so. */
export const GATUS_STATUS: ProviderStatusDecl = {
  provider: "fixed",
  match: { list: "endpoints", key: "key", binding: "endpoint" },
  up: [{ field: "up", in: [true] }],
};
