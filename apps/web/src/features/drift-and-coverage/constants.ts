import { DRIFT_UI_DEFAULTS } from "@deck/drift";
import type { HostCollectionState } from "@deck/contract";
import type { DriftSeverity, WaiverState } from "@deck/drift";
import { defineStatusMap, type StatusPresentation } from "@/ui";

// Feature-owned status maps. The label is the sole authoritative text; the tone
// and icon are strictly redundant with it (status is never colour-only). Each map
// is exhaustive over its closed server vocabulary, so a new state is a compile
// failure until it is presented.

/**
 * Active-risk severity. An error is a danger, a warning a warning, and info is
 * informational.
 */
export const DRIFT_SEVERITY = Object.freeze(
  defineStatusMap<DriftSeverity>({
    error: Object.freeze({ tone: "danger", icon: "circle-x", label: "Error" }),
    warning: Object.freeze({ tone: "warn", icon: "triangle-alert", label: "Warning" }),
    info: Object.freeze({ tone: "info", icon: "info", label: "Info" }),
  }),
);

/**
 * Display-time waiver classification. An expired waiver reads as attention
 * because it counts as active risk; an active waiver is informational.
 */
export const DRIFT_WAIVER = Object.freeze(
  defineStatusMap<WaiverState>({
    unwaived: Object.freeze({ tone: "neutral", icon: "circle", label: "Unwaived" }),
    active: Object.freeze({ tone: "info", icon: "calendar-clock", label: "Active waiver" }),
    expired: Object.freeze({ tone: "warn", icon: "clock-alert", label: "Expired waiver" }),
  }),
);

/**
 * Five-state host collection coverage, with the same icons the inventory pages
 * use for the same states.
 */
export const DRIFT_COVERAGE = Object.freeze(
  defineStatusMap<HostCollectionState>({
    fresh: Object.freeze({ tone: "ok", icon: "circle-check", label: "Fresh" }),
    stale: Object.freeze({ tone: "warn", icon: "clock-alert", label: "Stale" }),
    partial: Object.freeze({ tone: "neutral", icon: "circle-dashed", label: "Partial" }),
    unreachable: Object.freeze({ tone: "danger", icon: "cloud-off", label: "Unreachable" }),
    "never-collected": Object.freeze({
      tone: "neutral",
      icon: "circle-slash",
      label: "Never collected",
    }),
  }),
);

/**
 * A finding whose host/service identity cannot be resolved to a detail route.
 * The label is the exact fixed phrase rendered in place of the entity link.
 */
export const DRIFT_UNRESOLVED_LOCATION: StatusPresentation = Object.freeze({
  tone: "neutral",
  icon: "link-off",
  label: "Location unresolved; no host or service detail link is available.",
});

/** True only for a finite, non-negative safe integer. */
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Advance a progressive visible count by the fixed release step, never exceeding
 * the complete total. A valid `current > total` clamps to `total`. Negative or
 * non-safe-integer programmer input throws a fixed `RangeError`.
 */
export function nextProgressiveCount(current: number, total: number): number {
  if (!isNonNegativeSafeInteger(current) || !isNonNegativeSafeInteger(total)) {
    throw new RangeError("Progressive counts must be non-negative safe integers.");
  }
  return Math.min(
    Math.max(0, total),
    Math.max(0, current) + DRIFT_UI_DEFAULTS.additionalRowsPerStep,
  );
}
