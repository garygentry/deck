import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { startSpecApi, stopSpecApi, type SpecApi } from "./spec-api.js";

/**
 * The web shell under its Content-Security-Policy, as deck serves a production build: every
 * page the UI manifest routes, in light and dark, with runtime modules' web halves (loaded
 * through the import map: the maintenance example, and the module template as its build
 * writes it, with its own web.css), framed pages, a markdown image and a brand logo, raises no CSP
 * violation (neither a `securitypolicyviolation` event nor a console report). Every overlay the
 * UI library has (on the overlay lab page) opens, positions itself and locks the page's scroll
 * under a style policy with no 'unsafe-inline': the `<style>` elements they inject carry the
 * page's style nonce. And the policy holds: a framed page that redirects into deck's own origin
 * is refused, and an inline style without the nonce is refused.
 *
 * The suite's Vite dev server sends no policy, so this spec builds the shell, with the overlay
 * lab built in (VITE_DECK_OVERLAY_LAB=true), or reuses the build DECK_E2E_WEB_DIST names (which
 * the overlay test needs built the same way), and boots its own API serving it.
 */

const webDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const examples = join(webDir, "..", "..", "examples", "modules");

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0a7"/></svg>';

let api: SpecApi;
let helper: Server;
let helperOrigin: string;
let builtDist: string | undefined;
let modulesDir: string | undefined;

test.describe.configure({ mode: "serial", timeout: 600_000 });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  let dist = process.env.DECK_E2E_WEB_DIST;
  if (dist === undefined) {
    builtDist = dist = mkdtempSync(join(tmpdir(), "deck-e2e-csp-dist-"));
    execFileSync("bunx", ["vite", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: webDir, stdio: "inherit", env: { ...process.env, VITE_DECK_OVERLAY_LAB: "true" } });
  }

  // A modules directory of the spec's own (examples/modules also holds the template's sources):
  // the maintenance example, and the template built straight into it.
  modulesDir = mkdtempSync(join(tmpdir(), "deck-e2e-csp-modules-"));
  cpSync(join(examples, "maintenance"), join(modulesDir, "maintenance"), { recursive: true });
  for (const args of [["build"], ["build", "--mode", "server"]]) {
    execFileSync("pnpm", ["exec", "vite", ...args, "--outDir", join(modulesDir, "hello"), "--logLevel", "error"], { cwd: join(examples, "hello"), stdio: "inherit" });
  }

  // Another origin: the framed page, an image, and a redirect into deck's own origin.
  let deckOrigin = "";
  helper = createServer((req, res) => {
    if (req.url === "/framed") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Framed</title><p>framed page</p>");
    if (req.url === "/logo.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end(LOGO);
    if (req.url === "/to-deck") return res.writeHead(302, { Location: `${deckOrigin}/` }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => helper.listen(0, "127.0.0.1", resolve));
  helperOrigin = `http://127.0.0.1:${(helper.address() as AddressInfo).port}`;

  // Raw HTML with a style attribute and a <style> block (both dropped before any parse), an
  // aligned table column (a class, not a style attribute), and highlighted code.
  const markdown = [
    "Runbook notes.",
    `![status](${helperOrigin}/logo.svg)`,
    '<p style="color: red">Styled note</p>',
    "<style>\nmain { outline: 3px solid red; }\n</style>",
    "| Host | Uptime |\n| - | -: |\n| nas-01 | 42d |",
    "```js\nconst answer = 42;\n```",
  ].join("\n\n");
  const ui = {
    brand: { title: "CSP Lab", logoUrl: `${helperOrigin}/logo.svg` },
    allowUnsafeEmbeds: true,
    pages: [
      {
        id: "csp",
        path: "/csp",
        title: "CSP",
        nav: { group: "overview" },
        sections: [
          {
            title: "Content",
            columns: 2,
            widgets: [
              { id: "frame", type: "core/embed", title: "Framed page", options: { url: `${helperOrigin}/framed`, height: "sm" } },
              { id: "notes", type: "core/markdown", title: "Notes", options: { content: markdown } },
            ],
          },
        ],
      },
      {
        id: "escape",
        path: "/escape",
        title: "Escape",
        sections: [{ title: "Redirect", columns: 1, widgets: [{ id: "escape", type: "core/embed", title: "Escaping frame", options: { url: `${helperOrigin}/to-deck`, height: "sm" } }] }],
      },
    ],
  };
  api = await startSpecApi("csp", {
    DECK_E2E_WEB_DIST: dist,
    DECK_E2E_UI: JSON.stringify(ui),
    DECK_E2E_MODULES: JSON.stringify({ maintenance: { windows: [{ name: "Patch night", start: "2030-01-01T02:00:00Z", durationMinutes: 60 }] } }),
    DECK_MODULES_DIR: modulesDir,
    DECK_MODULES_ENABLED: "true",
  });
  deckOrigin = `http://127.0.0.1:${api.port}`;
});

test.afterAll(async () => {
  if (api !== undefined) await stopSpecApi(api);
  await new Promise((resolve) => helper?.close(resolve));
  if (builtDist !== undefined) rmSync(builtDist, { recursive: true, force: true });
  if (modulesDir !== undefined) rmSync(modulesDir, { recursive: true, force: true });
});

interface Violation {
  directive: string;
  blocked: string;
}

/** Record every CSP violation the page reports, as events (in-page) and console messages. */
async function watchViolations(page: Page): Promise<{ events: () => Promise<Violation[]>; console: string[] }> {
  await page.addInitScript(() => {
    const seen: { directive: string; blocked: string }[] = [];
    (window as unknown as { __csp: typeof seen }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => seen.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  });
  const console: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to (load|execute|apply|frame|connect)/i.test(message.text())) console.push(message.text());
  });
  return { events: () => page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp ?? []), console };
}

