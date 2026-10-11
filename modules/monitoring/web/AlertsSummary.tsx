import type { JSX } from "react";

import type { HealthSummary } from "@/shell/health-header/health-summary.js";
import { SummaryPresentationBoundary } from "./SummaryPresentationBoundary.js";
import { deriveAlertStatus } from "./status.js";
import { renderPending, renderSegment } from "./summary-render.js";
import { useAlertmanagerData } from "./useAlertmanagerData.js";

/** The monitoring-page anchor this segment links to. */
const ALERTS_HREF = "/monitoring#alerts";

/**
 * Self-rendering health-header fragment for active alerts. Satisfies the shell-owned
 * `ComponentType<HealthSummary>` slot signature but ignores its (void) props — the shell renders
 * the fragment with no props, so it sources its own data and renders its own `<a>`.
 */
export function AlertsSummary(props: HealthSummary): JSX.Element {
  void props;
  return (
    <SummaryPresentationBoundary segment="alerts" href={ALERTS_HREF}>
      <AlertsSummaryContent />
    </SummaryPresentationBoundary>
  );
}

function AlertsSummaryContent(): JSX.Element {
  const view = useAlertmanagerData();

  // Not configured: provider absent → 404 → all-null view after the first poll. Render nothing so
  // the segment is OMITTED (distinct from an alarming empty), or a pending segment while loading.
  if (view.data === null && view.freshness === null) {
    return view.loading ? renderPending("Alerts", ALERTS_HREF) : <></>;
  }

  // Source errored with no last-known-good (envelope present, data null): show the segment with a
  // stale/unreachable chip and NO count — never a fabricated healthy `0`. Status stays the frozen
  // `ok` shell value; the freshness chip carries the failure.
  if (view.data === null) {
    return renderSegment({
      label: "Alerts",
      status: "ok",
      freshness: view.freshness ?? undefined,
      href: ALERTS_HREF,
    });
  }

  // Reachable source: derive status + count from last-known-good.
  const status = deriveAlertStatus(view.data);
  return renderSegment({
    label: "Alerts",
    status,
    count: view.data.firingCount,
    freshness: view.freshness ?? undefined,
    href: ALERTS_HREF,
  });
}
