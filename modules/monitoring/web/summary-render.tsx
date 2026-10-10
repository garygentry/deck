import type { FreshnessStamp } from "@deck/contract";
import type { JSX } from "react";

import type { HealthSummary } from "@/shell/health-header/health-summary.js";
import { HealthSummaryPill } from "@/shell/health-header/HealthSummaryPill.js";
import { HEADER_STATUS_PRESENTATION } from "./status.js";

// ---------------------------------------------------------------------------
// Shared render helpers for the two health-header summary fragments. Both
// segments render the shell's HealthSummaryPill: one link with icon + text
// (+ count) (+ freshness). Colour is supplemental; icon and text carry status.
// ---------------------------------------------------------------------------

/** The pending stamp shown before the first successful poll settles. */
const PENDING_FRESHNESS: FreshnessStamp = Object.freeze({
  state: "pending",
  observedAt: null,
  ageMs: null,
  ttlMs: null,
});

/** Render one header segment with the page's status icon. */
export function renderSegment(summary: HealthSummary): JSX.Element {
  return (
    <HealthSummaryPill summary={summary} icon={HEADER_STATUS_PRESENTATION[summary.status].icon} />
  );
}

/**
 * Pending (pre-first-poll) segment: icon + label, no count, pending freshness. The status is the
 * frozen `ok` shell value; the pending tone, not the status, says that data is loading.
 */
export function renderPending(label: string, href: string): JSX.Element {
  return (
    <HealthSummaryPill
      summary={{ label, status: "ok", freshness: PENDING_FRESHNESS, href }}
      pending
    />
  );
}
