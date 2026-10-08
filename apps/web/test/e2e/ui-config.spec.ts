import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";

/**
 * The `ui` config section end to end: a real server whose overlay sets the brand and the home
 * page (see `spec-api.ts`), and the shell rendering what it serves. The shared E2E API sets no
 * `ui`, so it keeps the portal as home.
 */

const UI = { brand: { title: "E2E Lab", icon: "server" }, home: "page:inventory/hosts" };

const primaryNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test.describe("ui config (brand + home)", () => {
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

    await nav.getByRole("link", { name: "Portal", exact: true }).click();
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Portal"]);
    // The home page's own path keeps its entry current.
    await page.goto("/hosts");
    await expect(hosts).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
  });
});

test("with no ui config (the shared API), the portal is home at / and at /portal", async ({ page }) => {
  await page.goto("/portal");
  const portal = primaryNav(page).getByRole("link", { name: "Portal", exact: true });
  await expect(portal).toHaveAttribute("href", "/", { timeout: 15_000 });
  await expect(portal).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Portal"]);
});
