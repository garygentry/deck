import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { startSpecApi, stopSpecApi, type SpecApi } from "./spec-api.js";

/**
 * The web shell under its Content-Security-Policy, as deck serves a production build: every
 * page the UI manifest routes, in light and dark, with a runtime module's web half (loaded
 * through the import map), framed pages, a markdown image and a brand logo, raises no CSP
 * violation (neither a `securitypolicyviolation` event nor a console report). And the policy
 * holds: a framed page that redirects into deck's own origin is refused.
 *
 * The suite's Vite dev server sends no policy, so this spec builds the shell (or reuses the
 * build DECK_E2E_WEB_DIST names) and boots its own API serving it.
 */

const webDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const examples = join(webDir, "..", "..", "examples", "modules");

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0a7"/></svg>';

let api: SpecApi;
let helper: Server;
let helperOrigin: string;
let builtDist: string | undefined;

test.describe.configure({ mode: "serial", timeout: 600_000 });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  let dist = process.env.DECK_E2E_WEB_DIST;
  if (dist === undefined) {
    builtDist = dist = mkdtempSync(join(tmpdir(), "deck-e2e-csp-dist-"));
    execFileSync("bunx", ["vite", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: webDir, stdio: "inherit" });
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

  const markdown = `Runbook notes.\n\n![status](${helperOrigin}/logo.svg)`;
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
    DECK_MODULES_DIR: examples,
    DECK_MODULES_ENABLED: "true",
  });
  deckOrigin = `http://127.0.0.1:${api.port}`;
});

test.afterAll(async () => {
  if (api !== undefined) await stopSpecApi(api);
  await new Promise((resolve) => helper?.close(resolve));
  if (builtDist !== undefined) rmSync(builtDist, { recursive: true, force: true });
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

/** The paths the manifest routes (no parameters), plus the runtime module's page. */
async function routedPaths(): Promise<string[]> {
  const manifest = (await (await fetch(`${origin()}/api/ui`)).json()) as { pages: { path: string }[] };
  return [...new Set(["/", ...manifest.pages.map((page) => page.path).filter((path) => !path.includes(":"))])].filter((path) => path !== "/escape");
}

test("serves the shell with an enforced policy and a per-response nonce", async () => {
  const first = await fetch(`${origin()}/`);
  const second = await fetch(`${origin()}/`);
  const policy = first.headers.get("content-security-policy") ?? "";
  expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
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
      expect(paths).toEqual(expect.arrayContaining(["/", "/csp", "/maintenance", "/hosts", "/docs"]));
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
      // The runtime module's web half (an import-mapped ESM chunk) rendered its page.
      await page.goto("/maintenance");
      await expect(page.getByText("Patch night")).toBeVisible({ timeout: 30_000 });
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
