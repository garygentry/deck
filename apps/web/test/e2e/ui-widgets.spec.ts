import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";
import { seedTheme } from "./theme-seed.js";

/**
 * A dashboard built without code, end to end: an `http-json` integration polls a fixture JSON
 * API, the server evaluates each widget's `select` into the envelope, and every generic widget
 * renders its value, toned by the config's status maps. Also axe, one column below md and, on CI
 * Linux only, a visual baseline of the page per width and theme.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
// Times in the data read against this instant, so the snapshots are stable.
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");
const HIDE_SHELL = 'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

/** What the fixture "UPS" API answers: fixed, so every widget's text is known. */
const UPS = {
  model: "Eaton 5P",
  load_pct: 72,
  battery_pct: 18,
  runtime_s: 5_460,
  input_v: 231.4,
  outlets: [
    { name: "nas-01", watts: 61.5, state: "on" },
    { name: "switch", watts: 14, state: "on" },
    { name: "printer", watts: 0, state: "fault" },
  ],
  services: [
    { name: "media", status: "running", seen: "2026-01-15T11:54:00Z", url: "/hosts" },
    { name: "backup", status: "degraded", seen: "2026-01-15T09:00:00Z" },
    { name: "dns", status: "stopped", seen: "2026-01-14T12:00:00Z" },
  ],
  notes: "**Runbook:** shed the *printer* first. See [hosts](/hosts).",
};

function ui() {
  return {
    statusMaps: {
      load: { rules: [{ lt: 60, tone: "ok" }, { lt: 85, tone: "warn" }, { tone: "danger" }] },
      battery: { rules: [{ lte: 20, tone: "danger" }, { lte: 50, tone: "warn" }, { tone: "ok" }] },
      outlet: { values: { on: "ok", off: "neutral", fault: "danger" } },
      service: { values: { running: "ok", degraded: "warn", stopped: "danger" } },
    },
    pages: [
      {
        id: "power",
        path: "/power",
        title: "Power and services",
        icon: "gauge",
        nav: { group: "lab", label: "Power", order: 0 },
        sections: [
          {
            title: "UPS",
            columns: 3,
            widgets: [
              { id: "load", type: "core/stat", title: "Load", source: "ups", select: "load_pct", options: { format: "percent", statusMap: "load" } },
              { id: "battery", type: "core/meter", title: "Battery", source: "ups", select: "battery_pct", options: { label: "Charge", statusMap: "battery" } },
              { id: "facts", type: "core/key-value", title: "Unit", source: "ups", select: "{model: model, input: input_v}", options: { items: [{ field: "model", label: "Model" }, { field: "input", label: "Input", unit: "V" }] } },
              { id: "summary", type: "core/stat-grid", title: "Summary", source: "ups", span: 3, options: { items: [{ field: "load_pct", label: "Load", format: "percent", statusMap: "load" }, { field: "runtime_s", label: "Runtime", format: "duration" }, { field: "input_v", label: "Input", unit: "V" }] } },
            ],
          },
          {
            title: "Outlets and services",
            columns: 2,
            widgets: [
              { id: "outlets", type: "core/table", title: "Outlets", source: "ups", select: "outlets", options: { columns: [{ field: "name", header: "Outlet" }, { field: "watts", header: "Draw", format: "number", unit: "W", align: "end" }, { field: "state", header: "State", statusMap: "outlet" }] } },
              { id: "services", type: "core/list", title: "Services", source: "ups", select: "services", options: { statusField: "status", statusMap: "service", metaField: "seen", metaFormat: "relative-time", hrefField: "url" } },
              { id: "states", type: "core/status-grid", title: "Outlet states", source: "ups", select: "outlets", options: { statusField: "state", statusMap: "outlet" } },
              { id: "notes", type: "core/markdown", title: "Notes", source: "ups", select: "notes" },
            ],
          },
          {
            title: "Elsewhere",
            columns: 2,
            widgets: [
              { id: "links", type: "core/link-tiles", title: "Shortcuts", options: { links: [{ title: "Hosts", href: "/hosts", icon: "server", description: "Declared and observed" }, { title: "Vendor", href: "https://vendor.example/ups" }] } },
              { id: "pills", type: "core/health-pills", title: "Health", options: { pills: ["pill:drift/summary"] } },
            ],
          },
        ],
      },
    ],
  };
}

const main = (page: Page) => page.locator("main#main");
const region = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });

