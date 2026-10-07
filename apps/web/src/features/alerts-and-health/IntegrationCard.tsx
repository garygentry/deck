import type { Integration } from "@deck/schema";
import type { FreshnessStamp } from "@deck/contract";
import type { JSX } from "react";
import { FreshnessBadge, LinkTile, StatusBadge } from "@/ui";

import { NOT_CONFIGURED_ICON, STATUS_PRESENTATION, envelopeSectionState } from "./status.js";
import type { AlertmanagerData } from "./useAlertmanagerData.js";
import type { PrometheusData } from "./usePrometheusData.js";

/**
 * Live-status source for a card whose kind matches an in-deck provider. `null` → plain deep-link
 * (unknown/opaque kind — never an error). Reads the SAME hook data the header uses; issues no new
 * request of its own.
 */
export type LiveStatus =
  | { kind: "alertmanager"; view: AlertmanagerData }
  | { kind: "prometheus"; view: PrometheusData }
  | null;

export interface IntegrationCardProps {
  integration: Integration;
  /** Live-status source, or `null` for an unmatched kind. */
  live: LiveStatus;
}

/**
 * A single deep-link tile. Every tile is one anchor to `deepLink ?? baseUrl`, opened in a new tab,
 * showing the title and kind. A live status (and its freshness) renders only when `live !== null`.
 */
export function IntegrationCard({ integration, live }: IntegrationCardProps): JSX.Element {
  const href = integration.deepLink ?? integration.baseUrl;
  const status = live === null ? null : liveStatus(live);
  return (
    <LinkTile
      href={href}
      external
      title={integration.title}
      description={integration.kind}
      meta={
        status == null ? undefined : (
          // Status and freshness share the footer, so a long status never squeezes the title.
          // Inside a link: no tooltip, so the badge adds no nested focus stop.
          <span className="flex flex-wrap items-center gap-2">
            {status.badge}
            {status.freshness !== null && (
              <FreshnessBadge freshness={status.freshness} tooltip={false} />
            )}
          </span>
        )
      }
    />
  );
}

/**
 * Compact live status derived from the shared hook view — no new endpoint. Not-configured/error come
 * from `envelopeSectionState`; the healthy/warning/critical presentation uses `STATUS_PRESENTATION`
 * (icon + text). The card never reads `credentialEnv` and never fetches.
 */
function liveStatus(live: NonNullable<LiveStatus>): {
  badge: JSX.Element;
  freshness: FreshnessStamp | null;
} {
  const view = live.view;
  const state = envelopeSectionState(view.freshness, view.error, view.data !== null);

  if (state === "not-configured") {
    return {
      badge: <StatusBadge tone="neutral" icon={NOT_CONFIGURED_ICON} label="Not configured" />,
      freshness: null,
    };
  }
  if (state === "error") {
    return { badge: StatusBadge.fromMap(STATUS_PRESENTATION, "error"), freshness: view.freshness };
  }

  if (live.kind === "alertmanager") {
    const firing = live.view.data?.firingCount ?? 0;
    return {
      badge: StatusBadge.fromMap(STATUS_PRESENTATION, firing === 0 ? "healthy" : "critical", {
        label: `${firing} firing`,
      }),
      freshness: view.freshness,
    };
  }

  const summaries = live.view.data?.summaries ?? [];
  const breaching = summaries.filter(
    (s) => s.status === "warning" || s.status === "critical",
  ).length;
  return {
    badge: StatusBadge.fromMap(STATUS_PRESENTATION, breaching === 0 ? "healthy" : "warning", {
      label: `Reachable${breaching > 0 ? ` · ${breaching} breaching` : ""}`,
    }),
    freshness: view.freshness,
  };
}
