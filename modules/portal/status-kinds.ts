import type { UiStatusKind } from "@deck/module-sdk";

import { DOCKER_STATUS_KIND } from "../docker/contract.js";
import { GATUS_STATUS_KIND } from "../gatus/contract.js";
import { HTTP_HEALTH_STATUS_KIND } from "../http-health/contract.js";

/**
 * The built-in status-capable data sources' status kinds, as the UI manifest lists them: each
 * data-source module's own entry (from its `contract.ts`, which its server manifest's
 * `providerKinds` is built from too). The portal's web half reads them as its fallback for when
 * the UI manifest (which lists every enabled kind's, `statusKinds`) cannot be read, and for the
 * built-in kinds' precedence order. Data only (no runtime code), so the browser bundle can load it.
 */
export const BUILTIN_STATUS_KINDS: readonly UiStatusKind[] = [DOCKER_STATUS_KIND, GATUS_STATUS_KIND, HTTP_HEALTH_STATUS_KIND];