const origin = () => `http://127.0.0.1:${api.port}`;

/** The paths the manifest routes (no parameters), the runtime modules' pages included. */
async function routedPaths(): Promise<string[]> {
  const manifest = (await (await fetch(`${origin()}/api/ui`)).json()) as { pages: { path: string }[] };
  return [...new Set(["/", ...manifest.pages.map((page) => page.path).filter((path) => !path.includes(":"))])].filter((path) => path !== "/escape");
}

test("serves the shell with an enforced policy and per-response nonces", async () => {
  const first = await fetch(`${origin()}/`);
  const second = await fetch(`${origin()}/`);
  const policy = first.headers.get("content-security-policy") ?? "";
  expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
  // Styles: deck's own, and <style> elements carrying the nonce the page's meta element names.
  const styleNonce = /style-src 'self' 'nonce-([^']+)';/.exec(policy)?.[1];
  expect(styleNonce).toBeDefined();
  expect(policy).not.toContain("unsafe-inline");
  expect(await first.text()).toContain(`<meta property="csp-nonce" nonce="${styleNonce}" />`);
  expect(policy).toContain(`frame-src ${helperOrigin}`);
  expect(first.headers.get("cache-control")).toBe("no-cache");
  expect(second.headers.get("content-security-policy")).not.toBe(policy);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`every routed page loads with no CSP violation (${colorScheme})`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme, baseURL: origin() });
    try {
      const page = await context.newPage();
      const violations = await watchViolations(page);
      const paths = await routedPaths();
      expect(paths).toEqual(expect.arrayContaining(["/", "/csp", "/maintenance", "/hello", "/hosts", "/docs"]));
      for (const path of paths) {
        await page.goto(path);
        await expect(page.locator("main h1").first()).toBeVisible({ timeout: 30_000 });
        await page.waitForLoadState("networkidle");
        expect(await violations.events(), `${path} (${colorScheme})`).toEqual([]);
      }
      // The page with the framed page, the markdown image and the logo shows all three.
      await page.goto("/csp");
      await expect(page.frameLocator('iframe[title="Framed page"]').getByText("framed page")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-slot="prose"] img')).toHaveJSProperty("complete", true);
      expect(await page.locator('[data-slot="prose"] img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      expect(await page.locator('[data-brand-mark="logo"]').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      // Raw HTML keeps its text but not its style attribute, and code is highlighted (by class).
      await expect(page.locator('[data-slot="prose"]').getByText("Styled note")).toBeVisible();
      expect(await page.locator('[data-slot="prose"] [style], [data-slot="prose"] style').count()).toBe(0);
      await expect(page.locator('[data-slot="prose"]')).not.toContainText("outline");
      await expect(page.locator('[data-slot="prose"] pre [class^="hljs-"]').first()).toBeVisible();
      await expect(page.locator('[data-slot="prose"] td', { hasText: "42d" })).toHaveCSS("text-align", "right");
      // The runtime module's web half (an import-mapped ESM chunk) rendered its page.
      await page.goto("/maintenance");
      await expect(page.getByText("Patch night")).toBeVisible({ timeout: 30_000 });
      // The template's built web half rendered its page, with its own stylesheet applied.
      await page.goto("/hello");
      await expect(page.locator('[data-slot="hello-greeting"]')).toHaveCSS("padding-top", "16px", { timeout: 30_000 });
      expect(await violations.events()).toEqual([]);
      expect(violations.console).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("refuses a framed page that redirects into deck's own origin, even with a same-origin embed configured", async ({ browser }) => {
  // Add an embed of deck's own origin (known only now) beside the escaping one, by hot reload.
  const layer = join(api.tmp, "runtime", "config", "zzzz-ui.yaml");
  const document = JSON.parse(readFileSync(layer, "utf8")) as { ui: { pages: { id: string; sections: { widgets: unknown[] }[] }[] } };
  document.ui.pages.find((page) => page.id === "escape")!.sections[0]!.widgets.push({ id: "self", type: "core/embed", title: "Deck itself", options: { url: `${origin()}/portal`, height: "sm" } });
  writeFileSync(layer, JSON.stringify(document));
  await expect.poll(async () => (await (await fetch(`${origin()}/api/ui`)).text()).includes("Deck itself"), { timeout: 30_000 }).toBe(true);
  const policy = (await fetch(`${origin()}/escape`)).headers.get("content-security-policy") ?? "";
  expect(policy).toContain(`frame-src ${helperOrigin};`);
  expect(policy).not.toContain(`frame-src ${origin()}`);

  const context = await browser.newContext({ baseURL: origin() });
  try {
    const page = await context.newPage();
    const violations = await watchViolations(page);
    await page.goto("/escape");
    await expect(page.getByText("Deck does not frame its own pages; place their widgets on a dashboard instead.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('iframe[title="Escaping frame"]')).toBeAttached({ timeout: 30_000 });
    await expect.poll(async () => (await violations.events()).map((violation) => violation.directive), { timeout: 15_000 }).toContain("frame-src");
    // No frame ever holds deck's shell.
    for (const frame of page.frames().slice(1)) {
      expect(await frame.locator("#app").count()).toBe(0);
    }
  } finally {
    await context.close();
  }
});

type Box = { x: number; y: number; width: number; height: number };

/** `locator`'s box on screen, once it has one. */
async function boxOf(locator: Locator): Promise<Box> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** `content` sits against `trigger` on `side` (within its offset), overlapping it along the other axis. */
function expectBeside(content: Box, trigger: Box, side: "top" | "bottom") {
  const gap = side === "bottom" ? content.y - (trigger.y + trigger.height) : trigger.y - (content.y + content.height);
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThanOrEqual(16);
  expect(content.x).toBeLessThan(trigger.x + trigger.width);
  expect(content.x + content.width).toBeGreaterThan(trigger.x);
}

/** Every `<style>` element in the page carries the page's style nonce (read as the browser holds it). */
async function stylesCarryNonce(page: Page): Promise<{ styles: number; unnonced: number }> {
  return page.evaluate(() => {
    const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce ?? "";
    const styles = [...document.querySelectorAll("style")];
    return { styles: styles.length, unnonced: nonce === "" ? styles.length : styles.filter((style) => style.nonce !== nonce).length };
  });
}

/** Whether the page's scroll is locked (react-remove-scroll's nonce'd `<style>` applied), and the page did not scroll. */
async function expectScrollLocked(page: Page, locked: boolean) {
  const body = page.locator("body");
  if (locked) {
    await expect(body).toHaveAttribute("data-scroll-locked", /.*/);
    await expect(body).toHaveCSS("overflow-y", "hidden");
    expect(await stylesCarryNonce(page)).toMatchObject({ unnonced: 0 });
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(5, 300);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  } else {
    await expect(body).not.toHaveAttribute("data-scroll-locked", /.*/);
  }
}

test("opens every overlay on the lab page, positioned and scroll-locking, with no CSP violation", async ({ browser }) => {
  test.skip(process.env.DECK_E2E_WEB_DIST !== undefined && process.env.VITE_DECK_OVERLAY_LAB !== "true", "DECK_E2E_WEB_DIST was not built with VITE_DECK_OVERLAY_LAB=true");
  const context = await browser.newContext({ baseURL: origin(), viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const violations = await watchViolations(page);
    await page.goto("/_ui/overlays");
    await expect(page.getByRole("heading", { level: 1, name: "Overlay lab" })).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    // The page scrolls, so a lock is observable.
    await page.evaluate(() => window.scrollTo(0, 120));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const viewport = page.viewportSize()!;

    // Dialog: centred, modal, scroll locked; released on close.
    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Lab dialog" });
    const dialogBox = await boxOf(dialog);
    expect(Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(dialogBox.y + dialogBox.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
    await expectScrollLocked(page, true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expectScrollLocked(page, false);

    // Alert dialog.
    await page.getByRole("button", { name: "Open alert dialog" }).click();
    const alert = page.getByRole("alertdialog", { name: "Lab alert" });
    await boxOf(alert);
    await expectScrollLocked(page, true);
    await alert.getByRole("button", { name: "Cancel" }).click();
    await expect(alert).toBeHidden();

    // Sheet: full height against the right edge.
    await page.getByRole("button", { name: "Open sheet" }).click();
    const sheet = page.getByRole("dialog", { name: "Lab sheet" });
    await expect.poll(async () => {
      const box = await sheet.boundingBox();
      return box === null ? null : [Math.round(box.x + box.width), Math.round(box.y), Math.round(box.height)];
    }).toEqual([viewport.width, 0, viewport.height]);
    await expectScrollLocked(page, true);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Popover and dropdown menu: below their triggers.
    const popoverTrigger = page.getByRole("button", { name: "Open popover" });
    await popoverTrigger.click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toHaveText("Lab popover");
    await expect(async () => expectBeside(await boxOf(popover), await boxOf(popoverTrigger), "bottom")).toPass();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();

    // A modal menu hides the rest of the page from the accessibility tree: measure its trigger first.
    const menuTrigger = page.getByRole("button", { name: "Open menu" });
    const menuTriggerBox = await boxOf(menuTrigger);
    await menuTrigger.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(async () => expectBeside(await boxOf(menu), menuTriggerBox, "bottom")).toPass();
    await expectScrollLocked(page, true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Select: its list over the trigger, its viewport's (nonce'd) scrollbar rule applied, and a pick.
    const select = page.getByRole("combobox", { name: "Fruit" });
    const selectBox = await boxOf(select);
    await select.click();
    const listbox = page.getByRole("listbox");
    const listBox = await boxOf(listbox);
    expect(listBox.y).toBeLessThanOrEqual(selectBox.y + selectBox.height);
    expect(listBox.y + listBox.height).toBeGreaterThanOrEqual(selectBox.y);
    await expect(page.locator("[data-radix-select-viewport]")).toHaveCSS("scrollbar-width", "none");
    await expectScrollLocked(page, true);
    await listbox.getByRole("option", { name: "Cherry" }).click();
    await expect(listbox).toBeHidden();
    await expect(select).toHaveText("Cherry");

    // Tooltip: above its trigger on hover.
    const tooltipTrigger = page.getByRole("button", { name: "Hover for tooltip" });
    await tooltipTrigger.hover();
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await expect(tooltip).toContainText("Lab tooltip");
    await expect(async () => expectBeside(await boxOf(tooltip), await boxOf(tooltipTrigger), "top")).toPass();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();

    // Command palette: a modal dialog with a filtering list.
    await page.getByRole("button", { name: "Open command palette" }).click();
    const palette = page.getByRole("dialog");
    await expect(palette.getByRole("combobox")).toBeFocused();
    await expectScrollLocked(page, true);
    await page.keyboard.type("Fig");
    await expect(palette.getByRole("option")).toHaveText(["Fig"]);
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByText("Picked: Fig")).toBeVisible();
    await expectScrollLocked(page, false);

    // Scroll area: its viewport's (nonce'd) rule hides the native scrollbar.
    await expect(page.locator('[data-slot="scroll-area-viewport"]')).toHaveCSS("scrollbar-width", "none");

    expect(await stylesCarryNonce(page)).toMatchObject({ unnonced: 0 });
    expect(await violations.events()).toEqual([]);
    expect(violations.console).toEqual([]);

    // The policy is the one enforced: a <style> without the nonce, and a style attribute set from
    // markup, are both refused (and would have been reported above).
    const refused = await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "body { outline: 3px solid; }";
      document.head.append(style);
      const host = document.createElement("div");
      host.innerHTML = '<p style="outline: 3px solid">x</p>';
      document.body.append(host);
      return [getComputedStyle(document.body).outlineStyle, getComputedStyle(host.firstElementChild!).outlineStyle];
    });
    expect(refused).toEqual(["none", "none"]);
    await expect.poll(async () => (await violations.events()).map((violation) => violation.directive).sort()).toEqual(["style-src-attr", "style-src-elem"]);
  } finally {
    await context.close();
  }
});
