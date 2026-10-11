import type { JSX } from "react";
import { FreshnessBadge, List, ListItem, LoadingState, Section, StatusBadge } from "@/ui";

import { AllClearNotice, NotConfiguredNotice, SourceErrorNotice } from "./SectionNotice.js";
import { STATUS_PRESENTATION, envelopeSectionState, type PageStatus } from "./status.js";
import type { PrometheusData, SummaryStatus, SummaryValue } from "./usePrometheusData.js";

export interface MetricsSectionProps {
  /** Flattened prometheus view from `usePrometheusData()`. */
  view: PrometheusData;
}

/**
 * Map a per-summary `SummaryStatus` to the page-level 4-state vocabulary for presentation, or `null`
 * for `neutral` (a value with no threshold status). Pure and total over the union.
 */
export function summaryPageStatus(status: SummaryStatus): PageStatus | null {
  switch (status) {
    case "ok":
      return "healthy";
    case "warning":
      return "warning";
    case "critical":
      return "critical";
    case "error":
      return "error";
    case "neutral":
      return null;
  }
}

export function MetricsSection({ view }: MetricsSectionProps): JSX.Element {
  if (view.loading && view.freshness === null) {
    return (
      <Section id="metrics" title="Metrics">
        <LoadingState label="Loading metrics…" rows={2} />
      </Section>
    );
  }

  const summaries = view.data?.summaries ?? [];
  const state = envelopeSectionState(view.freshness, view.error, summaries.length > 0);

  return (
    <Section
      id="metrics"
      title="Metrics"
      data-state={state}
      actions={
        state === "active" && view.freshness !== null ? (
          <FreshnessBadge freshness={view.freshness} />
        ) : undefined
      }
    >
      {state === "not-configured" && (
        <NotConfiguredNotice>Prometheus not configured.</NotConfiguredNotice>
      )}

      {state === "error" && <SourceErrorNotice source="Prometheus" freshness={view.freshness} />}

      {state === "all-clear" && <AllClearNotice>no summaries declared.</AllClearNotice>}

      {state === "active" && (
        <List variant="divided" aria-label="Metric summaries">
          {summaries.map((summary) => (
            <SummaryRow key={summary.id} summary={summary} />
          ))}
        </List>
      )}
    </Section>
  );
}

/**
 * One summary: label, then its value and threshold status. An errored or valueless summary shows an
 * explicit "No data" badge — never a fabricated `0` and never a healthy status. A `neutral` summary
 * is a bare value with no status.
 */
function SummaryRow({ summary }: { summary: SummaryValue }): JSX.Element {
  const page = summaryPageStatus(summary.status);
  const isError = summary.status === "error" || summary.value === null;
  return (
    <ListItem
      title={summary.label}
      meta={
        isError ? (
          StatusBadge.fromMap(STATUS_PRESENTATION, "error", { label: "No data" })
        ) : (
          <>
            <span className="font-mono text-sm font-semibold text-foreground">
              {summary.value}
              {summary.unit ?? ""}
            </span>
            {page !== null && StatusBadge.fromMap(STATUS_PRESENTATION, page)}
          </>
        )
      }
    />
  );
}
