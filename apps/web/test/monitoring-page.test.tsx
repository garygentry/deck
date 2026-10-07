// @vitest-environment jsdom
import type { DeckConfig, FreshnessStamp } from "@deck/server";
import type { Integration } from "@deck/schema";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlertsSection,
  groupBySeverity,
} from "../src/features/alerts-and-health/AlertsSection.js";
import {
  MetricsSection,
  summaryPageStatus,
} from "../src/features/alerts-and-health/MetricsSection.js";
import type {
  ActiveAlert,
  ActiveSilence,
  AlertmanagerData,
} from "../src/features/alerts-and-health/useAlertmanagerData.js";
import type {
  PrometheusData,
  SummaryValue,
} from "../src/features/alerts-and-health/usePrometheusData.js";
import type { ConfigState } from "../src/shell/use-config.js";

// The page sources its data through three hooks. Mocking them yields deterministic flattened views with
// no poll/timer lifecycle. The prop-driven section tests below never call the hooks, so the mocks are
// inert there; only the MonitoringPage tests exercise them.
let alertView: AlertmanagerData;
vi.mock("../src/features/alerts-and-health/useAlertmanagerData.js", () => ({
  useAlertmanagerData: () => alertView,
}));
let promView: PrometheusData;
vi.mock("../src/features/alerts-and-health/usePrometheusData.js", () => ({
  usePrometheusData: () => promView,
}));
let configState: ConfigState;
vi.mock("../src/shell/use-config.js", () => ({
  useConfig: () => configState,
}));

// eslint-disable-next-line import/first
import { MonitoringPage } from "../src/features/alerts-and-health/MonitoringPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

// ---------------------------------------------------------------------------
// Fixtures — invented and deterministic.
// ---------------------------------------------------------------------------

const FRESH: FreshnessStamp = { state: "fresh", observedAt: null, ageMs: 1000, ttlMs: 30000 };
const UNREACHABLE: FreshnessStamp = {
  state: "unreachable",
  observedAt: null,
  ageMs: 90000,
  ttlMs: 30000,
};

function alert(overrides: Partial<ActiveAlert> & Pick<ActiveAlert, "fingerprint">): ActiveAlert {
  return {
    name: `alert-${overrides.fingerprint}`,
    severity: "warning",
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    suppressed: false,
    sourceUrl: null,
    ...overrides,
  };
}

function summary(overrides: Partial<SummaryValue> & Pick<SummaryValue, "id">): SummaryValue {
  return {
    label: `label-${overrides.id}`,
    value: 42,
    status: "ok",
    ...overrides,
  };
}

function activeAlerts(alerts: ActiveAlert[], silences: ActiveSilence[] = []): AlertmanagerData {
  return {
    data: { alerts, silences, firingCount: alerts.filter((a) => !a.suppressed).length },
    freshness: FRESH,
    error: null,
    loading: false,
  };
}

const alertsRegion = (): HTMLElement => screen.getByRole("region", { name: "Alerts" });
const metricsRegion = (): HTMLElement => screen.getByRole("region", { name: "Metrics" });

// --- groupBySeverity (pure) -------------------------------------------------

