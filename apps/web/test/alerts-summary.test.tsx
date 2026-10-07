// @vitest-environment jsdom
import type { FreshnessStamp } from "@deck/contract";
import { cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Icon } from "@/ui";

import type {
  AlertmanagerData,
  AlertmanagerResult,
} from "../src/features/alerts-and-health/useAlertmanagerData.js";
import type {
  PrometheusData,
  PrometheusResult,
} from "../src/features/alerts-and-health/usePrometheusData.js";
import type { HealthSummary } from "../src/shell/health-header/health-summary.js";

// ---------------------------------------------------------------------------
// Each fragment sources its own data through one hook. Mocking the hook yields a
// deterministic flattened view with no poll/timer lifecycle. The fragments are
// rendered with placeholder `HealthSummary` props they must ignore.
// ---------------------------------------------------------------------------

let alertView: AlertmanagerData;
vi.mock("../src/features/alerts-and-health/useAlertmanagerData.js", () => ({
  useAlertmanagerData: () => alertView,
}));

let promView: PrometheusData;
vi.mock("../src/features/alerts-and-health/usePrometheusData.js", () => ({
  usePrometheusData: () => promView,
}));

import { AlertsSummary } from "../src/features/alerts-and-health/AlertsSummary.js";
import { MetricsSummary } from "../src/features/alerts-and-health/MetricsSummary.js";
import { SummaryPresentationBoundary } from "../src/features/alerts-and-health/SummaryPresentationBoundary.js";
import { HEADER_STATUS_PRESENTATION } from "../src/features/alerts-and-health/status.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Placeholder props both fragments must ignore. */
const IGNORED_PROPS: HealthSummary = { label: "placeholder-label", status: "warning", count: 999 };

const fresh: FreshnessStamp = {
  state: "fresh",
  observedAt: "2026-09-15T00:00:00.000Z",
  ageMs: 1_000,
  ttlMs: 30_000,
};
const unreachable: FreshnessStamp = {
  state: "unreachable",
  observedAt: "2026-09-15T00:00:00.000Z",
  ageMs: 90_000,
  ttlMs: 30_000,
};

function renderAlerts(view: AlertmanagerData): HTMLElement {
  alertView = view;
  return render(<AlertsSummary {...IGNORED_PROPS} />).container;
}

function renderMetrics(view: PrometheusData): HTMLElement {
  promView = view;
  return render(<MetricsSummary {...IGNORED_PROPS} />).container;
}

/** The segment link, found by its accessible name ("Alerts 2", "Metrics", …). */
const segment = (label: "Alerts" | "Metrics"): HTMLElement =>
  screen.getByRole("link", { name: new RegExp(`^${label}\\b`) });

/** The segment's visible count, or null when it shows none. */
function countOf(link: HTMLElement): string | null {
  return link.querySelector('[data-slot="health-pill-count"]')?.textContent ?? null;
}

/** The leading status icon's markup, to compare against the icon a status map names. */
function iconMarkup(link: HTMLElement): string {
  return link.querySelector('svg[data-slot="icon"]')!.innerHTML;
}

function expectedIcon(status: keyof typeof HEADER_STATUS_PRESENTATION): string {
  const { container } = render(<Icon name={HEADER_STATUS_PRESENTATION[status].icon} />);
  const markup = container.querySelector("svg")!.innerHTML;
  container.remove();
  return markup;
}

// ===========================================================================
// AlertsSummary
// ===========================================================================

describe("AlertsSummary — self-rendering & placeholder props", () => {
  it("ignores its placeholder props and renders its own /monitoring#alerts link", () => {
    const root = renderAlerts({ data: { alerts: [], silences: [], firingCount: 0 }, freshness: fresh, error: null, loading: false });
    expect(root.textContent).not.toContain("placeholder-label");
    expect(root.textContent).not.toContain("999");
    expect(segment("Alerts").getAttribute("href")).toBe("/monitoring#alerts");
  });
});

describe("AlertsSummary — per-segment degradation", () => {
  it("omits the segment when not configured (all-null, settled)", () => {
    renderAlerts({ data: null, freshness: null, error: null, loading: false });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a pending segment (no count, pending freshness) while loading with no prior data", () => {
    renderAlerts({ data: null, freshness: null, error: null, loading: true });
    const link = segment("Alerts");
    expect(link.getAttribute("href")).toBe("/monitoring#alerts");
    expect(link.querySelector('[data-freshness="pending"]')).not.toBeNull();
    expect(countOf(link)).toBeNull();
  });

  it("shows the segment with NO count and an unreachable freshness when the source errored with no last-known-good", () => {
    renderAlerts({ data: null, freshness: unreachable, error: { message: "down" }, loading: false });
    const link = segment("Alerts");
    expect(link.getAttribute("href")).toBe("/monitoring#alerts");
    expect(link.querySelector('[data-freshness="unreachable"]')).not.toBeNull();
    expect(countOf(link)).toBeNull();
    // Never leaks the server error string.
    expect(link.textContent).not.toContain("down");
  });

  it("shows an explicit all-clear with count 0 when reachable and no alerts firing", () => {
    renderAlerts({ data: { alerts: [], silences: [], firingCount: 0 }, freshness: fresh, error: null, loading: false });
    const link = segment("Alerts");
    expect(link.getAttribute("data-health-status")).toBe("ok");
    expect(iconMarkup(link)).toBe(expectedIcon("ok"));
    expect(countOf(link)).toBe("0");
  });
});

