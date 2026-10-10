import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";

/**
 * The `ui` config section end to end: a real server whose overlay sets the brand, the home
 * page, the nav and extension overrides (see `spec-api.ts`), and the shell rendering what it
 * serves. The shared E2E API sets no `ui`, so it keeps the portal as home and every pill.
 */

const UI = {
  brand: { title: "E2E Lab", icon: "server" },
  home: "page:inventory/hosts",
  nav: {
    groups: [{ id: "overview" }, { id: "lab", label: "Lab", icon: "boxes" }],
    items: [
      { id: "nav:ui/grafana", group: "lab", label: "Grafana", href: "https://grafana.example.net", icon: "gauge", order: 1 },
      { id: "nav:ui/rule", group: "lab", separator: true, order: 50 },
    ],
  },
  extensions: {
    "pill:drift/summary": false,
    "nav:inventory/services": { attachTo: { group: "lab", order: 100 } },
  },
};

const primaryNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const healthHeader = (page: Page) => page.locator('[data-slot="health-header"]');
/** The sidebar group headed `label`. */
const navGroup = (page: Page, label: string) =>
  primaryNav(page).locator('[data-slot="sidebar-group"]', { has: page.locator('[data-slot="sidebar-group-label"]', { hasText: label }) });

test.describe("ui config (brand, home, nav, overrides)", () => {
  let api: SpecApi;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    api = await startSpecApi("ui-config", { DECK_E2E_UI: JSON.stringify(UI) });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
  });

  test("the brand's title and icon show in the sidebar and the document title", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.goto("/services");
    const brand = page.getByRole("link", { name: UI.brand.title, exact: true });
    await expect(brand).toHaveAttribute("href", "/", { timeout: 15_000 });
    await expect(brand.locator('[data-brand-mark="icon"] svg')).toBeVisible();
    await expect(page).toHaveTitle(`Services · ${UI.brand.title}`);
  });

  test("/ renders the configured home page, its nav entry links to /, and the portal stays at /portal", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.goto("/");
    const nav = primaryNav(page);
    const hosts = nav.getByRole("link", { name: "Hosts", exact: true });
    await expect(hosts).toHaveAttribute("href", "/", { timeout: 15_000 });
    await expect(hosts).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Hosts"]);
    await expect(page).toHaveTitle(`Hosts · ${UI.brand.title}`);
    // The endpoint pill goes to the portal's own path, not to / (which is Hosts here).
    await expect(page.locator('[data-slot="health-header"] a[href="/portal"]')).toBeVisible();
    await expect(page.locator('[data-slot="health-header"] a[href="/"]')).toHaveCount(0);

    await nav.getByRole("link", { name: "Portal", exact: true }).click();
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Portal"]);
    // The home page's own path keeps its entry current.
    await page.goto("/hosts");
    await expect(hosts).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
  });

  test("overrides hide a header pill, move a nav entry to a config group, and change the home page", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.goto("/");
    // Home: / renders the configured page.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Hosts"], { timeout: 15_000 });

    // The nav entry moved: Services is in the config-defined "Lab" group (after its link and
    // separator), and no longer under Inventory.
    const lab = navGroup(page, "Lab");
    await expect(lab.getByRole("link")).toHaveText(["Grafana (opens in new tab)", "Services"]);
    await expect(lab.locator("[data-nav-separator]")).toHaveCount(1);
    await expect(navGroup(page, "Inventory").getByRole("link")).toHaveText(["Hosts"]);
    // Config groups come first, then the built-ins in their default order.
    await expect(primaryNav(page).locator('[data-slot="sidebar-group-label"]')).toHaveText(["Overview", "Lab", "Inventory", "Health", "Operate", "Knowledge"]);

    // The config link opens in a new tab.
    const grafana = lab.getByRole("link", { name: "Grafana (opens in new tab)" });
    await expect(grafana).toHaveAttribute("href", "https://grafana.example.net");
    await expect(grafana).toHaveAttribute("target", "_blank");
    await expect(grafana).toHaveAttribute("rel", "noopener noreferrer");

    // The pill is hidden; the other pills still render.
    await expect(healthHeader(page).locator("a").first()).toBeVisible({ timeout: 15_000 });
    await expect(healthHeader(page).locator('a[href="/drift"]')).toHaveCount(0);

    await lab.getByRole("link", { name: "Services" }).click();
    await expect(page).toHaveURL(/\/services$/);
    await expect(lab.getByRole("link", { name: "Services" })).toHaveAttribute("aria-current", "page");
  });
});

test("with no ui config (the shared API), the portal is home at / and at /portal, and the drift pill shows", async ({ page }) => {
  await page.goto("/portal");
  const portal = primaryNav(page).getByRole("link", { name: "Portal", exact: true });
  await expect(portal).toHaveAttribute("href", "/", { timeout: 15_000 });
  await expect(portal).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Portal"]);
  await expect(navGroup(page, "Inventory").getByRole("link")).toHaveText(["Hosts", "Services"]);
  await expect(healthHeader(page).locator('a[href="/drift"]')).toHaveCount(1, { timeout: 15_000 });
});
