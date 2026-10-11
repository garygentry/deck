import { describe, expect, it } from "vitest";

import {
  ALERT_BADGE_PRESENTATION,
  HEADER_STATUS_PRESENTATION,
  OTHER_SEVERITY_BUCKET,
  SEVERITY_ORDER,
  STATUS_PRESENTATION,
  deriveAlertStatus,
  envelopeSectionState,
  rollupMetrics,
} from "../../web/status.js";
import type {
  ActiveAlert,
  AlertmanagerResult,
} from "../../web/useAlertmanagerData.js";
import type { SummaryValue } from "../../web/usePrometheusData.js";

function summary(status: SummaryValue["status"], value: number | null = 1): SummaryValue {
  return { id: `s-${status}-${String(value)}`, label: status, value, status };
}

function alert(severity: string, suppressed = false): ActiveAlert {
  return {
    fingerprint: `${severity}-${suppressed ? "sup" : "fire"}`,
    name: `${severity} alert`,
    severity,
    startsAt: "2026-09-15T00:00:00Z",
    suppressed,
    sourceUrl: null,
  };
}

function amResult(alerts: ActiveAlert[]): AlertmanagerResult {
  return {
    alerts,
    silences: [],
    firingCount: alerts.filter((a) => !a.suppressed).length,
  };
}

describe("status.ts constants", () => {
  it("declares the page-level presentation map for all four statuses, with tones", () => {
    expect(STATUS_PRESENTATION).toEqual({
      healthy: { tone: "ok", icon: "circle-check", label: "Healthy" },
      warning: { tone: "warn", icon: "triangle-alert", label: "Warning" },
      critical: { tone: "danger", icon: "octagon-alert", label: "Critical" },
      error: { tone: "neutral", icon: "cloud-off", label: "Error" },
    });
    expect(Object.isFrozen(STATUS_PRESENTATION)).toBe(true);
  });

  it("declares an alert-row badge for each severity bucket and for suppressed alerts", () => {
    expect(Object.keys(ALERT_BADGE_PRESENTATION)).toEqual([
      "critical",
      "warning",
      "info",
      "other",
      "suppressed",
    ]);
    expect(ALERT_BADGE_PRESENTATION.critical.tone).toBe(STATUS_PRESENTATION.critical.tone);
    expect(ALERT_BADGE_PRESENTATION.warning.tone).toBe(STATUS_PRESENTATION.warning.tone);
    expect(ALERT_BADGE_PRESENTATION.suppressed.label).toBe("Suppressed");
    expect(Object.isFrozen(ALERT_BADGE_PRESENTATION)).toBe(true);
  });

  it("maps the frozen 3-value header vocabulary onto the shared presentation cells", () => {
    expect(HEADER_STATUS_PRESENTATION.ok).toBe(STATUS_PRESENTATION.healthy);
    expect(HEADER_STATUS_PRESENTATION.warning).toBe(STATUS_PRESENTATION.warning);
    expect(HEADER_STATUS_PRESENTATION.critical).toBe(STATUS_PRESENTATION.critical);
    expect(Object.keys(HEADER_STATUS_PRESENTATION)).toEqual(["ok", "warning", "critical"]);
    expect(Object.isFrozen(HEADER_STATUS_PRESENTATION)).toBe(true);
  });

  it("declares the severity taxonomy constants", () => {
    expect(SEVERITY_ORDER).toEqual(["critical", "warning", "info"]);
    expect(OTHER_SEVERITY_BUCKET).toBe("Other");
  });
});

describe("rollupMetrics", () => {
  it("yields ok/0/0 for an empty input", () => {
    expect(rollupMetrics([])).toEqual({ status: "ok", breachCount: 0, errorCount: 0 });
  });

  it("stays ok when every summary is ok/neutral/error and counts errors separately", () => {
    const rollup = rollupMetrics([
      summary("ok"),
      summary("neutral"),
      summary("error", null),
      summary("error", null),
    ]);
    expect(rollup).toEqual({ status: "ok", breachCount: 0, errorCount: 2 });
  });

  it("rolls up to warning on any warning breach", () => {
    const rollup = rollupMetrics([summary("ok"), summary("warning"), summary("neutral")]);
    expect(rollup).toEqual({ status: "warning", breachCount: 1, errorCount: 0 });
  });

  it("rolls up to critical when any summary is critical, regardless of order", () => {
    expect(rollupMetrics([summary("critical"), summary("warning")])).toEqual({
      status: "critical",
      breachCount: 2,
      errorCount: 0,
    });
    expect(rollupMetrics([summary("warning"), summary("critical")])).toEqual({
      status: "critical",
      breachCount: 2,
      errorCount: 0,
    });
  });

  it("errors never raise the status even alongside a breach", () => {
    const rollup = rollupMetrics([summary("error", null), summary("warning")]);
    expect(rollup).toEqual({ status: "warning", breachCount: 1, errorCount: 1 });
  });
});

describe("deriveAlertStatus", () => {
  it("returns ok when firingCount is 0 (all-clear on a reachable source)", () => {
    expect(deriveAlertStatus(amResult([]))).toBe("ok");
    // Suppressed alerts present but nothing firing → still ok.
    expect(deriveAlertStatus(amResult([alert("critical", true)]))).toBe("ok");
  });

  it("returns critical when any firing non-suppressed alert is critical", () => {
    expect(deriveAlertStatus(amResult([alert("warning"), alert("critical")]))).toBe("critical");
  });

  it("ignores suppressed critical alerts (not in firingCount)", () => {
    // A suppressed critical + a firing warning → warning, not critical.
    expect(deriveAlertStatus(amResult([alert("critical", true), alert("warning")]))).toBe(
      "warning",
    );
  });

  it("returns warning when firing but none critical", () => {
    expect(deriveAlertStatus(amResult([alert("warning"), alert("info")]))).toBe("warning");
  });
});

describe("envelopeSectionState", () => {
  it("returns not-configured when both freshness and error are null", () => {
    expect(envelopeSectionState(null, null, false)).toBe("not-configured");
    expect(envelopeSectionState(null, null, true)).toBe("not-configured");
  });

  it("returns error on a server error", () => {
    expect(envelopeSectionState({ state: "fresh" }, { message: "boom" }, true)).toBe("error");
    expect(envelopeSectionState(null, { message: "boom" }, false)).toBe("error");
  });

  it("returns error on unreachable freshness", () => {
    expect(envelopeSectionState({ state: "unreachable" }, null, true)).toBe("error");
  });

  it("returns active when reachable with content", () => {
    expect(envelopeSectionState({ state: "fresh" }, null, true)).toBe("active");
    expect(envelopeSectionState({ state: "stale" }, null, true)).toBe("active");
  });

  it("returns all-clear when reachable with no content", () => {
    expect(envelopeSectionState({ state: "fresh" }, null, false)).toBe("all-clear");
    expect(envelopeSectionState({ state: "stale" }, null, false)).toBe("all-clear");
  });
});
