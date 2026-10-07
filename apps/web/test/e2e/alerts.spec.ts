import { expect, test, type Page, type Route } from "@playwright/test";
import { FIXTURE } from "./inventory-fixture.js";
import { mockUiManifest } from "./ui-manifest.js";

/** The Vite origin under test (see DECK_E2E_WEB_PORT in playwright.config.ts). */
const WEB_ORIGIN = `http://127.0.0.1:${process.env.DECK_E2E_WEB_PORT ?? 4173}`;

/**
 * Browser presentation of the alerts-and-health feature against the real Bun API
 * + Vite harness. Unlike the drift/inventory suites, these scenarios never mutate
 * the shared runtime snapshot: the two feature providers (`prometheus`,
 * `alertmanager`) are not part of the booted inventory fixture, so every alert /
 * metric state is injected with `page.route` and the real 30s poll interval is
 * driven deterministically with `page.clock`. The persistent drift + endpoint
 * header segments and `/api/config` are served by the real app graph (only their
 * config is augmented with invented integrations where a test needs cards).
 *
 * Every identity is invented under the `.invalid` namespace; no estate fact and
 * no credential is copied, and no non-GET request is ever issued.
 */

type JsonObject = Record<string, unknown>;

/** The provider poll cadence the hooks default to (`POLL_DEFAULTS.pollIntervalMs`). */
const POLL_MS = 30_000;

/**
 * Fixed browser clock. Only installed for the re-poll scenarios; it lets the
 * store's poll interval be advanced explicitly and keeps relative ages stable.
 */
const FIXED_CLOCK = new Date("2035-02-01T12:00:00.000Z");

/** An alert start five minutes before the fixed clock, so its age is deterministic. */
const STARTED_AT = new Date(FIXED_CLOCK.getTime() - 5 * 60_000).toISOString();

