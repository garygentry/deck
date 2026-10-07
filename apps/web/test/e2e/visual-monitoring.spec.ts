import { expect, test, type Page } from "@playwright/test";

/**
 * Visual baselines for `/monitoring` in its main states, independent of the `/_ui`
 * workbench. Like the workbench baselines they are generated and verified on CI
 * Linux only (font rasterisation differs across hosts): locally they are skipped
 * unless UPDATE_VISUALS is set; refresh them in CI with the `update_visuals`
 * workflow_dispatch input.
 *
 * Every provider response and the integration list are routed fixtures, and the
 * browser clock is fixed, so relative times ("started 5m ago", "ends in 1h") and
 * freshness ages render identically on every run. All identities are invented
 * under `.invalid`.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");
const MINUTE = 60_000;

// The shell chrome is sticky (it would overlay a tall capture) and carries live
// data (the health header). Hide it, so the capture is just the page.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

type JsonObject = Record<string, unknown>;
type Stage = { status: number } | { json: JsonObject };

const iso = (offsetMs: number): string => new Date(FROZEN_NOW.getTime() + offsetMs).toISOString();

function envelope(id: string, data: JsonObject | null, state = "fresh", error: string | null = null): Stage {
  return {
    json: {
      id,
      kind: id,
      freshness: { state, observedAt: iso(-MINUTE), ageMs: MINUTE, ttlMs: 30_000 },
      data,
      error: error === null ? null : { message: error },
    },
  };
}

const INTEGRATIONS: JsonObject[] = [
  { id: "am", kind: "alertmanager", title: "Alertmanager", baseUrl: "https://am.example.invalid" },
  { id: "prom", kind: "prometheus", title: "Prometheus", baseUrl: "https://prom.example.invalid" },
  {
    id: "graf",
    kind: "grafana",
    title: "Grafana",
    baseUrl: "https://grafana.example.invalid",
    deepLink: "https://grafana.example.invalid/d/overview",
  },
];

interface Scenario {
  alertmanager: Stage;
  prometheus: Stage;
  integrations: JsonObject[];
  /** The alerts section's settled `data-state`. */
  alertsState: string;
}

const SCENARIOS: Record<string, Scenario> = {
  firing: {
    alertmanager: envelope("alertmanager", {
      firingCount: 3,
      alerts: [
        { fingerprint: "a1", name: "HighErrorRate", severity: "critical", startsAt: iso(-5 * MINUTE), suppressed: false, sourceUrl: "https://am.example.invalid/a1" },
        { fingerprint: "a2", name: "DiskFilling", severity: "warning", startsAt: iso(-42 * MINUTE), suppressed: false, sourceUrl: "https://am.example.invalid/a2" },
        { fingerprint: "a3", name: "CertificateExpiringSoonOnAVeryLongHostnameThatWraps", severity: "page", startsAt: iso(-3 * 60 * MINUTE), suppressed: false, sourceUrl: null },
        { fingerprint: "a4", name: "NoisyAlert", severity: "warning", startsAt: iso(-2 * MINUTE), suppressed: true, sourceUrl: null },
      ],
      silences: [{ id: "4f2c9a1e-silence", endsAt: iso(60 * MINUTE), matchers: 'alertname="NoisyAlert", job=~"node.*"' }],
    }),
    prometheus: envelope("prometheus", {
      summaries: [
        { id: "cpu", label: "CPU", unit: "%", value: 12, status: "ok" },
        { id: "mem", label: "Memory", unit: "%", value: 91, status: "warning" },
        { id: "disk", label: "Disk", unit: "%", value: 97, status: "critical" },
        { id: "up", label: "Targets up", value: 14, status: "neutral" },
        { id: "lat", label: "p95 latency", unit: "ms", value: null, status: "error" },
      ],
    }),
    integrations: INTEGRATIONS,
    alertsState: "active",
  },
  "all-clear": {
    alertmanager: envelope("alertmanager", { firingCount: 0, alerts: [], silences: [] }),
    prometheus: envelope("prometheus", { summaries: [] }),
    integrations: INTEGRATIONS,
    alertsState: "all-clear",
  },
  unreachable: {
    alertmanager: envelope("alertmanager", null, "unreachable", "connect ECONNREFUSED"),
    prometheus: envelope("prometheus", null, "unreachable", "connect ECONNREFUSED"),
    integrations: INTEGRATIONS,
    alertsState: "error",
  },
  "not-configured": {
    alertmanager: { status: 404 },
    prometheus: { status: 404 },
    integrations: [],
    alertsState: "not-configured",
  },
};

async function routeScenario(page: Page, scenario: Scenario): Promise<void> {
  const providers = "json" in scenario.alertmanager || "json" in scenario.prometheus;
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { providers: JsonObject[] };
    const extra = providers
      ? [
          { id: "alertmanager", kind: "alertmanager" },
          { id: "prometheus", kind: "prometheus" },
        ]
      : [];
    await route.fulfill({ json: { providers: [...body.providers, ...extra] } });
  });
  for (const id of ["alertmanager", "prometheus"] as const) {
    const stage = scenario[id];
    await page.route(`**/api/providers/${id}`, (route) =>
      "status" in stage
        ? route.fulfill({ status: stage.status, contentType: "application/json", body: "{}" })
        : route.fulfill({ json: stage.json }),
    );
  }
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as JsonObject;
    await route.fulfill({ json: { ...config, integrations: scenario.integrations } });
  });
}

test.describe("monitoring visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${name} ${width}px ${theme}`, async ({ page }) => {
          await page.clock.setFixedTime(FROZEN_NOW);
          await page.addInitScript((mode) => localStorage.setItem("deck-theme", mode), theme);
          await page.setViewportSize({ width, height: 900 });
          await routeScenario(page, scenario);
          const monitoring = page.getByTestId("monitoring");
          // Retry a load that leaves the shell blank (a cold dev-server transform under load).
          await expect(async () => {
            await page.goto("/monitoring");
            await expect(monitoring).toBeVisible({ timeout: 15_000 });
          }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
          await expect(monitoring.locator("#alerts")).toHaveAttribute("data-state", scenario.alertsState);
          await expect(monitoring.locator("#metrics")).toHaveAttribute("data-state", /.+/);
          await expect(monitoring.locator('#integrations [data-slot="loading-state"]')).toHaveCount(0);
          await page.addStyleTag({ content: HIDE_SHELL });
          await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`monitoring-${name}-${width}-${theme}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
        });
      }
    }
  }
});
