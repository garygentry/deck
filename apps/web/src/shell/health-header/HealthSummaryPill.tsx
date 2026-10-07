import type { ComponentProps } from "react";
import { FreshnessBadge, HealthPill, type IconName, type Tone } from "@/ui";
import type { HealthStatus, HealthSummary } from "./health-summary.js";

/** The frozen header vocabulary mapped onto the library tones. */
export const HEALTH_TONE: Readonly<Record<HealthStatus, Tone>> = {
  ok: "ok",
  warning: "warn",
  critical: "danger",
};

const HEALTH_ICON: Readonly<Record<HealthStatus, IconName>> = {
  ok: "circle-check",
  warning: "triangle-alert",
  critical: "circle-x",
};

export interface HealthSummaryPillProps
  extends Omit<ComponentProps<"a">, "href" | "children" | "title"> {
  summary: HealthSummary;
  /** Overrides the status icon, e.g. a feature's own presentation map. */
  icon?: IconName | (string & {});
  /** Before the first poll settles: pending tone and hourglass, whatever the status. */
  pending?: boolean;
}

/**
 * One health-header segment: a `HealthPill` for a feature's `HealthSummary`,
 * with its freshness as a trailing badge. Features render this from their
 * self-sufficient summary fragments.
 */
export function HealthSummaryPill({ summary, icon, pending = false, ...props }: HealthSummaryPillProps) {
  return (
    <HealthPill
      tone={pending ? "pending" : HEALTH_TONE[summary.status]}
      icon={pending ? "hourglass" : (icon ?? HEALTH_ICON[summary.status])}
      label={summary.label}
      href={summary.href ?? "/"}
      count={summary.count}
      data-health-status={summary.status}
      meta={
        summary.freshness == null ? undefined : (
          <FreshnessBadge freshness={summary.freshness} tooltip={false} variant="dot" />
        )
      }
      {...props}
    />
  );
}
