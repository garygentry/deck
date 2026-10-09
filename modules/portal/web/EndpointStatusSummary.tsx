import type { ProviderEnvelope } from "@deck/contract";
import { PORTAL_UI } from "@deck/contract/modules/portal";
import type { JSX } from "react";
import { useProvider } from "@/data/index.js";
import { HealthSummaryPill } from "@/shell/health-header/HealthSummaryPill.js";
import type {
  HealthStatus,
  HealthSummary,
} from "@/shell/health-header/health-summary.js";
import type { GatusResult } from "./card-status.js";

/**
 * The portal page this summary links to (self-sufficient fragment): its own path from the
 * portal's manifest, never `/`, which renders whichever page is home.
 */
export const PORTAL_HREF = PORTAL_UI.contributes!.pages![0]!.path;

/**
 * Derive the rich health summary from live portal data (absorbs the former
 * `PortalPage.computeEndpointSummary`). Endpoint state maps up→ok, degraded
 * (some down, some up)→warning, all down→critical; `count` is endpoints down.
 */
export function deriveEndpointSummary(gatus: ProviderEnvelope<GatusResult> | null): HealthSummary {
  const endpoints = gatus?.data?.endpoints ?? [];
  const freshness = gatus?.freshness ?? undefined;
  if (gatus === null || endpoints.length === 0) {
    return { label: "No monitored endpoints", status: "ok", count: 0, freshness, href: PORTAL_HREF };
  }
  const up = endpoints.filter((endpoint) => endpoint.up === true).length;
  const down = endpoints.length - up;
  const status: HealthStatus = down > 0 ? (up > 0 ? "warning" : "critical") : "ok";
  return { label: `${up} up / ${down} down`, status, count: down, freshness, href: PORTAL_HREF };
}

const STATUS_ICON: Readonly<Record<HealthStatus, string>> = {
  ok: "circle-check",
  warning: "alert-triangle",
  critical: "circle-x",
};

/**
 * Self-sufficient health-header fragment: reads the gatus endpoints (the same shared request
 * as the portal's cards) and emits its own HealthSummary — the shell renders it with NO props.
 */
export function EndpointStatusSummary(): JSX.Element {
  const summary = deriveEndpointSummary(useProvider<GatusResult>("gatus").envelope);
  return (
    <HealthSummaryPill
      summary={{ ...summary, count: undefined, freshness: undefined }}
      icon={STATUS_ICON[summary.status]}
    />
  );
}
