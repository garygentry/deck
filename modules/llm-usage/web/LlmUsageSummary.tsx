import type { JSX } from "react";
import { FragmentBoundary, HealthPill } from "@/ui";

import type { HealthSummary } from "@/shell/health-header/health-summary.js";
import { SEVERITY_UI, worstBar } from "./status.js";
import { useLlmUsage, usageStore, type UsageStore } from "./store.js";

const USAGE_HREF = "/usage";

/**
 * Health-header pill: the tightest LLM plan limit (worst severity, then highest
 * percent). Self-sourcing like the other header fragments; it ignores the slot's props.
 * Renders nothing when the feature is off or no source has reported yet, so an
 * unconfigured deployment has no pill at all.
 */
export function LlmUsageSummary(props: HealthSummary): JSX.Element {
  void props;
  return (
    <FragmentBoundary label="LLM usage summary" href={USAGE_HREF}>
      <LlmUsageSummaryContent />
    </FragmentBoundary>
  );
}

export function LlmUsageSummaryContent({ store = usageStore }: { store?: UsageStore }): JSX.Element {
  const view = useLlmUsage(store);
  if (view.status !== "ready" || !view.data.enabled) return <></>;
  const bar = worstBar(view.data);
  if (bar === null) return <></>;
  const severity = SEVERITY_UI[bar.severity];
  const percent = Math.round(bar.percent);
  return (
    <HealthPill
      tone={severity.tone}
      icon={severity.icon}
      label="LLM usage"
      href={USAGE_HREF}
      count={`${percent}%`}
      countLabel={`${percent}% used on ${bar.label}`}
      title={`${bar.label}: ${percent}% used (${severity.label.toLowerCase()})`}
    />
  );
}