describe("AlertsSummary — status derivation", () => {
  const criticalAlert: AlertmanagerResult = {
    alerts: [
      { fingerprint: "f1", name: "A", severity: "critical", startsAt: "", suppressed: false, sourceUrl: null },
    ],
    silences: [],
    firingCount: 1,
  };
  const warningAlerts: AlertmanagerResult = {
    alerts: [
      { fingerprint: "f1", name: "A", severity: "warning", startsAt: "", suppressed: false, sourceUrl: null },
      { fingerprint: "f2", name: "B", severity: "info", startsAt: "", suppressed: false, sourceUrl: null },
    ],
    silences: [],
    firingCount: 2,
  };

  it("maps a firing critical alert to critical with count = firingCount", () => {
    renderAlerts({ data: criticalAlert, freshness: fresh, error: null, loading: false });
    const link = segment("Alerts");
    expect(link.getAttribute("data-health-status")).toBe("critical");
    expect(iconMarkup(link)).toBe(expectedIcon("critical"));
    expect(countOf(link)).toBe("1");
  });

  it("maps firing non-critical alerts to warning with count = firingCount", () => {
    renderAlerts({ data: warningAlerts, freshness: fresh, error: null, loading: false });
    const link = segment("Alerts");
    expect(link.getAttribute("data-health-status")).toBe("warning");
    expect(iconMarkup(link)).toBe(expectedIcon("warning"));
    expect(countOf(link)).toBe("2");
  });

  it("carries an aria-hidden icon AND visible text for every status", () => {
    renderAlerts({ data: criticalAlert, freshness: fresh, error: null, loading: false });
    const link = segment("Alerts");
    expect(link.querySelector('svg[data-slot="icon"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Alerts")).toBeTruthy();
  });
});

// ===========================================================================
// MetricsSummary
// ===========================================================================

describe("MetricsSummary — per-segment degradation", () => {
  it("omits the segment when not configured", () => {
    renderMetrics({ data: null, freshness: null, error: null, loading: false });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a pending segment while loading with no prior data", () => {
    renderMetrics({ data: null, freshness: null, error: null, loading: true });
    const link = segment("Metrics");
    expect(link.getAttribute("href")).toBe("/monitoring#metrics");
    expect(link.querySelector('[data-freshness="pending"]')).not.toBeNull();
    expect(countOf(link)).toBeNull();
  });

  it("shows the segment with NO count and an unreachable freshness on error with no last-known-good", () => {
    renderMetrics({ data: null, freshness: unreachable, error: null, loading: false });
    const link = segment("Metrics");
    expect(link.getAttribute("href")).toBe("/monitoring#metrics");
    expect(link.querySelector('[data-freshness="unreachable"]')).not.toBeNull();
    expect(countOf(link)).toBeNull();
  });

  it("shows an explicit all-clear with breachCount 0 when summaries are empty", () => {
    renderMetrics({ data: { summaries: [] }, freshness: fresh, error: null, loading: false });
    const link = segment("Metrics");
    expect(link.getAttribute("data-health-status")).toBe("ok");
    expect(countOf(link)).toBe("0");
  });
});

describe("MetricsSummary — rollup derivation", () => {
  it("rolls up a critical breach to critical with count = breachCount", () => {
    const data: PrometheusResult = {
      summaries: [
        { id: "cpu", label: "CPU", value: 99, status: "critical" },
        { id: "mem", label: "Mem", value: 80, status: "warning" },
        { id: "ok", label: "OK", value: 1, status: "ok" },
      ],
    };
    renderMetrics({ data, freshness: fresh, error: null, loading: false });
    const link = segment("Metrics");
    expect(link.getAttribute("data-health-status")).toBe("critical");
    expect(countOf(link)).toBe("2");
  });

  it("does NOT surface errorCount — an errored summary keeps status ok and count 0", () => {
    const data: PrometheusResult = {
      summaries: [
        { id: "err", label: "Err", value: null, status: "error" },
        { id: "n", label: "Neutral", value: 3, status: "neutral" },
      ],
    };
    renderMetrics({ data, freshness: fresh, error: null, loading: false });
    const link = segment("Metrics");
    expect(link.getAttribute("data-health-status")).toBe("ok");
    // The single error is not rendered as the count.
    expect(countOf(link)).toBe("0");
  });
});

// ===========================================================================
// Render isolation
// ===========================================================================

describe("SummaryPresentationBoundary — render isolation", () => {
  it("yields the fixed fallback link when a fragment throws during render", () => {
    // A payload whose `firingCount` getter throws forces a throw inside deriveAlertStatus, deep
    // inside the real AlertsSummary content — exercising the actual fragment, not a stand-in.
    const throwing = { alerts: [], silences: [] } as unknown as AlertmanagerResult;
    Object.defineProperty(throwing, "firingCount", {
      get(): never {
        throw new Error("kaboom");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = renderAlerts({ data: throwing, freshness: fresh, error: null, loading: false });

    expect(root.textContent).toContain("Alerts summary unavailable");
    expect(root.textContent).not.toContain("kaboom");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Alerts summary unavailable/ }).getAttribute("href")).toBe(
      "/monitoring#alerts",
    );
  });

  it("isolates a throwing segment from a sibling segment", () => {
    function Boom(): JSX.Element {
      throw new Error("boom");
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <div>
        <SummaryPresentationBoundary segment="metrics" href="/monitoring#metrics">
          <Boom />
        </SummaryPresentationBoundary>
        <SummaryPresentationBoundary segment="alerts" href="/monitoring#alerts">
          <span>sibling survives</span>
        </SummaryPresentationBoundary>
      </div>,
    );
    expect(container.textContent).toContain("Metrics summary unavailable");
    expect(container.textContent).toContain("sibling survives");
    expect(container.textContent).not.toContain("boom");
  });
});
