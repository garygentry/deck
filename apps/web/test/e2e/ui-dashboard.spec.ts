import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE } from "./inventory-fixture.js";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";
import { seedTheme } from "./theme-seed.js";

/**
 * A config page (`ui.pages`) end to end: a real server whose overlay defines a dashboard over
 * the estate's snapshot provider, with `select`s the server evaluates into the provider's
 * envelope, and the shell rendering it: its route and nav entry, the outline (one h1, a heading
 * per section and widget, DOM order = reading order), one column below md, and axe.
 */

const UI = {
  pages: [
    {
      id: "lab",
      path: "/lab",
      title: "Lab overview",
      icon: "gauge",
      nav: { group: "lab", order: 0 },
      sections: [
        {
          title: "Inventory",
          columns: 3,
          widgets: [
            { id: "hosts", type: "core/json", title: "Host names", source: "snapshot", select: "snapshot.hosts[].name", span: 2 },
            { id: "count", type: "core/json", title: "Host count", source: { kind: "snapshot" }, select: "length(snapshot.hosts)" },
            { id: "missing", type: "core/json", title: "Unknown source", source: "no-such-provider" },
          ],
        },
        {
          title: "Raw",
          widgets: [{ id: "generated", type: "core/json", title: "Generated at", source: "snapshot", select: "snapshot.generatedAt", options: { wrap: true } }],
        },
      ],
    },
  ],
};

const main = (page: Page) => page.locator("main#main");

/** Open the lab page and wait for its widgets' data. */
async function openLab(page: Page): Promise<void> {
  await page.goto("/lab");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Lab overview"], { timeout: 15_000 });
  await expect(main(page).getByRole("region", { name: "Host names" })).toContainText(FIXTURE.hostAlpha, { timeout: 15_000 });
  await expect(main(page).locator("[aria-busy='true']")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("a config page (dashboard)", () => {
  let api: SpecApi;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    api = await startSpecApi("ui-dashboard", { DECK_E2E_UI: JSON.stringify(UI) });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
  });

  test("is routed and listed in its nav group, and renders what the server selected", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.goto("/hosts");
    const entry = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Lab overview", exact: true });
    await expect(entry).toHaveAttribute("href", "/lab", { timeout: 15_000 });
    await entry.click();
    await expect(page).toHaveURL(/\/lab$/);
    await expect(page).toHaveTitle(/^Lab overview · /);
    const hosts = main(page).getByRole("region", { name: "Host names" });
    await expect(hosts).toContainText(FIXTURE.hostAlpha, { timeout: 15_000 });
    // The projection, not the snapshot document: only the names.
    await expect(hosts.locator("code")).not.toContainText("collectors");
    await expect(main(page).getByRole("region", { name: "Host count" }).locator("code")).toHaveText(/^\d+$/);
    // A source the server could not resolve is the widget's error state, not a broken page.
    await expect(main(page).getByRole("region", { name: "Unknown source" })).toContainText('It reads provider "no-such-provider", which is not configured.');
  });

  test("has one h1, a heading per section and widget, in reading order", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openLab(page);
    await expect(main(page).getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(main(page).getByRole("heading", { level: 2 })).toHaveText(["Inventory", "Raw"]);
    await expect(main(page).getByRole("heading", { level: 3 })).toHaveText(["Host names", "Host count", "Unknown source", "Generated at"]);
    // Reading order (top to bottom, then left to right) is DOM order.
    const boxes = await main(page).locator('[data-slot="widget"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { id: node.getAttribute("data-widget-id"), top: Math.round(box.top), left: Math.round(box.left) };
      }),
    );
    const visual = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left).map((box) => box.id);
    expect(visual).toEqual(boxes.map((box) => box.id));
    // From md up the section has its columns: the first two widgets share a row.
    expect(boxes[0]!.top).toBe(boxes[1]!.top);
    expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
  });

  test("is one column below md", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 375, height: 800 });
    await openLab(page);
    const boxes = await main(page).locator('[data-slot="widget"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, left: Math.round(box.left), width: Math.round(box.width) };
      }),
    );
    for (const box of boxes) {
      expect(box.left).toBe(boxes[0]!.left);
      expect(box.width).toBe(boxes[0]!.width);
    }
    for (let index = 1; index < boxes.length; index += 1) expect(boxes[index]!.top).toBeGreaterThan(boxes[index - 1]!.top);
    // Nothing scrolls the page sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [375, 1280]) {
      test(`has no serious or critical axe violations (${theme}, ${width}px)`, async ({ page }) => {
        await useSpecApi(page, api.port);
        await seedTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await openLab(page);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const blocking = violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
        expect(blocking, `axe violations on /lab (${theme}, ${width}px)`).toEqual([]);
      });
    }
  }
});
