import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";
import { seedTheme } from "./theme-seed.js";

/**
 * A sidecar in another process contributes a working page, end to end: a `remote` integration
 * polls a fixture sidecar's `/deck/v1/data` and asks its `/deck/v1/describe`; deck renders the
 * described widgets with its own widget types on the integration's page, lists the page and the
 * sidecar's external nav link in the sidebar, and reports the sidecar's health.
 */

const DESCRIBE = {
  deck: 1,
  id: "ups",
  version: "1.0.0",
  title: "UPS",
  columns: 2,
  widgets: [
    { id: "status", type: "core/stat", title: "Status", select: "status" },
    { id: "load", type: "core/meter", title: "Load", select: "load", options: { max: 100, unit: "%" } },
    { id: "details", type: "core/key-value", title: "Details", span: 2, options: { items: [{ field: "model", label: "Model" }, { field: "inputVoltage", label: "Input", unit: "V" }] } },
  ],
  links: [{ title: "NUT documentation", href: "https://networkupstools.org/" }],
  nav: [{ id: "nut", label: "NUT web UI", href: "https://nut.example/" }],
};
const DATA = { data: { status: "OL", load: 23, model: "Back-UPS 1500", inputVoltage: 231 }, observedAt: "2026-01-15T12:00:00Z" };

const main = (page: Page) => page.locator("main#main");
const region = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });

async function openUps(page: Page): Promise<void> {
  await page.goto("/power/ups");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["UPS"], { timeout: 15_000 });
  await expect(region(page, "Status")).toContainText("OL", { timeout: 30_000 });
  await expect(main(page).locator("[aria-busy='true']")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("a remote sidecar's page", () => {
  let api: SpecApi;
  let sidecar: Server;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 30_000);
    sidecar = createServer((request, response) => {
      const body = request.url === "/deck/v1/describe" ? DESCRIBE : request.url === "/deck/v1/data" ? DATA : undefined;
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    const { port } = sidecar.address() as AddressInfo;
    api = await startSpecApi("remote-sidecar", {
      DECK_E2E_INTEGRATIONS: JSON.stringify([
        { id: "ups", kind: "remote", title: "UPS", url: `http://127.0.0.1:${port}`, pollIntervalMs: 2_000, ttlMs: 600_000, page: { path: "/power/ups", icon: "zap", nav: { group: "health", order: 0 } } },
      ]),
    });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
    await new Promise<void>((resolve) => (sidecar === undefined ? resolve() : sidecar.close(() => resolve())));
  });

  test("renders the described widgets over the sidecar's data, with its links and nav", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openUps(page);
    await expect(region(page, "Load").getByRole("meter", { name: "Load" })).toHaveAttribute("aria-valuenow", "23");
    await expect(region(page, "Details").getByRole("definition")).toHaveText(["Back-UPS 1500", "231 V"]);
    await expect(region(page, "Links").getByRole("link", { name: /NUT documentation/ })).toHaveAttribute("target", "_blank");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "UPS", exact: true })).toHaveAttribute("href", "/power/ups");
    const external = nav.getByRole("link", { name: /NUT web UI/ });
    await expect(external).toHaveAttribute("href", "https://nut.example/");
    await expect(external).toHaveAttribute("target", "_blank");
    // The sidecar is its own provider: its own health entry, naming data and describe.
    const health = await page.evaluate(async () => (await fetch("/api/health")).json());
    expect(health.providers.ups).toMatchObject({ ok: true, detail: expect.stringContaining("describe: ok (ups 1.0.0)") });
  });

  test("is one column below md, with no sideways scroll", async ({ page }) => {
    await useSpecApi(page, api.port);
    await page.setViewportSize({ width: 375, height: 800 });
    await openUps(page);
    const lefts = await main(page).locator('[data-slot="widget"]').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has no serious or critical axe violations (${theme})`, async ({ page }) => {
      await useSpecApi(page, api.port);
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openUps(page);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      expect(blocking, `axe violations on /power/ups (${theme})`).toEqual([]);
    });
  }
});
