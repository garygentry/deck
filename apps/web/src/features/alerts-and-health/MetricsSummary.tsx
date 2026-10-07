import type { JSX } from "react";

import type { HealthSummary } from "../../shell/health-header/health-summary.js";
import { SummaryPresentationBoundary } from "./SummaryPresentationBoundary.js";
import { rollupMetrics } from "./status.js";
import { renderPending, renderSegment } from "./summary-render.js";
import { usePrometheusData } from "./usePrometheusData.js";

/** The monitoring-page anchor this segment links to. */
const METRICS_HREF = "/monitoring#metrics";

/**
 * Self-rendering health-header fragment for prometheus summaries. Identical structure to
 * `AlertsSummary`: it satisfies the shell-owned `ComponentType<HealthSummary>` slot signature but
 * ignores its (void) props, sourcing its own data and rendering its own `<a>`.
 */
export function MetricsSummary(props: HealthSummary): JSX.Element {
  void props;
  return (
    <SummaryPresentationBoundary segment="metrics" href={METRICS_HREF}>
      <MetricsSummaryContent />
    </SummaryPresentationBoundary>
  );
}

function MetricsSummaryContent(): JSX.Element {
  const view = usePrometheusData();

  // Not configured: omit the segment (or a pending segment while the first poll is in flight).
  if (view.data === null && view.freshness === null) {
    return view.loading ? renderPending("Metrics", METRICS_HREF) : <></>;
  }

  // Source errored, no last-known-good: show the chip with NO count, frozen `ok` status.
  if (view.data === null) {
    return renderSegment({
      label: "Metrics",
      status: "ok",
      freshness: view.freshness ?? undefined,
      href: METRICS_HREF,
    });
  }

  const rollup = rollupMetrics(view.data.summaries);
  // `errorCount` is intentionally NOT surfaced in the header — an errored summary surfaces on the
  // page, not as a header status. The count is the breach count (warning ∪ critical).
  return renderSegment({
    label: "Metrics",
    status: rollup.status,
    count: rollup.breachCount,
    freshness: view.freshness ?? undefined,
    href: METRICS_HREF,
  });
}
