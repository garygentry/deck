import type { FreshnessStamp } from "@deck/contract";

/** Health-header status severity; color is supplemental to icon + text only. */
export type HealthStatus = "ok" | "warning" | "critical";

/**
 * The conceptual contribution shape a health-header fragment must honor.
 * Fragments are self-sufficient — they source their own data and emit this shape;
 * the shell never threads it through as props.
 */
export interface HealthSummary {
  label: string;
  status: HealthStatus;
  count?: number;
  freshness?: FreshnessStamp;
  href?: string;
}
