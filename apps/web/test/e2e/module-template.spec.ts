import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { READY_TIMEOUT_MS, startSpecApi, stopSpecApi, useSpecApi, type SpecApi } from "./spec-api.js";
import { seedTheme } from "./theme-seed.js";

/**
 * The module template, end to end, as an author ships it: `examples/modules/hello` is built
 * (`pnpm build`'s two passes) straight into a fresh DECK_MODULES_DIR of the spec's own, never
 * the template's shared dist/, and a spec-local real API loads it with DECK_MODULES_ENABLED. Its server half answers (provider,
 * route, health) and its web half renders inside deck's page, on deck's React, with styles of
 * its own built from the @deck/sdk/tailwind preset.
 */

const REPO = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const TEMPLATE = join(REPO, "examples/modules/hello");
const GREETING = "Hello from a runtime module";

const main = (page: Page) => page.locator("main#main");

/** Console errors and uncaught page errors. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test.describe("the module template, built and dropped into DECK_MODULES_DIR", () => {
  let api: SpecApi | undefined;
  let modulesDir: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2 + 120_000);
    modulesDir = mkdtempSync(join(tmpdir(), "deck-e2e-modules-"));
    for (const args of [["build"], ["build", "--mode", "server"]]) {
      const built = spawnSync("pnpm", ["exec", "vite", ...args, "--outDir", join(modulesDir, "hello")], { cwd: TEMPLATE, encoding: "utf8" });
      expect(built.status, `vite ${args.join(" ")} in examples/modules/hello failed:\n${built.stderr}`).toBe(0);
    }
    api = await startSpecApi("module-template", { DECK_MODULES_DIR: modulesDir, DECK_MODULES_ENABLED: "true" });
  });

  test.afterAll(async () => {
    if (api !== undefined) await stopSpecApi(api);
    if (modulesDir !== undefined) rmSync(modulesDir, { recursive: true, force: true });
  });

  async function openHello(page: Page): Promise<void> {
    await useSpecApi(page, api!.port);
    await page.goto("/hello");
    await expect(page.getByRole("heading", { level: 1, name: "Hello" })).toBeVisible({ timeout: 30_000 });
    await expect(main(page).getByText(GREETING)).toBeVisible({ timeout: 30_000 });
  }

  test("its server half loads: the module, its provider, route and health answer", async ({ page }) => {
    await useSpecApi(page, api!.port);
    await page.goto("/");
    const served = await page.evaluate(async () => {
      const json = async (path: string) => (await fetch(path)).json();
      const ui = await json("/api/ui");
      return {
        module: ui.modules.find((module: { id: string }) => module.id === "hello"),
        page: ui.pages.find((entry: { id: string }) => entry.id === "page:hello/main"),
        provider: (await json("/api/providers/hello")).data,
        route: await json("/api/m/hello/greeting"),
        health: (await json("/api/health")).modules.hello,
        script: (await fetch("/modules/hello/web.js")).headers.get("content-type"),
      };
    });
    expect(served.module).toMatchObject({ id: "hello", version: "0.1.0", enabled: true, origin: "module", web: { script: "/modules/hello/web.js" } });
    expect(served.page).toMatchObject({ module: "hello", path: "/hello", title: "Hello", component: "HelloPage" });
    expect(served.provider).toMatchObject({ message: GREETING, servedAt: expect.any(String) });
    expect(served.route).toEqual({ message: GREETING });
    expect(served.health).toEqual({ state: "ok", detail: GREETING });
    expect(served.script).toMatch(/javascript/);
  });

  test("its web half renders on deck's React: page, nav entry, header pill and icon", async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHello(page);

    await expect(main(page).getByText("Saying hello")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Hello", exact: true })).toHaveAttribute("href", "/hello");
    const pill = page.locator('[data-slot="health-header"]').getByRole("link", { name: /Hello/ });
    await expect(pill).toBeVisible();
    await expect(pill.locator('[data-slot="icon"] svg')).toBeVisible();

    expect(errors.filter((text) => /Invalid hook call|more than one copy of React/i.test(text))).toEqual([]);
    expect(errors.filter((text) => text.startsWith("pageerror"))).toEqual([]);
    expect(errors.filter((text) => /runtime module "hello"/.test(text))).toEqual([]);
  });

  test("its own styles apply, built from deck's tokens", async ({ page }) => {
    await openHello(page);
    const styles = await page.locator('[data-slot="hello-greeting"]').evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--muted)";
      probe.style.borderRadius = "var(--corner-md)";
      document.body.append(probe);
      const token = getComputedStyle(probe);
      const own = getComputedStyle(element);
      const result = {
        background: own.backgroundColor,
        mutedToken: token.backgroundColor,
        radius: own.borderTopLeftRadius,
        radiusToken: token.borderTopLeftRadius,
        padding: own.paddingTop,
        sheet: [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/modules/hello/web.css")),
      };
      probe.remove();
      return result;
    });
    expect(styles.sheet).toBe(true);
    expect(styles.background).toBe(styles.mutedToken);
    expect(styles.radius).toBe(styles.radiusToken);
    expect(styles.padding).toBe("16px");
  });

  test("is usable at phone width, with no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openHello(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has no serious or critical axe violations (${theme})`, async ({ page }) => {
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openHello(page);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      expect(blocking, `axe violations on /hello (${theme})`).toEqual([]);
    });
  }
});
