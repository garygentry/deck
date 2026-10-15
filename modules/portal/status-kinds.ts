import type { UiStatusKind } from "@deck/module-sdk";

import { DOCKER_STATUS } from "../docker/contract.js";
import { GATUS_STATUS } from "../gatus/contract.js";
import { HTTP_HEALTH_STATUS } from "../http-health/contract.js";

/**
 * How the built-in status-capable data sources give a bound card its status, as the portal
 * reads them: each data-source module's `providerKinds[].status` (from its `contract.ts`
 * entry), the portal's fallback for when the UI manifest (which lists every enabled kind's,
 * `statusKinds`) cannot be read, and the precedence order of the built-in kinds. Data only (no
 * runtime code), so the browser bundle can load it.
 */

/** The built-in status kinds as the UI manifest lists them, by kind. */
export const BUILTIN_STATUS_KINDS: readonly UiStatusKind[] = [
  { kind: "docker", module: "docker", fixedId: "docker", status: DOCKER_STATUS },
  { kind: "gatus", module: "gatus", fixedId: "gatus", status: GATUS_STATUS },
  { kind: "http-health", module: "http-health", status: HTTP_HEALTH_STATUS },
];