/** A silence end one hour after the fixed clock. */
const ENDS_AT = new Date(FIXED_CLOCK.getTime() + 60 * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Health-header segment locators. The shell renders one unconditional
// `[data-slot="health-header"]`; each feature contributes a self-sufficient
// anchor scoped here by its own href.
// ---------------------------------------------------------------------------

const healthHeader = (page: Page) => page.locator('[data-slot="health-header"]');
const alertSegment = (page: Page) => healthHeader(page).locator('a[href="/monitoring#alerts"]');
const metricsSegment = (page: Page) => healthHeader(page).locator('a[href="/monitoring#metrics"]');
const driftSegment = (page: Page) => healthHeader(page).locator('a[href="/drift"]');
const endpointSegment = (page: Page) => healthHeader(page).locator('a[href="/"]');

/**
 * Navigate to a fresh app route, retrying the load if the Vite dev server serves
 * a blank shell (an occasional cold-transform miss under CPU contention). The
 * shell banner renders on every successful mount, so it is the readiness signal.
 */
async function gotoApp(page: Page, path: string): Promise<void> {
  await expect(async () => {
    await page.goto(path);
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
}

/** An alert row's source link on /monitoring (its name carries the new-tab note). */
const alertLink = (page: Page, name: string) =>
  page.locator("#alerts").getByRole("link", { name: `${name} (opens in new tab)` });

/** An integration tile on /monitoring: one link named by its title. */
const integrationTile = (page: Page, title: string) =>
  page.locator("#integrations").getByRole("link", { name: `${title} (opens in new tab)` });

// ---------------------------------------------------------------------------
// Provider-envelope + payload builders. Each envelope mirrors the real
// `ProviderEnvelope<T>` the generic `/api/providers/:id` route emits.
// ---------------------------------------------------------------------------

/** A freshness stamp for the given state; `pending` carries null observation fields. */
function stamp(state: string, ageMs = 0): JsonObject {
  if (state === "pending") {
    return { state, observedAt: null, ageMs: null, ttlMs: null };
  }
  return { state, observedAt: FIXED_CLOCK.toISOString(), ageMs, ttlMs: POLL_MS };
}

function envelope(id: string, kind: string, data: JsonObject | null, state = "fresh"): JsonObject {
  return { id, kind, freshness: stamp(state), data, error: null };
}

const alertmanagerEnvelope = (data: JsonObject | null, state = "fresh"): JsonObject =>
  envelope("alertmanager", "alertmanager", data, state);

const prometheusEnvelope = (data: JsonObject | null, state = "fresh"): JsonObject =>
  envelope("prometheus", "prometheus", data, state);

/** Two firing alerts (a critical + a warning), both linkable, no suppression. */
function firingAlerts(): JsonObject {
  return {
    firingCount: 2,
    silences: [],
    alerts: [
      {
        fingerprint: "fp-critical",
        name: "HighErrorRate",
        severity: "critical",
        startsAt: STARTED_AT,
        suppressed: false,
        sourceUrl: "https://alerts.example.invalid/critical",
      },
      {
        fingerprint: "fp-warning",
        name: "DiskFilling",
        severity: "warning",
        startsAt: STARTED_AT,
        suppressed: false,
        sourceUrl: "https://alerts.example.invalid/warning",
      },
    ],
  };
}

/** One firing alert plus one suppressed alert and the active silence covering it. */
function silencedAlerts(): JsonObject {
  return {
    firingCount: 1,
    silences: [{ id: "silence-1", endsAt: ENDS_AT, matchers: 'alertname="NoisyAlert"' }],
    alerts: [
      {
        fingerprint: "fp-firing",
        name: "HighErrorRate",
        severity: "critical",
        startsAt: STARTED_AT,
        suppressed: false,
        sourceUrl: "https://alerts.example.invalid/firing",
      },
      {
        fingerprint: "fp-suppressed",
        name: "NoisyAlert",
        severity: "warning",
        startsAt: STARTED_AT,
        suppressed: true,
        sourceUrl: null,
      },
    ],
  };
}

/** A reachable Alertmanager with zero alerts — the all-clear population. */
const clearAlerts = (): JsonObject => ({ firingCount: 0, silences: [], alerts: [] });

/** Two labeled summaries: one healthy, one breaching (warning). */
function metricsSummaries(): JsonObject {
  return {
    summaries: [
      { id: "cpu", label: "CPU", unit: "%", value: 12, status: "ok" },
      { id: "mem", label: "Memory", unit: "%", value: 91, status: "warning" },
    ],
  };
}

/** Two healthy summaries — a metrics all-clear population. */
function healthyMetrics(): JsonObject {
  return {
    summaries: [{ id: "cpu", label: "CPU", unit: "%", value: 12, status: "ok" }],
  };
}

// ---------------------------------------------------------------------------
// Route staging. Each provider endpoint is fulfilled from a mutable box so a
// clock-driven re-poll observes the swapped response. A `status` stage fulfils
// an HTTP status (404 → not-configured); a `json` stage fulfils an envelope.
// ---------------------------------------------------------------------------

type Stage = { readonly status: number } | { readonly json: JsonObject };

interface ProviderBox {
  alertmanager: Stage;
  prometheus: Stage;
}

async function fulfilStage(route: Route, stage: Stage): Promise<void> {
  if ("status" in stage) {
    await route.fulfill({ status: stage.status, contentType: "application/json", body: "{}" });
    return;
  }
  await route.fulfill({ json: stage.json });
}

/** Intercept both feature providers, reading each poll's response from `box`. */
async function routeProviders(page: Page, box: { current: ProviderBox }): Promise<void> {
  // The web polls only providers the UI manifest lists. These two are not in the
  // booted fixture, so add them to the real manifest (mirrors mockConfigIntegrations)
  // — otherwise the gated web would never poll them.
  await mockUiManifest(page, (providers) => [
    ...providers,
    { id: "alertmanager", kind: "alertmanager" },
    { id: "prometheus", kind: "prometheus" },
  ]);
  await page.route("**/api/providers/alertmanager", (route) =>
    fulfilStage(route, box.current.alertmanager),
  );
  await page.route("**/api/providers/prometheus", (route) =>
    fulfilStage(route, box.current.prometheus),
  );
}

/** Augment the real `/api/config` with invented integrations (no credential values). */
async function mockConfigIntegrations(page: Page, integrations: JsonObject[]): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as JsonObject;
    await route.fulfill({ json: { ...config, integrations } });
  });
}