/** Open the dashboard and wait for its widgets' data. */
async function openPower(page: Page): Promise<void> {
  await page.goto("/power");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Power and services"], { timeout: 15_000 });
  await expect(region(page, "Load")).toContainText("72%", { timeout: 30_000 });
  await expect(region(page, "Outlets").getByRole("table")).toBeVisible({ timeout: 15_000 });
  await expect(main(page).locator("[aria-busy='true']")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("a dashboard of generic widgets over http-json", () => {
  let api: SpecApi;
  let upstream: Server;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    upstream = createServer((request, response) => {
      if (request.url !== "/status.json") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(UPS));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    api = await startSpecApi("ui-widgets", {
      DECK_E2E_UI: JSON.stringify(ui()),
      DECK_E2E_INTEGRATIONS: JSON.stringify([
        { id: "ups", kind: "http-json", title: "UPS", url: `http://127.0.0.1:${port}/status.json`, pollIntervalMs: 2_000, ttlMs: 600_000 },
      ]),
    });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
    await new Promise<void>((resolve) => (upstream === undefined ? resolve() : upstream.close(() => resolve())));
  });

  test("renders every widget from the polled API, toned by the config's status maps", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPower(page);
    // The relabelled nav entry names the page in the sidebar and the tab; the heading is its title.
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Power", exact: true })).toHaveAttribute("href", "/power");
    await expect(page).toHaveTitle(/^Power · /);

    await expect(region(page, "Load").locator('[data-slot="stat-tile"]')).toHaveAttribute("data-tone", "warn");
    const battery = region(page, "Battery").getByRole("meter", { name: "Charge" });
    await expect(battery).toHaveAttribute("aria-valuenow", "18");
    await expect(region(page, "Battery").locator('[data-slot="meter"]')).toHaveAttribute("data-tone", "danger");
    await expect(region(page, "Unit").getByRole("definition")).toHaveText(["Eaton 5P", "231.4 V"]);
    await expect(region(page, "Summary").getByRole("definition")).toHaveText(["72%", "1h 31m", "231.4 V"]);

    const outlets = region(page, "Outlets").getByRole("table", { name: "Outlets" });
    await expect(outlets.getByRole("rowheader")).toHaveText(["nas-01", "switch", "printer"]);
    await expect(outlets.locator('[data-slot="status-badge"][data-tone="danger"]')).toHaveText("fault");

    const services = region(page, "Services").getByRole("list", { name: "Services" });
    await expect(services.getByRole("listitem")).toHaveCount(3);
    await expect(services.getByRole("link", { name: "media" })).toHaveAttribute("href", "/hosts");
    await expect(services.locator('[data-slot="status-badge"]')).toHaveText(["running", "degraded", "stopped"]);

    await expect(region(page, "Outlet states").getByRole("listitem")).toHaveCount(3);
    await expect(region(page, "Notes").locator("strong")).toHaveText("Runbook:");
    await expect(region(page, "Notes").getByRole("link", { name: "hosts" })).toHaveAttribute("href", "/hosts");
    await expect(region(page, "Shortcuts").getByRole("link", { name: /Vendor/ })).toHaveAttribute("target", "_blank");
    await expect(region(page, "Health").locator('[data-slot="health-pill"]')).toHaveCount(1, { timeout: 15_000 });

    // The browser never ran a query: the envelope carries each widget's select result.
    const envelope = await page.evaluate(async () => (await fetch("/api/providers/ups")).json());
    expect(envelope.projections["widget:ui/power.load"]).toEqual({ value: 72 });
  });

  test("an in-app link in a widget routes without a reload", async ({ page }) => {
    await useSpecApi(page, api.port);
    await openPower(page);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await region(page, "Shortcuts").getByRole("link", { name: "Hosts" }).click();
    await expect(page).toHaveURL(/\/hosts$/);
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
  });

  test("is one column below md, with no sideways scroll", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 375, height: 800 });
    await openPower(page);
    const lefts = await main(page).locator('[data-slot="widget"]').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [375, 1280]) {
      test(`has no serious or critical axe violations (${theme}, ${width}px)`, async ({ page }) => {
        await useSpecApi(page, api.port);
        await seedTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await openPower(page);
        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const blocking = violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
        expect(blocking, `axe violations on /power (${theme}, ${width}px)`).toEqual([]);
      });
    }
  }

  test.describe("visual baselines", () => {
    test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

    for (const theme of ["light", "dark"] as const) {
      for (const width of [375, 768, 1280]) {
        test(`${width}px ${theme}`, async ({ page }) => {
          await page.clock.setFixedTime(FROZEN_NOW);
          await useSpecApi(page, api.port);
          await seedTheme(page, theme);
          await page.setViewportSize({ width, height: 900 });
          await openPower(page);
          await page.addStyleTag({ content: HIDE_SHELL });
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`widgets-${width}-${theme}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            // The drift pill reads the estate's live snapshot; its own visuals are covered elsewhere.
            mask: [main(page).locator('[data-slot="health-pills"]')],
          });
        });
      }
    }
  });
});
