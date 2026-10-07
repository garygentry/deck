import { expect, test, type Page } from "@playwright/test";

import { populatedLlmUsage, type JsonObject } from "./llm-usage-fixture.js";

/**
 * Visual baselines for `/usage`. Like the other visual specs they are generated and
 * verified on CI Linux only: locally they are skipped unless UPDATE_VISUALS is set;
 * refresh them in CI with the `update_visuals` workflow_dispatch input.
 *
 * `/api/llm-usage` is a routed fixture and the browser clock is fixed, so reset
 * countdowns and "updated 3m ago" markers render identically on every run.
 */

const VISUALS = Boolean(process.env.CI || process.env.UPDATE_VISUALS);
const WIDTHS = [375, 768, 1280] as const;
const THEMES = ["light", "dark"] as const;
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");
const NOW = FROZEN_NOW.getTime();

const HIDE_SHELL =
  'header[aria-label="Deck"], [data-slot="sidebar"] { display: none !important; }';

const POPULATED = populatedLlmUsage(NOW);

const SCENARIOS: Record<string, { body: JsonObject; ready: string }> = {
  populated: { body: POPULATED, ready: "Current session" },
  "not-configured": {
    body: { ...POPULATED, enabled: false, claude: null, codex: null },
    ready: "LLM usage is not configured",
  },
};

async function routeUsage(page: Page, body: JsonObject): Promise<void> {
  await page.route("**/api/llm-usage", (route) => route.fulfill({ json: body }));
}

test.describe("llm usage visual baselines", () => {
  test.skip(!VISUALS, "Visual baselines run on CI Linux only; set UPDATE_VISUALS=1 to run them");

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${name} ${width}px ${theme}`, async ({ page }) => {
          await page.clock.setFixedTime(FROZEN_NOW);
          await page.addInitScript((mode) => localStorage.setItem("deck-theme", mode), theme);
          await page.setViewportSize({ width, height: 900 });
          await routeUsage(page, scenario.body);
          const usage = page.locator('[data-slot="llm-usage-page"]');
          await expect(async () => {
            await page.goto("/usage");
            await expect(usage).toBeVisible({ timeout: 15_000 });
          }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
          // Settled only once the routed response rendered: a meter, or the not-configured state.
          await expect(scenario.body.enabled
            ? usage.getByRole("meter", { name: scenario.ready })
            : usage.getByText(scenario.ready, { exact: true })).toBeVisible();
          await expect(usage.locator("[aria-busy='true']")).toHaveCount(0);
          await page.addStyleTag({ content: HIDE_SHELL });
          await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`llm-usage-${name}-${width}-${theme}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
        });
      }
    }
  }
});