// ===========================================================================
// 1. Persistent shell header on every route (SC-03).
// ===========================================================================

test.describe("persistent health-header", () => {
  test("the header and its alert + metrics segments render on every route", async ({ page }) => {
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(firingAlerts()) },
        prometheus: { json: prometheusEnvelope(metricsSummaries()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);

    for (const path of ["/", "/monitoring", "/drift", `/hosts/${encodeURIComponent(FIXTURE.hostAlpha)}`]) {
      await gotoApp(page, path);
      await expect(healthHeader(page), `header present on ${path}`).toBeVisible();
      await expect(alertSegment(page), `alert segment on ${path}`).toBeVisible();
      await expect(metricsSegment(page), `metrics segment on ${path}`).toBeVisible();
    }
  });
});

// ===========================================================================
// 2. Header nav affordances (SC-11) and the monitoring page in primary nav (SC-12).
// ===========================================================================

test.describe("header navigation and primary nav", () => {
  test.beforeEach(async ({ page }) => {
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(firingAlerts()) },
        prometheus: { json: prometheusEnvelope(metricsSummaries()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
  });

  test("the alert count reaches /monitoring#alerts and scrolls the section into view", async ({
    page,
  }) => {
    await gotoApp(page, "/");
    await expect(alertSegment(page).locator('[data-slot="health-pill-count"]')).toHaveText("2");
    await alertSegment(page).click();
    await expect(page).toHaveURL(/\/monitoring#alerts$/);
    const alerts = page.locator("#alerts");
    await expect(alerts).toBeVisible();
    await expect(alerts).toBeInViewport();
  });

  test("the drift count reaches /drift and the endpoint count reaches /", async ({ page }) => {
    await gotoApp(page, "/monitoring");
    // The sibling drift segment (real snapshot provider) owns /drift.
    await expect(driftSegment(page)).toBeVisible();
    await driftSegment(page).click();
    await expect(page).toHaveURL(/\/drift$/);

    // The sibling endpoint segment (portal) owns the root href.
    await gotoApp(page, "/monitoring");
    await expect(endpointSegment(page)).toBeVisible();
    await endpointSegment(page).click();
    await expect(page).toHaveURL(new RegExp(`^${WEB_ORIGIN.replace(/\./g, "\\.")}/$`));
  });

  test("/monitoring is in the primary nav and #metrics scrolls into view on entry", async ({
    page,
  }) => {
    await gotoApp(page, "/");
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Monitoring", exact: true })
      .click();
    await expect(page).toHaveURL(/\/monitoring$/);
    await expect(page.getByTestId("monitoring")).toBeVisible();

    // Direct entry to a hash target scrolls that section into view.
    await gotoApp(page, "/monitoring#metrics");
    const metrics = page.locator("#metrics");
    await expect(metrics).toBeVisible();
    await expect(metrics).toBeInViewport();
  });
});

// ===========================================================================
// 3. States via route mocks + clock: re-poll, freshness flip, last-known-good
//    on unreachable (never a fabricated 0), and silenced/suppressed (SC-06/SC-07).
// ===========================================================================

test.describe("provider states and deterministic re-poll", () => {
  test("the alert segment re-polls, flips freshness, and retains last-known-good", async ({
    page,
  }) => {
    await page.clock.install({ time: FIXED_CLOCK });
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(firingAlerts()) },
        prometheus: { json: prometheusEnvelope(healthyMetrics()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await gotoApp(page, "/");

    const count = alertSegment(page).locator('[data-slot="health-pill-count"]');
    // Firing: count 2, critical, fresh.
    await expect(count).toHaveText("2");
    await expect(alertSegment(page)).toHaveAttribute("data-health-status", "critical");
    await expect(alertSegment(page).locator('[data-freshness="fresh"]')).toBeVisible();

    // Unreachable poll retaining last-known-good: the count stays 2 (never a fake
    // 0) and the chip flips to unreachable.
    box.current.alertmanager = { json: alertmanagerEnvelope(firingAlerts(), "unreachable") };
    await page.clock.fastForward(POLL_MS);
    await expect(alertSegment(page).locator('[data-freshness="unreachable"]')).toBeVisible();
    await expect(count).toHaveText("2");

    // A later all-clear generation re-polls to a genuine 0 with a fresh chip.
    box.current.alertmanager = { json: alertmanagerEnvelope(clearAlerts()) };
    await page.clock.fastForward(POLL_MS);
    await expect(count).toHaveText("0");
    await expect(alertSegment(page).locator('[data-freshness="fresh"]')).toBeVisible();
  });

  test("silenced alerts render suppressed and read-only silences on the page", async ({ page }) => {
    await page.clock.install({ time: FIXED_CLOCK });
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(silencedAlerts()) },
        prometheus: { json: prometheusEnvelope(healthyMetrics()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await gotoApp(page, "/monitoring");

    const alerts = page.locator("#alerts");
    await expect(alerts).toHaveAttribute("data-state", "active");
    // Firing count in the header excludes the suppressed alert.
    await expect(alertSegment(page).locator('[data-slot="health-pill-count"]')).toHaveText("1");
    // Suppressed alert lives only in its own group, marked "Suppressed" (icon + text).
    const suppressed = alerts.getByRole("region", { name: "Suppressed alerts" });
    await expect(suppressed.getByRole("listitem")).toHaveCount(1);
    await expect(suppressed.getByRole("listitem")).toContainText("NoisyAlert");
    await expect(suppressed.getByRole("listitem")).toContainText("Suppressed");
    await expect(alerts.getByRole("region", { name: "Critical alerts" })).not.toContainText(
      "NoisyAlert",
    );
    // Silences are read-only: no edit control anywhere in the list.
    const silences = alerts.getByRole("region", { name: "Silences (read-only)" });
    await expect(silences.getByText('alertname="NoisyAlert"')).toBeVisible();
    await expect(silences.locator("button, input, [contenteditable]")).toHaveCount(0);
  });

  test("an errored summary shows an explicit No-data row, never a fabricated 0", async ({
    page,
  }) => {
    await page.clock.install({ time: FIXED_CLOCK });
    const erroredMetrics: JsonObject = {
      summaries: [{ id: "cpu", label: "CPU", unit: "%", value: null, status: "error" }],
    };
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(clearAlerts()) },
        prometheus: { json: prometheusEnvelope(erroredMetrics) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await gotoApp(page, "/monitoring");

    const row = page
      .locator("#metrics")
      .getByRole("list", { name: "Metric summaries" })
      .getByRole("listitem")
      .filter({ hasText: "CPU" });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("No data")).toBeVisible();
    await expect(row).not.toContainText(/\b0\b/);
  });
});

// ===========================================================================
// 4. Per-segment degradation (SC-04).
// ===========================================================================

test.describe("per-segment header degradation", () => {
  test("alertmanager not-configured omits the alert segment while metrics render", async ({
    page,
  }) => {
    const box = {
      current: {
        alertmanager: { status: 404 },
        prometheus: { json: prometheusEnvelope(metricsSummaries()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await gotoApp(page, "/");

    // The header itself always renders (its sibling fragments still contribute).
    await expect(healthHeader(page)).toBeVisible();
    await expect(metricsSegment(page)).toBeVisible();
    await expect(alertSegment(page)).toHaveCount(0);
  });

  test("the header still renders when both feature segments are not-configured", async ({
    page,
  }) => {
    const box = {
      current: {
        alertmanager: { status: 404 },
        prometheus: { status: 404 },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await gotoApp(page, "/");

    await expect(healthHeader(page)).toBeVisible();
    await expect(alertSegment(page)).toHaveCount(0);
    await expect(metricsSegment(page)).toHaveCount(0);
    // A sibling fragment (drift) still renders inside the same header region.
    await expect(driftSegment(page)).toBeVisible();
  });
});

// ===========================================================================
// 5. Keyboard navigation + visible focus (REQ-A11Y-03).
// ===========================================================================

test.describe("keyboard navigation and focus", () => {
  // Deep links point at the harness origin so an activated new tab commits to a
  // real, loadable URL (a `.invalid` host would resolve to a chrome-error page and
  // make the popup URL non-deterministic). The path is an unrouted SPA path — the
  // dev server still returns index.html with a 200.
  const GRAFANA_DEEP_LINK = `${WEB_ORIGIN}/integrations/grafana-board`;
  const INTEGRATIONS: JsonObject[] = [
    {
      id: "integ-grafana",
      kind: "grafana",
      title: "Grafana",
      baseUrl: `${WEB_ORIGIN}/integrations/grafana-home`,
      deepLink: GRAFANA_DEEP_LINK,
    },
    {
      id: "integ-prometheus",
      kind: "prometheus",
      title: "Prometheus",
      baseUrl: `${WEB_ORIGIN}/integrations/prometheus-home`,
    },
  ];

  test("the keyboard machine advances focus across alerts and cards with a visible ring", async ({
    page,
  }) => {
    await page.clock.install({ time: FIXED_CLOCK });
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(firingAlerts()) },
        prometheus: { json: prometheusEnvelope(healthyMetrics()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await mockConfigIntegrations(page, INTEGRATIONS);
    await gotoApp(page, "/monitoring");

    // Nav order: linkable alerts (render order) then integration tiles grouped/sorted
    // by kind (grafana < prometheus).
    const firstAlert = alertLink(page, "HighErrorRate");
    const secondAlert = alertLink(page, "DiskFilling");
    const grafanaCard = integrationTile(page, "Grafana");
    const promCard = integrationTile(page, "Prometheus");
    await expect(firstAlert).toBeVisible();
    await expect(grafanaCard).toBeVisible();

    // First move focuses the first navigable id; the keydown listener attaches in a
    // mount effect that can land a frame late, so retry until it is live.
    await expect(async () => {
      await page.keyboard.press("j");
      await expect(firstAlert).toBeFocused({ timeout: 1000 });
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });

    // Keyboard focus shows the visible (UA) focus ring via :focus-visible.
    await expect
      .poll(() => firstAlert.evaluate((el) => el.matches(":focus-visible")))
      .toBe(true);

    await page.keyboard.press("j");
    await expect(secondAlert).toBeFocused();
    await page.keyboard.press("j");
    await expect(grafanaCard).toBeFocused();
    await page.keyboard.press("j");
    await expect(promCard).toBeFocused();

    // End jumps to the last id; Home returns to the first.
    await page.keyboard.press("Home");
    await expect(firstAlert).toBeFocused();
    await page.keyboard.press("End");
    await expect(promCard).toBeFocused();

    // ArrowUp moves to the previous id.
    await page.keyboard.press("ArrowUp");
    await expect(grafanaCard).toBeFocused();
  });

  test("Enter activates the focused card's deep link in a new tab", async ({ page }) => {
    await page.clock.install({ time: FIXED_CLOCK });
    const box = {
      current: {
        alertmanager: { json: alertmanagerEnvelope(firingAlerts()) },
        prometheus: { json: prometheusEnvelope(healthyMetrics()) },
      } satisfies ProviderBox,
    };
    await routeProviders(page, box);
    await mockConfigIntegrations(page, INTEGRATIONS);
    await gotoApp(page, "/monitoring");

    const grafanaCard = integrationTile(page, "Grafana");
    await expect(grafanaCard).toBeVisible();
    // Config (integrations) and the alert feed resolve independently; wait for the
    // alerts too, or an early "j" lands on the grafana card before they render.
    await expect(alertLink(page, "HighErrorRate")).toBeVisible();

    // Focus the first integration card: two alerts then the grafana card.
    await expect(async () => {
      await page.keyboard.press("j");
      await expect(alertLink(page, "HighErrorRate")).toBeFocused({ timeout: 1000 });
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await expect(grafanaCard).toBeFocused();

    // Enter activates the focused anchor, opening its deep link in a new tab.
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.keyboard.press("Enter"),
    ]);
    expect(popup.url()).toBe(GRAFANA_DEEP_LINK);
    await popup.close();
  });
});