describe("groupBySeverity", () => {
  it("orders groups critical → warning → info → Other, dropping empty buckets", () => {
    const groups = groupBySeverity([
      alert({ fingerprint: "w", severity: "warning" }),
      alert({ fingerprint: "c", severity: "critical" }),
      alert({ fingerprint: "i", severity: "info" }),
      alert({ fingerprint: "z", severity: "zebra" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["critical", "warning", "info", "Other"]);
  });

  it("collects unknown/empty severities into a single alphabetically-sorted Other bucket", () => {
    const groups = groupBySeverity([
      alert({ fingerprint: "b", severity: "beta" }),
      alert({ fingerprint: "a", severity: "alpha" }),
      alert({ fingerprint: "e", severity: "" }),
    ]);
    const other = groups.find((g) => g.key === "Other");
    expect(other).toBeDefined();
    // "" < "alpha" < "beta"
    expect(other?.alerts.map((a) => a.fingerprint)).toEqual(["e", "a", "b"]);
  });

  it("excludes suppressed alerts from firing groups and never throws on unknown severity", () => {
    const groups = groupBySeverity([
      alert({ fingerprint: "s", severity: "critical", suppressed: true }),
      alert({ fingerprint: "f", severity: "critical" }),
    ]);
    const crit = groups.find((g) => g.key === "critical");
    expect(crit?.alerts.map((a) => a.fingerprint)).toEqual(["f"]);
  });
});

// --- AlertsSection rendering ------------------------------------------------

describe("AlertsSection", () => {
  it("renders a loading placeholder before the first poll resolves", () => {
    render(<AlertsSection view={{ data: null, freshness: null, error: null, loading: true }} />);
    expect(screen.getByRole("status", { name: "Loading alerts…" })).toBeTruthy();
    expect(alertsRegion().hasAttribute("data-state")).toBe(false);
  });

  it("distinguishes not-configured and all-clear as distinct states", () => {
    const { unmount } = render(
      <AlertsSection view={{ data: null, freshness: null, error: null, loading: false }} />,
    );
    expect(alertsRegion().getAttribute("data-state")).toBe("not-configured");
    expect(within(alertsRegion()).getByRole("status").textContent).toContain(
      "Alertmanager not configured.",
    );
    expect(within(alertsRegion()).queryByText(/no active alerts/)).toBeNull();
    unmount();

    render(<AlertsSection view={activeAlerts([])} />);
    expect(alertsRegion().getAttribute("data-state")).toBe("all-clear");
    const status = within(alertsRegion()).getByRole("status");
    expect(status.textContent).toContain("Healthy — no active alerts.");
    expect(within(status).getByText("Fresh")).toBeTruthy();
    expect(within(alertsRegion()).queryByText(/not configured/)).toBeNull();
  });

  it("renders an error state with text and freshness without leaking the server message", () => {
    render(
      <AlertsSection
        view={{
          data: null,
          freshness: UNREACHABLE,
          error: { message: "boom-secret-detail" },
          loading: false,
        }}
      />,
    );
    expect(alertsRegion().getAttribute("data-state")).toBe("error");
    const status = within(alertsRegion()).getByRole("status");
    expect(status.textContent).toContain("Error — Alertmanager unreachable.");
    expect(within(status).getByText("Unreachable")).toBeTruthy();
    expect(alertsRegion().textContent).not.toContain("boom-secret-detail");
  });

  it("groups firing alerts by severity and puts suppressed alerts only in their own group", () => {
    render(
      <AlertsSection
        view={activeAlerts([
          alert({ fingerprint: "c", severity: "critical" }),
          alert({ fingerprint: "w", severity: "warning" }),
          alert({ fingerprint: "s", severity: "critical", suppressed: true }),
        ])}
      />,
    );

    expect(alertsRegion().getAttribute("data-state")).toBe("active");
    const groups = within(alertsRegion())
      .getAllByRole("region")
      .map((g) => g.querySelector("h3")?.textContent);
    expect(groups).toEqual(["Critical alerts", "Warning alerts", "Suppressed alerts"]);

    const critical = screen.getByRole("region", { name: "Critical alerts" });
    expect(within(critical).getByText("alert-c")).toBeTruthy();
    expect(within(critical).getAllByText("Critical").length).toBeGreaterThan(0);
    expect(within(critical).queryByText("alert-s")).toBeNull();

    const suppressed = screen.getByRole("region", { name: "Suppressed alerts" });
    expect(within(suppressed).getAllByRole("listitem")).toHaveLength(1);
    expect(within(suppressed).getByText("alert-s")).toBeTruthy();
    // Marked as suppressed (icon + text), not by its severity.
    expect(within(suppressed).getAllByText("Suppressed", { selector: "li span" }).length).toBeGreaterThan(0);
  });

  it("renders a sourceUrl alert as a new-tab link and a null one as display-only text", () => {
    render(
      <AlertsSection
        view={activeAlerts([
          alert({ fingerprint: "linked", severity: "critical", sourceUrl: "https://src.example/x" }),
          alert({ fingerprint: "plain", severity: "critical", sourceUrl: null }),
        ])}
      />,
    );

    const link = screen.getByRole("link", { name: "alert-linked (opens in new tab)" });
    expect(link.getAttribute("href")).toBe("https://src.example/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // The display-only alert renders its name, but no link.
    expect(screen.getByText("alert-plain")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    // The start time is a machine-readable <time>.
    expect(within(link.closest("li")!).getByText("1m ago").tagName).toBe("TIME");
  });

  it("labels an unrecognized severity with its own value", () => {
    render(<AlertsSection view={activeAlerts([alert({ fingerprint: "z", severity: "zebra" })])} />);
    const other = screen.getByRole("region", { name: "Other alerts" });
    expect(within(other).getAllByText("zebra").length).toBeGreaterThan(0);
  });

  it("renders silences read-only with no edit affordance", () => {
    const silences: ActiveSilence[] = [
      { id: "sil-1", endsAt: new Date(Date.now() + 3_600_000).toISOString(), matchers: "job=~api" },
    ];
    render(<AlertsSection view={activeAlerts([], silences)} />);

    expect(alertsRegion().getAttribute("data-state")).toBe("active");
    const list = screen.getByRole("region", { name: "Silences (read-only)" });
    expect(within(list).getByText("sil-1")).toBeTruthy();
    expect(within(list).getByText("job=~api")).toBeTruthy();
    expect(within(list).getByText(/^in (59m|1h)$/)).toBeTruthy();
    // No edit/expire controls.
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(within(list).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(list).queryAllByRole("link")).toHaveLength(0);
  });
});

// --- summaryPageStatus (pure) ----------------------------------------------

describe("summaryPageStatus", () => {
  it("maps SummaryStatus onto the page vocabulary, with neutral → null", () => {
    expect(summaryPageStatus("ok")).toBe("healthy");
    expect(summaryPageStatus("warning")).toBe("warning");
    expect(summaryPageStatus("critical")).toBe("critical");
    expect(summaryPageStatus("error")).toBe("error");
    expect(summaryPageStatus("neutral")).toBeNull();
  });
});

// --- MetricsSection rendering -----------------------------------------------

describe("MetricsSection", () => {
  it("distinguishes not-configured and all-clear as distinct states", () => {
    const { unmount } = render(
      <MetricsSection view={{ data: null, freshness: null, error: null, loading: false }} />,
    );
    expect(metricsRegion().getAttribute("data-state")).toBe("not-configured");
    expect(within(metricsRegion()).getByRole("status").textContent).toContain(
      "Prometheus not configured.",
    );
    unmount();

    render(
      <MetricsSection
        view={{ data: { summaries: [] }, freshness: FRESH, error: null, loading: false }}
      />,
    );
    expect(metricsRegion().getAttribute("data-state")).toBe("all-clear");
    expect(within(metricsRegion()).getByRole("status").textContent).toContain(
      "Healthy — no summaries declared.",
    );
  });

  it("renders an errored/no-data summary as an explicit No data state, never 0 and never healthy", () => {
    render(
      <MetricsSection
        view={{
          data: {
            summaries: [
              summary({ id: "err", status: "error", value: null }),
              summary({ id: "nullval", status: "ok", value: null }),
            ],
          },
          freshness: FRESH,
          error: null,
          loading: false,
        }}
      />,
    );

    const rows = within(screen.getByRole("list", { name: "Metric summaries" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getByText("No data")).toBeTruthy();
      expect(within(row).queryByText("Healthy")).toBeNull();
      expect(row.textContent).not.toMatch(/\b0\b/);
    }
  });

  it("renders a neutral summary as a bare value with no status", () => {
    render(
      <MetricsSection
        view={{
          data: { summaries: [summary({ id: "n", status: "neutral", value: 7, unit: "ms" })] },
          freshness: FRESH,
          error: null,
          loading: false,
        }}
      />,
    );
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("label-n")).toBeTruthy();
    expect(within(row).getByText("7ms")).toBeTruthy();
    for (const label of ["Healthy", "Warning", "Critical", "Error", "No data"]) {
      expect(within(row).queryByText(label)).toBeNull();
    }
  });

  it("renders a thresholded summary's status as icon + text", () => {
    render(
      <MetricsSection
        view={{
          data: { summaries: [summary({ id: "w", status: "warning", value: 88, unit: "%" })] },
          freshness: FRESH,
          error: null,
          loading: false,
        }}
      />,
    );
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("88%")).toBeTruthy();
    const badge = within(row).getByText("Warning").parentElement!;
    expect(badge.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("renders an error state with freshness without leaking the server message", () => {
    render(
      <MetricsSection
        view={{
          data: null,
          freshness: UNREACHABLE,
          error: { message: "prom-secret-detail" },
          loading: false,
        }}
      />,
    );
    expect(metricsRegion().getAttribute("data-state")).toBe("error");
    expect(within(metricsRegion()).getByRole("status").textContent).toContain(
      "Error — Prometheus unreachable.",
    );
    expect(metricsRegion().textContent).not.toContain("prom-secret-detail");
  });
});

// ---------------------------------------------------------------------------
// MonitoringPage — hooks mocked, so each section receives a deterministic view
// and resolves independently of the others.
// ---------------------------------------------------------------------------

function integration(overrides: Partial<Integration> & Pick<Integration, "id" | "kind">): Integration {
  return {
    title: `title-${overrides.id}`,
    baseUrl: `https://${overrides.id}.invalid`,
    ...overrides,
  };
}

function readyConfig(integrations: Integration[]): ConfigState {
  return { status: "ready", config: { integrations } as unknown as DeckConfig };
}

describe("MonitoringPage — composition", () => {
  it("resolves each section independently — Alertmanager unreachable, metrics + integrations still render", () => {
    alertView = {
      data: null,
      freshness: UNREACHABLE,
      error: { message: "am-secret-detail" },
      loading: false,
    };
    promView = {
      data: { summaries: [summary({ id: "cpu", label: "CPU", value: 12, unit: "%" })] },
      freshness: FRESH,
      error: null,
      loading: false,
    };
    configState = readyConfig([integration({ id: "prom-1", kind: "prometheus", title: "Prometheus" })]);

    render(<MonitoringPage />);

    const page = screen.getByTestId("monitoring");
    expect(page.getAttribute("data-slot")).toBe("monitoring-page");
    expect(screen.getByRole("heading", { level: 1, name: "Monitoring" })).toBeTruthy();
    // Alerts in its error state (never blocks siblings), without leaking the message.
    expect(alertsRegion().id).toBe("alerts");
    expect(alertsRegion().getAttribute("data-state")).toBe("error");
    expect(page.textContent).not.toContain("am-secret-detail");
    // Metrics resolved independently from its own fresh view.
    expect(metricsRegion().id).toBe("metrics");
    expect(within(metricsRegion()).getByText("CPU")).toBeTruthy();
    // Integrations resolved independently.
    const integrations = screen.getByRole("region", { name: "Integrations" });
    expect(within(integrations).getByRole("link", { name: /^Prometheus/ })).toBeTruthy();
  });
});

describe("MonitoringPage — keyboard navigation", () => {
  function mountNavigable(): void {
    alertView = activeAlerts([
      // Supplied out of severity order: warning, then critical, then a display-only alert and a
      // linkable suppressed one.
      alert({ fingerprint: "w", name: "Warn", severity: "warning", sourceUrl: "https://a.invalid/w" }),
      alert({ fingerprint: "c", name: "Crit", severity: "critical", sourceUrl: "https://a.invalid/c" }),
      alert({ fingerprint: "n", name: "NoLink", severity: "critical", sourceUrl: null }),
      alert({
        fingerprint: "s",
        name: "Quiet",
        severity: "critical",
        suppressed: true,
        sourceUrl: "https://a.invalid/s",
      }),
    ]);
    promView = { data: { summaries: [] }, freshness: FRESH, error: null, loading: false };
    configState = readyConfig([
      integration({ id: "z", kind: "zeta", title: "Zed" }),
      integration({ id: "a", kind: "alpha", title: "Alf" }),
    ]);
    render(
      <>
        <input aria-label="Elsewhere" />
        <MonitoringPage />
      </>,
    );
  }

  const link = (name: string): HTMLElement =>
    screen.getByRole("link", { name: new RegExp(`^${name}`) });
  const press = (key: string): void => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  };

  it("moves focus over linkable alerts (render order) then integration tiles (kind order)", () => {
    mountNavigable();
    const order = ["Crit", "Warn", "Quiet", "Alf", "Zed"];
    press("j");
    expect(document.activeElement).toBe(link(order[0]!));
    for (const name of order.slice(1)) {
      press("j");
      expect(document.activeElement).toBe(link(name));
    }
    press("j"); // clamps at the end
    expect(document.activeElement).toBe(link("Zed"));
    press("k");
    expect(document.activeElement).toBe(link("Alf"));
    press("Home");
    expect(document.activeElement).toBe(link("Crit"));
    press("End");
    expect(document.activeElement).toBe(link("Zed"));
    press("g");
    press("g");
    expect(document.activeElement).toBe(link("Crit"));
    press("G");
    expect(document.activeElement).toBe(link("Zed"));
  });

  it("Enter activates the focused link", () => {
    mountNavigable();
    press("j");
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link("Crit").addEventListener("click", clicked);
    press("Enter");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed into an editable control", () => {
    mountNavigable();
    const input = screen.getByRole("textbox", { name: "Elsewhere" });
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    expect(document.activeElement).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Scroll-into-view on route entry: the router matches on pathname only, so the
// page scrolls the #alerts / #metrics section into view itself.
// ---------------------------------------------------------------------------

describe("MonitoringPage — scroll-to-hash on entry", () => {
  function mountWithHash(hash: string): string[] {
    window.history.replaceState(null, "", `/monitoring${hash}`);
    // Run the one-frame defer synchronously.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this.id);
    });

    alertView = { data: null, freshness: FRESH, error: null, loading: false };
    promView = { data: { summaries: [] }, freshness: FRESH, error: null, loading: false };
    configState = readyConfig([]);
    act(() => {
      render(<MonitoringPage />);
    });
    return scrolled;
  }

  // jsdom has no layout, so scrollIntoView is absent until stubbed.
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }

  it("scrolls #alerts into view when entering /monitoring#alerts", () => {
    expect(mountWithHash("#alerts")).toEqual(["alerts"]);
  });

  it("scrolls #metrics into view when entering /monitoring#metrics", () => {
    expect(mountWithHash("#metrics")).toEqual(["metrics"]);
  });

  it("scrolls nothing when there is no URL fragment", () => {
    expect(mountWithHash("")).toEqual([]);
  });
});
