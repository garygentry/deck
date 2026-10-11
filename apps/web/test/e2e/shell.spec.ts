import type { UiManifest } from "@deck/module-sdk";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE } from "./inventory-fixture.js";

/**
 * The shell renders from the UI manifest (`GET /api/ui`): the brand, the sidebar's groups,
 * their order and labels, and the top bar's slots. The real manifest is rewritten in flight
 * to show the shell follows it rather than the web's own registrations.
 */

async function rewriteUiManifest(page: Page, rewrite: (body: UiManifest) => UiManifest): Promise<void> {
  await page.route("**/api/ui", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: rewrite((await response.json()) as UiManifest) });
  });
}

const groupLabels = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).locator('[data-sidebar="group-label"]').allTextContents();

test("the brand is the estate's name, in the sidebar and the document title", async ({ page }) => {
  await page.goto("/hosts");
  await expect(page.getByRole("link", { name: FIXTURE.estateName, exact: true })).toHaveAttribute("href", "/");
  await expect(page).toHaveTitle(`Hosts · ${FIXTURE.estateName}`);
});

test("the sidebar lists the manifest's groups and entries, in its order and with its labels", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Portal", exact: true })).toBeVisible();
  expect(await groupLabels(page)).toEqual(["Overview", "Inventory", "Health", "Operate", "Knowledge"]);

  await rewriteUiManifest(page, (body) => ({
    ...body,
    navGroups: [...body.navGroups].reverse().map((group) => (group.id === "inventory" ? { ...group, label: "Estate" } : group)),
    nav: body.nav.map((item) => (item.id === "nav:inventory/hosts" ? { ...item, label: "Machines" } : item)),
  }));
  await page.reload();
  await expect(nav.getByRole("link", { name: "Machines", exact: true })).toHaveAttribute("href", "/hosts");
  expect(await groupLabels(page)).toEqual(["Knowledge", "Operate", "Health", "Estate", "Overview"]);
});

test("the top bar renders the manifest's actions slot", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Theme: / })).toBeVisible();

  await rewriteUiManifest(page, (body) => ({
    ...body,
    extensions: body.extensions.filter((entry) => entry.id !== "action:core/theme-menu"),
  }));
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Portal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Theme: / })).toHaveCount(0);
});
