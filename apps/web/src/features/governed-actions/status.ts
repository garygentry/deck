/**
 * Governed-actions presentation vocabulary: the run-outcome status map and the
 * one target formatter shared by the action list, the confirm panel and the
 * audit history.
 */

import type { ActionOutcome } from "@deck/server";
import { defineStatusMap, type StatusMap } from "@/ui";

/**
 * Presentation for each terminal outcome: tone + icon + visible label, so status
 * is never colour alone. `role` chooses the live-region politeness of the
 * terminal announcement (a failure interrupts; a success or a cancel is polite).
 */
export const OUTCOME_UI: StatusMap<ActionOutcome> = Object.freeze(
  defineStatusMap<ActionOutcome>({
    succeeded: { tone: "ok", icon: "circle-check", label: "Succeeded", role: "status" },
    failed: { tone: "danger", icon: "circle-x", label: "Failed", role: "alert" },
    error: { tone: "danger", icon: "triangle-alert", label: "Error", role: "alert" },
    rejected: { tone: "warn", icon: "ban", label: "Rejected", role: "alert" },
    "timed-out": { tone: "warn", icon: "clock-alert", label: "Timed out", role: "alert" },
    cancelled: { tone: "neutral", icon: "circle-stop", label: "Cancelled", role: "status" },
  }),
);

/** Whether an outcome carries a meaningful exit code (the runner ran to completion). */
export function showsExitCode(outcome: ActionOutcome): boolean {
  return outcome === "succeeded" || outcome === "failed";
}

/**
 * The textual target of an action or audit entry ("host" or "host · service"),
 * or null when it is estate-wide. Callers add their own "Target" label.
 */
export function targetLabel(
  target: { readonly host: string; readonly service?: string } | undefined,
): string | null {
  if (target === undefined) return null;
  return target.service === undefined ? target.host : `${target.host} · ${target.service}`;
}
