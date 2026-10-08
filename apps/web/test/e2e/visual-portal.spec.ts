import { expect, test, type Page } from "@playwright/test";
import { PORTAL_NOW, routePortalFixture } from "./portal-fixture.js";
import { seedTheme } from "./theme-seed.js";

/**
 * The portal (`/`) on fixed data. The behaviour checks run everywhere. The
 * visual baselines run on CI Linux only, like the workbench's (font rasterising
 * differs across hosts); locally they are skipped unless UPDATE_VISUALS is set.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;

// The shell chrome is sticky (it would overlay a tall capture) and carries live
// data (the health header). Hide it, so the capture is just the page.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

const portal = (page: Page) => page.getByTestId("portal");

async function openPortal(page: Page): Promise<void> {
  await page.clock.setFixedTime(PORTAL_NOW);
  await routePortalFixture(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Grafana" })).toBeVisible();
}

test("renders the fixed estate as grouped card links with filters", async ({ page }) => {
  await openPortal(page);
  await expect(page.getByRole("heading", { level: 1, name: "Portal" })).toBeVisible();
  await expect(page.locator("main main")).toHaveCount(0);
  await expect(portal(page).getByRole("heading", { level: 2 })).toHaveText(["Observability", "Applications"]);
  await expect(page.getByRole("heading", { level: 3, name: "Runbooks" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText(
    "Showing 9 of 9 items; 0 hidden by filters.",
  );
  // Inert cards (no target) are not links and take no tab stop.
  await expect(page.getByRole("link", { name: "Paperless" })).toHaveCount(0);
  await expect(page.getByText("Paperless").locator("xpath=ancestor::article[1]")).toBeVisible();

  await page.getByRole("toolbar", { name: "Status" }).getByRole("button", { name: /^Down/ }).click();
  await expect(portal(page).locator('[data-slot="link-tile"]')).toHaveCount(1);
  await expect(page.getByText("Jellyfin")).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(portal(page).locator('[data-slot="link-tile"]')).toHaveCount(9);
});

test("keyboard: / focuses search, Escape clears it, j/k/G walk the card links", async ({ page }) => {
  await openPortal(page);
  const search = page.getByRole("searchbox", { name: "Search the portal" });
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.type("runbook");
  await expect(portal(page).locator('[data-slot="link-tile"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");

  await search.blur();
  await page.keyboard.press("j");
  await expect(page.getByRole("link", { name: "Grafana" })).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.getByRole("link", { name: "Uptime" })).toBeFocused();
  await page.keyboard.press("k");
  await expect(page.getByRole("link", { name: "Grafana" })).toBeFocused();
  await page.keyboard.press("G");
  await expect(page.getByRole("link", { name: /^Router admin/ })).toBeFocused();
});

test.describe("visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await seedTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await openPortal(page);
        await page.addStyleTag({ content: HIDE_SHELL });
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`portal-${width}-${theme}.png`, {
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
      });
    }
  }
});
