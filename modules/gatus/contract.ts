import type { UiStatusKind } from "@deck/module-sdk";

/**
 * How a `gatus` binding gives a bound card its status, as the UI manifest lists it
 * (`statusKinds`): the kind, its module, its fixed provider id and its status declaration. The
 * server manifest's `providerKinds` entry is built from it, and the portal's
 * `BUILTIN_STATUS_KINDS` (its fallback for when the UI manifest cannot be read) lists it, so the
 * two cannot drift. Data only (no runtime imports), so the browser bundle can load it.
 *
 * A `gatus` binding (`{ endpoint }`) reads the endpoint with that key in the fixed `gatus`
 * provider; up when gatus says so.
 */
export const GATUS_STATUS_KIND: UiStatusKind = {
  kind: "gatus",
  module: "gatus",
  fixedId: "gatus",
  status: {
    provider: "fixed",
    match: { list: "endpoints", key: "key", binding: "endpoint" },
    up: [{ field: "up", in: [true] }],
  },
};
