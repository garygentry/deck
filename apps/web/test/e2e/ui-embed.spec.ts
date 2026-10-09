import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";
import { seedTheme } from "./theme-seed.js";

/**
 * `core/embed` end to end, with `ui.allowUnsafeEmbeds: true`: another origin's page renders in
 * a sandboxed frame that cannot reach deck's page or navigate its tab, a page on deck's own
 * origin is refused, and the dashboard passes axe. (A shut gate stops boot, which the server's
 * tests cover; the web's off state is covered by its unit tests.)
 */

const WEB_PORT = Number(process.env.DECK_E2E_WEB_PORT ?? 4173);

/**
 * The framed page: it reports what its sandbox let it do. Each attempt to leave the frame
 * (reading the parent's document, navigating the top window, opening an alert) is caught.
 */
const FRAMED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>UPS graph</title></head>
<body><h1>Framed UPS graph</h1><ul id="out"></ul><script>
const out = (text) => { const li = document.createElement("li"); li.textContent = text; document.getElementById("out").append(li); };
out("scripts run");
try { void window.parent.document.title; out("parent read"); } catch { out("parent blocked"); }
try { window.top.location.href = "https://example.invalid/"; out("top navigation attempted"); } catch { out("top navigation blocked"); }
try { window.alert("x"); out("alert returned"); } catch { out("alert blocked"); }
</script></body></html>`;

function ui(upstream: string) {
  return {
    allowUnsafeEmbeds: true,
    pages: [
      {
        id: "embeds",
        path: "/embeds",
        title: "Embedded pages",
        nav: { group: "lab", label: "Embeds", order: 0 },
        sections: [
          {
            title: "Graphs",
            columns: 2,
            widgets: [
              { id: "graph", type: "core/embed", title: "UPS graph", span: 2, options: { url: `${upstream}/frame.html`, height: "sm" } },
              { id: "strict", type: "core/embed", title: "Strict frame", options: { url: `${upstream}/frame.html`, sandbox: [], height: "sm" } },
              { id: "self", type: "core/embed", title: "Deck itself", options: { url: `http://127.0.0.1:${WEB_PORT}/hosts` } },
            ],
          },
        ],
      },
    ],
  };
}

const main = (page: Page) => page.locator("main#main");
const region = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });

async function openEmbeds(page: Page): Promise<void> {
  await page.goto("/embeds");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Embedded pages"], { timeout: 15_000 });
  await expect(page.frameLocator('iframe[title="UPS graph"]').getByRole("heading", { name: "Framed UPS graph" })).toBeVisible({ timeout: 30_000 });
}

test.describe("core/embed with ui.allowUnsafeEmbeds", () => {
  let api: SpecApi;
  let upstream: Server;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    upstream = createServer((request, response) => {
      if (request.url !== "/frame.html") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FRAMED);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    // Another origin than the web's (same host, another port).
    api = await startSpecApi("ui-embed", { DECK_E2E_UI: JSON.stringify(ui(`http://127.0.0.1:${port}`)) });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
    await new Promise<void>((resolve) => (upstream === undefined ? resolve() : upstream.close(() => resolve())));
  });

  test("frames another origin's page in a sandbox that keeps it out of deck", async ({ page }) => {
    // No dialog may open: the sandbox has no allow-modals, so a framed alert() is a no-op.
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openEmbeds(page);

    const frame = region(page, "UPS graph").locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    const framed = page.frameLocator('iframe[title="UPS graph"]').locator("#out li");
    // Chromium may refuse the top navigation by throwing or by ignoring it; either way deck stays put.
    await expect(framed).toHaveText(["scripts run", "parent blocked", /^top navigation (blocked|attempted)$/, "alert returned"]);
    await expect(page).toHaveURL(/\/embeds$/);
    expect(dialogs).toEqual([]);
    await expect(region(page, "UPS graph").getByRole("link", { name: /Open 127\.0\.0\.1/ })).toHaveAttribute("target", "_blank");

    // An empty sandbox list: the page's scripts never run.
    await expect(region(page, "Strict frame").locator("iframe")).toHaveAttribute("sandbox", "");
    await expect(page.frameLocator('iframe[title="Strict frame"]').getByRole("heading", { name: "Framed UPS graph" })).toBeVisible();
    await expect(page.frameLocator('iframe[title="Strict frame"]').locator("#out li")).toHaveCount(0);

    // Deck's own origin is never framed.
    await expect(region(page, "Deck itself").locator("iframe")).toHaveCount(0);
    await expect(region(page, "Deck itself").getByRole("alert")).toContainText("Deck does not frame its own pages");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has no serious or critical axe violations (${theme})`, async ({ page }) => {
      await useSpecApi(page, api.port);
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openEmbeds(page);
      // Deck's page, not the framed sites: axe does not go into the frames (it cannot run in the
      // one whose sandbox allows no scripts), so their titles, its frame-title rule, are checked here.
      await expect(main(page).locator("iframe")).toHaveCount(2);
      for (const title of await main(page).locator("iframe").evaluateAll((frames) => frames.map((frame) => frame.getAttribute("title")))) {
        expect(title?.trim()).toBeTruthy();
      }
      const { violations } = await new AxeBuilder({ page })
        .exclude('[data-slot="embed"] iframe')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      expect(blocking, `axe violations on /embeds (${theme})`).toEqual([]);
    });
  }

  test("is one column at 375px, with no sideways scroll", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 375, height: 800 });
    await openEmbeds(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
