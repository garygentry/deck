import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./theme-seed.js";

/**
 * The dev-only `/_ui` component workbench. The structural checks run everywhere.
 * The visual baselines are generated and verified on CI Linux only: font
 * rasterisation differs across hosts, so a baseline made on a laptop would fail
 * in CI. Locally they are skipped unless UPDATE_VISUALS is set; refresh them in
 * CI with the `update_visuals` workflow_dispatch input.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const CATALOGUE_GROUPS = ["A", "B", "C", "D", "E", "F", "G"] as const;
// Any live timestamp renders against this instant, so snapshots are stable.
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");

// The shell chrome is sticky (it would overlay a tall capture) and carries live
// data (the health header). Hide it, so the page is just the workbench.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

const workbench = (page: Page) => page.locator('[data-slot="ui-workbench"]');

test("renders a section per catalogue group and stays out of primary nav", async ({ page }) => {
  await page.goto("/_ui");
  await expect(page.getByRole("heading", { level: 1, name: "UI workbench" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Primitives" })).toBeVisible();
  for (const group of CATALOGUE_GROUPS) {
    await expect(
      page.getByRole("heading", { level: 2, name: new RegExp(`^${group}\\. `) }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "UI workbench" }),
  ).toHaveCount(0);
});

test("the workbench theme toggle and the shell toggle share one preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/_ui");
  const theme = page.getByRole("radiogroup", { name: "Theme" });

  await theme.getByRole("radio", { name: "dark" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("button", { name: "Theme: dark" })).toBeVisible();

  await theme.getByRole("radio", { name: "light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expect(page.getByRole("button", { name: "Theme: light" })).toBeVisible();
});

test.describe("visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await page.clock.setFixedTime(FROZEN_NOW);
        await seedTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/_ui");
        await expect(workbench(page)).toBeVisible();
        await page.addStyleTag({ content: HIDE_SHELL });
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`workbench-${width}-${theme}.png`, {
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
      });
    }
  }
});
