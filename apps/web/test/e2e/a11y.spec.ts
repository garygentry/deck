import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FIXTURE } from "./inventory-fixture.js";
import { populatedLlmUsage } from "./llm-usage-fixture.js";
import { seedTheme } from "./theme-seed.js";

/**
 * Automated accessibility pass: every route, light and dark, must have no
 * serious or critical axe violations against WCAG 2.1 A/AA. (Manual keyboard
 * passes complement this; axe cannot judge focus order or live-region wording.)
 */

const ROUTES: readonly (readonly [string, string])[] = [
  ["portal", "/"],
  ["hosts", "/hosts"],
  ["services", "/services"],
  ["host detail", `/hosts/${encodeURIComponent(FIXTURE.hostAlpha)}`],
  [
    "service detail",
    `/services/${encodeURIComponent(FIXTURE.hostAlpha)}/${encodeURIComponent(FIXTURE.serviceWeb)}`,
  ],
  ["drift", "/drift"],
  ["monitoring", "/monitoring"],
  ["llm usage", "/usage"],
  ["actions", "/actions"],
  ["docs", "/docs"],
  ["configs", "/configs"],
  ["not found", "/no-such-page"],
];

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    for (const [name, path] of ROUTES) {
      test(`${name} has no serious or critical axe violations`, async ({ page }) => {
        await seedTheme(page, theme);
        await page.goto(path);
        await expect(page.locator("main#main")).toBeVisible();
        // Prove the theme took, so the dark pass never silently re-tests light.
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        // Let lazy pages load and their first fetches settle.
        await expect(page.locator("main#main [aria-busy='true']")).toHaveCount(0, {
          timeout: 30_000,
        });
        const { violations } = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const blocking = violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
        expect(blocking, `axe violations on ${path} (${theme})`).toEqual([]);
      });
    }
  });
}

// The E2E estate has no modules.llm-usage section, so the route list above only scans /usage's
// not-configured state; this pass routes a populated response (meters, tables, disclosure).
for (const theme of ["light", "dark"] as const) {
  test(`populated llm usage (${theme}) has no serious or critical axe violations`, async ({ page }) => {
    await page.route("**/api/llm-usage", (route) => route.fulfill({ json: populatedLlmUsage(Date.now()) }));
    await seedTheme(page, theme);
    await page.goto("/usage");
    await expect(page.getByRole("meter", { name: "Current session" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Sources and polling/ }).click();
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
    expect(blocking, `axe violations on populated /usage (${theme})`).toEqual([]);
  });
}

test("the skip link is the first tab stop and moves focus to the main content", async ({
  page,
}) => {
  await page.goto("/hosts");
  await expect(page.locator("main#main")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("the primary navigation is reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  const hosts = nav.getByRole("link", { name: "Hosts" });
  await expect(hosts).toBeVisible();
  // Tab until the Hosts link has focus, then follow it with Enter.
  for (let i = 0; i < 20 && !(await hosts.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(hosts).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/hosts$/);
  await expect(hosts).toHaveAttribute("aria-current", "page");
});
