import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./theme-seed.js";

/**
 * Visual baselines for the source browser (Docs + Configs) with a document / file open, against
 * the committed local-path fixtures the sources E2E suite also uses. Like the workbench
 * baselines, they are generated and verified on CI Linux only (font rasterisation differs across
 * hosts): skipped locally unless UPDATE_VISUALS is set; refresh them in CI with the
 * `update_visuals` workflow_dispatch input.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");

// The shell chrome is sticky (it would overlay a tall capture) and carries live data (the health
// header). Hide it, so the capture is just the page.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

/**
 * Pin the source's freshness stamp: its age is the server's live `ageMs` (time since the last
 * poll), which the page clock cannot freeze. The rest of the envelope is the real one.
 */
async function pinFreshness(page: Page, sourceId: string): Promise<void> {
  await page.route(`**/api/providers/${sourceId}`, async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { freshness?: Record<string, unknown> };
    json.freshness = {
      ...json.freshness,
      state: "fresh",
      observedAt: new Date(FROZEN_NOW.getTime() - 60_000).toISOString(),
      ageMs: 60_000,
    };
    await route.fulfill({ response, json });
  });
}

const CASES = [
  { name: "docs", route: "/docs", heading: "Docs", open: "index.md" },
  { name: "configs", route: "/configs", heading: "Configs", open: "app.yaml" },
] as const;

/** Load a browser route and wait for its tree, retrying a blank dev-server shell or a cold poll. */
async function openSource(page: Page, route: string, heading: string): Promise<void> {
  await expect(async () => {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("tree", { name: "Files" })).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
}

test.describe("source browser visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const { name, route, heading, open } of CASES) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${name} ${width}px ${theme}`, async ({ page }) => {
          await page.clock.setFixedTime(FROZEN_NOW);
          await seedTheme(page, theme);
          await page.setViewportSize({ width, height: 900 });
          await pinFreshness(page, name);
          await openSource(page, route, heading);

          await page.getByRole("treeitem", { name: open }).click();
          if (name === "docs") {
            await expect(page.getByRole("article", { name: "Document" })).toBeVisible();
          } else {
            await expect(page.getByRole("figure", { name: open })).toBeVisible();
          }

          await page.addStyleTag({ content: HIDE_SHELL });
          // No hover or focus styling left over from the click.
          await page.mouse.move(0, 0);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.evaluate(() => document.fonts.ready);

          await expect(page).toHaveScreenshot(`sources-${name}-${width}-${theme}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
        });
      }
    }
  }
});
