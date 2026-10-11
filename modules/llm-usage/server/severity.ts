import type {
  UsageBar,
  UsageBarDraft,
  UsageBarSource,
  UsageSeverity,
  UsageThresholds,
} from "./types.js";

/** Band a percentage; a provider-flagged or 100% limit is always danger. */
export function severityFor(percent: number, reached: boolean, thresholds: UsageThresholds): UsageSeverity {
  if (reached || percent >= 100 || percent >= thresholds.danger) return "danger";
  if (percent >= thresholds.warn) return "warn";
  return "normal";
}

/** Attribute and band adapter drafts. */
export function finalizeBars(
  drafts: readonly UsageBarDraft[],
  src: UsageBarSource,
  observedAt: number,
  thresholds: UsageThresholds,
): UsageBar[] {
  return drafts.map((draft) => ({
    ...draft,
    severity: severityFor(draft.percent, draft.reached, thresholds),
    src,
    observedAt,
  }));
}

/** Clamp a reported percentage into 0–100; non-finite values are rejected upstream. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Normalize a reset timestamp to epoch ms. Sources disagree: Claude sends ISO 8601,
 * Codex epoch seconds. A number below 1e12 is taken as seconds, which stays correct
 * until the year 33658.
 */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  return null;
}
