import { defineServerModule, type ModuleManifest, type ServiceOffer, type ServiceRef } from "@deck/module-sdk";

import type { SnapshotContent } from "../../snapshot/server/content.js";
import { METRICS_PATH, metricsResponse } from "./route.js";

/** The snapshot module's `snapshot/content` service; none is offered without a snapshot source. */
const SNAPSHOT_CONTENT: ServiceRef<SnapshotContent> = { name: "snapshot/content" };

/** The deployment setting that switches the module on. */
export const METRICS_ENABLED_ENV = "DECK_METRICS_ENABLED";

/**
 * The metrics module: deck's own Prometheus exposition at `GET /metrics`, built from the
 * provider registry's cached poll statistics with no upstream I/O.
 *
 * It runs only when `DECK_METRICS_ENABLED` is `true` or `1`, a deployment setting this
 * module owns, so an existing deployment exposes nothing until an operator opts in.
 * `/metrics` is a declared root path, so the SPA fallback never rewrites it to the web
 * shell: switched off, it answers deck's plain 404. The module has no config section, no
 * `/api` routes and no UI. The snapshot's content age comes from the snapshot module's
 * `snapshot/content` service, read per scrape like the poll statistics.
 */
export const METRICS_MANIFEST: ModuleManifest = {
  id: "metrics",
  version: "1.0.0",
  deckApi: "^0.1",
  enabledBy: { env: METRICS_ENABLED_ENV },
  env: [METRICS_ENABLED_ENV],
  contributes: {
    routes: { rootPaths: [METRICS_PATH] },
  },
  services: { uses: [SNAPSHOT_CONTENT.name] },
};

export const metricsModule = defineServerModule(METRICS_MANIFEST, (ctx) => {
  ctx.rootRoute(METRICS_PATH, (request) =>
    metricsResponse(request, {
      stats: ctx.providers.stats(),
      snapshotGeneratedAtMs: snapshotGeneratedAtMs(ctx.services.offers(SNAPSHOT_CONTENT)),
      nowMs: ctx.clock.now(),
    }),
  );
});

/**
 * The built-in snapshot module's answer, as finite epoch ms; null otherwise. Another module's
 * offer of the name never speaks for the snapshot, and an offer that throws or answers
 * something other than a finite number leaves the gauges absent rather than failing the scrape.
 */
function snapshotGeneratedAtMs(offers: readonly ServiceOffer<SnapshotContent>[]): number | null {
  const offer = offers.find((candidate) => candidate.builtin && candidate.module === "snapshot");
  if (offer === undefined) return null;
  try {
    const ms: unknown = offer.impl.generatedAtMs();
    return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
