import { defineStatusMap, type IconName, type StatusMap } from "@/ui";

import type { HealthStatus } from "@/shell/health-header/health-summary.js";
import type { AlertmanagerResult } from "./useAlertmanagerData.js";
import type { SummaryValue } from "./usePrometheusData.js";

/**
 * Page-level status vocabulary. Richer than the frozen header slot's
 * `ok | warning | critical` (`HealthStatus`): `error` is an explicit distinct state at the page
 * level, where it is not bound by the header contract.
 */
export type PageStatus = "healthy" | "warning" | "critical" | "error";

/**
 * A section's/segment's rendering intent, distinguishing the states that must never be conflated:
 * an explicitly reachable-and-empty "all clear" vs. an unconfigured source.
 */
export type SectionState =
  | "all-clear" // reachable source, zero problems — explicit healthy
  | "active" // has content to show (alerts firing, summaries present)
  | "error" // source errored/unreachable, distinct from empty
  | "not-configured"; // no integration of this kind declared — quiet, never alarming

/**
 * The metrics header/page rollup derived from a prometheus result's summaries. Errored/neutral
 * summaries never raise the status — an errored *summary* surfaces on the page, not as a header
 * critical.
 */
export interface MetricsRollup {
  /** Worst breach across summaries: `critical` if any critical, else `warning` if any warning, else `ok`. */
  status: "ok" | "warning" | "critical";
  /** Number of summaries in `warning` OR `critical` (drives the header `count`). */
  breachCount: number;
  /** Number of summaries whose `status` is `error` (surfaced on the page only, not in header status). */
  errorCount: number;
}

/**
 * Presentation for the page-level 4-state vocabulary: tone + icon + visible label (status is never
 * colour alone). `error` is the neutral tone — an honest "source unavailable", never an alarming red
 * breach; `critical` is danger, `warning` warn, `healthy` ok.
 */
export const STATUS_PRESENTATION: StatusMap<PageStatus> = Object.freeze(
  defineStatusMap<PageStatus>({
    healthy: { tone: "ok", icon: "circle-check", label: "Healthy" },
    warning: { tone: "warn", icon: "triangle-alert", label: "Warning" },
    critical: { tone: "danger", icon: "octagon-alert", label: "Critical" },
    error: { tone: "neutral", icon: "cloud-off", label: "Error" },
  }),
);

/**
 * Header-segment presentation for the frozen 3-value slot vocabulary. Derived from the page-level
 * `STATUS_PRESENTATION` so the tone/icon/label stay identical between the header and the page for
 * the three shared statuses.
 */
export const HEADER_STATUS_PRESENTATION: StatusMap<HealthStatus> = Object.freeze(
  defineStatusMap<HealthStatus>({
    ok: STATUS_PRESENTATION.healthy,
    warning: STATUS_PRESENTATION.warning,
    critical: STATUS_PRESENTATION.critical,
  }),
);

/** The badge an alert row carries: its severity bucket, or `suppressed` when silenced. */
export type AlertBadge = "critical" | "warning" | "info" | "other" | "suppressed";

/**
 * Alert-row badge presentation. The three known severities reuse the page tones; an unrecognized
 * severity is neutral (its label is the raw severity at render time); a suppressed alert is marked
 * as such instead of by its severity, since it is not firing.
 */
export const ALERT_BADGE_PRESENTATION: StatusMap<AlertBadge> = Object.freeze(
  defineStatusMap<AlertBadge>({
    critical: { tone: "danger", icon: "octagon-alert", label: "Critical" },
    warning: { tone: "warn", icon: "triangle-alert", label: "Warning" },
    info: { tone: "info", icon: "info", label: "Info" },
    other: { tone: "neutral", icon: "circle-help", label: "Other" },
    suppressed: { tone: "neutral", icon: "eye-off", label: "Suppressed" },
  }),
);

/** The quiet "this source is not configured" glyph (never a failure glyph). */
export const NOT_CONFIGURED_ICON: IconName = "circle-minus";

/**
 * Fixed alert-grouping display order. Any unrecognized or absent severity falls into "Other"
 * (sorted alphabetically within that bucket) — an unknown severity never errors.
 */
export const SEVERITY_ORDER = ["critical", "warning", "info"] as const;
export const OTHER_SEVERITY_BUCKET = "Other" as const;

/**
 * Roll a provider's summaries up into the metrics header segment.
 * - status: worst breach — `critical` if any summary is `critical`, else `warning` if any is
 *   `warning`, else `ok`. `neutral`/`ok`/`error` summaries never raise the status.
 * - breachCount: number of summaries in `warning` OR `critical` (drives the header `count`).
 * - errorCount: number of summaries whose status is `error`. Errored summaries surface on the page,
 *   not as a header critical — this keeps the header honest about *breaches* vs *source errors*.
 *
 * An empty input yields `{ status: "ok", breachCount: 0, errorCount: 0 }`.
 */
export function rollupMetrics(summaries: readonly SummaryValue[]): MetricsRollup {
  let status: MetricsRollup["status"] = "ok";
  let breachCount = 0;
  let errorCount = 0;
  for (const summary of summaries) {
    if (summary.status === "critical") {
      status = "critical";
      breachCount += 1;
    } else if (summary.status === "warning") {
      if (status !== "critical") status = "warning";
      breachCount += 1;
    } else if (summary.status === "error") {
      errorCount += 1;
    }
    // "ok" and "neutral" contribute nothing.
  }
  return { status, breachCount, errorCount };
}

/**
 * Derive the alert header segment's status from the alertmanager result:
 * - `firingCount === 0` → `ok` (explicit "all clear" on a reachable source).
 * - any firing (non-suppressed) alert with `severity === "critical"` → `critical`.
 * - otherwise → `warning`.
 * Suppressed alerts never contribute (they are not in `firingCount`).
 */
export function deriveAlertStatus(result: AlertmanagerResult): HealthStatus {
  if (result.firingCount === 0) return "ok";
  const anyCritical = result.alerts.some(
    (alert) => !alert.suppressed && alert.severity === "critical",
  );
  return anyCritical ? "critical" : "warning";
}

/**
 * Derive a section's render state from a flattened hook view and whether the resolved payload has
 * content to show:
 * - no envelope at all (`freshness === null && error === null`, settled) → "not-configured";
 * - server error OR `unreachable` freshness → "error" (distinct from empty);
 * - otherwise → "active" when there is content, else the explicit "all-clear".
 * Callers render a pending placeholder while `loading` is true and no prior data exists, so the
 * first poll never flashes "not-configured".
 */
export function envelopeSectionState(
  freshness: { state: string } | null,
  error: { message: string } | null,
  hasContent: boolean,
): SectionState {
  if (freshness === null && error === null) return "not-configured";
  if (error !== null || freshness?.state === "unreachable") return "error";
  return hasContent ? "active" : "all-clear";
}
