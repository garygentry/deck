import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi as useApi, type SpecApi } from "./spec-api.js";

/**
 * Capability-aware nav against a real server with the actions module OFF. The shared E2E API
 * runs with actions on, so this spec boots its own (the same helper, with
 * DECK_E2E_ACTIONS_ENABLED=false; see `spec-api.ts`) and forwards the page's `/api/*`
 * requests to it. Nothing here is a hand-written manifest: the nav and the not-enabled page
 * come from what that server serves.
 */

const primaryNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test.describe("capability-aware nav (actions off)", () => {
  let api: SpecApi;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    api = await startSpecApi("actions-off", { DECK_E2E_ACTIONS_ENABLED: "false" });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
  });

  test("the nav lists no Actions entry and no Operate group", async ({ page }) => {
    await useApi(page, api.port);
    await page.goto("/");
    const nav = primaryNav(page);
    await expect(nav.getByRole("link", { name: "Portal", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(nav.getByRole("link", { name: "Hosts", exact: true })).toBeVisible();
    await expect(nav.locator('a[href="/actions"]')).toHaveCount(0);
    await expect(nav.locator('[data-sidebar="group-label"]', { hasText: "Operate" })).toHaveCount(0);
  });

  test("a direct hit on /actions says the module is off and names DECK_ACTIONS_ENABLED", async ({ page }) => {
    await useApi(page, api.port);
    await page.goto("/actions");
    const notEnabled = page.locator('[data-slot="module-not-enabled-page"]');
    await expect(notEnabled).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Actions"]);
    await expect(notEnabled.getByRole("status")).toContainText("The actions module is not enabled");
    await expect(notEnabled.getByRole("status")).toContainText("DECK_ACTIONS_ENABLED=true");
    await expect(primaryNav(page).locator('a[href="/actions"]')).toHaveCount(0);
  });
});

test("with actions on (the shared API), the nav lists Actions and /actions renders the page", async ({ page }) => {
  await page.goto("/actions");
  await expect(primaryNav(page).getByRole("link", { name: "Actions", exact: true })).toHaveAttribute("href", "/actions", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Actions", level: 1 })).toBeVisible();
  await expect(page.locator('[data-slot="module-not-enabled-page"]')).toHaveCount(0);
});
