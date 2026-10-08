import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./theme-seed.js";

/**
 * Visual baselines for the inventory lists (/hosts, /services) at 3 widths × 2
 * themes. Like the workbench baselines, they are generated and verified on CI
 * Linux only (font rasterisation differs across hosts): skipped locally unless
 * UPDATE_VISUALS is set; refresh them with the `update_visuals` CI dispatch.
 *
 * The E2E fixture API stamps its data with the real "now", so every timestamp
 * and age in the snapshot envelope is pinned here (route interception rewrites
 * the real response) and the page clock is frozen: the captures are stable.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const ROUTES = ["hosts", "services"] as const;
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");
/** Every timestamp in the envelope becomes this instant: 5 minutes before FROZEN_NOW. */
const PINNED_AT = "2026-01-15T11:55:00.000Z";
const PINNED_AGE_MS = 5 * 60_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// The shell chrome is sticky (it would overlay a tall capture) and carries live
// data (the health header). Hide it, so the page is just the list.
const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

/** Replace every ISO timestamp and non-null age in a decoded JSON value. */
function pin(value: unknown): unknown {
  if (typeof value === "string") return ISO_TIMESTAMP.test(value) ? PINNED_AT : value;
  if (Array.isArray(value)) return value.map(pin);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "ageMs" && typeof entry === "number" ? PINNED_AGE_MS : pin(entry),
      ]),
    );
  }
  return value;
}

async function pinSnapshot(page: Page): Promise<void> {
  await page.route("**/api/providers/snapshot", async (route) => {
    const response = await route.fetch();
    const body = pin(await response.json());
    await route.fulfill({ response, json: body });
  });
}

// Declared only when enabled (rather than skipped): the inventory meta test bans
// skip calls in inventory test files.
if (VISUALS) test.describe("inventory list visual baselines", () => {
  for (const route of ROUTES) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${route} ${width}px ${theme}`, async ({ page }) => {
          await page.clock.setFixedTime(FROZEN_NOW);
          await seedTheme(page, theme);
          await pinSnapshot(page);
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`/${route}`);
          await expect(page.getByRole("heading", { name: "Snapshot available" })).toBeVisible();
          await expect(page.getByRole("table")).toBeVisible();
          await page.addStyleTag({ content: HIDE_SHELL });
          await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`${route}-${width}-${theme}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
        });
      }
    }
  }
});
