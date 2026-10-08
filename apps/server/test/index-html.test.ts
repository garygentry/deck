/**
 * The web shell's `index.html` as the server serves it: the brand title and the boot object
 * (`DeckBoot`) are written in on every serve of the page, at `/`, `/index.html` and every
 * SPA path, while static files pass through untouched.
 */

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readDeckBoot } from "@deck/contract";
import type { UiManifest } from "@deck/module-sdk";
import type { Context, Next } from "hono";
import type { Logger } from "pino";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/server/app.js";
import { deckBootOf, renderIndexHtml } from "../src/server/index-html.js";

vi.mock("hono/bun", () => ({
  serveStatic: () => async (context: Context, next: Next) =>
    context.req.path === "/assets/app.js" ? context.text("asset") : next(),
}));

/** The real template: Vite keeps the boot element as written (its plugin only inlines the pre-paint script). */
const TEMPLATE = readFileSync(fileURLToPath(new URL("../../web/index.html", import.meta.url)), "utf8");
const dist = mkdtempSync(join(tmpdir(), "deck-index-"));
writeFileSync(join(dist, "index.html"), TEMPLATE);
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => logger } as unknown as Logger;
const providers = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] };
const manifest = (title: string, home: UiManifest["home"] = { page: "page:inventory/hosts", path: "/hosts" }) =>
  ({ brand: { title }, home }) as unknown as UiManifest;

/** The boot object as the shell reads it, from served HTML. */
function bootIn(html: string) {
  const match = /<script type="application\/json" id="deck-boot">([^<]*)<\/script>/.exec(html);
  return readDeckBoot({ getElementById: () => ({ textContent: match?.[1] ?? null }) });
}

describe("the served index.html", () => {
  const app = createApp({
    config: { schemaVersion: 2, estate: { name: "lab" }, ui: { theme: { mode: "dark" } } },
    providers,
    logger,
    ui: manifest("Gentry Lab"),
    webDistDir: dist,
  });

  it.each(["/", "/index.html", "/hosts/nas-01", "/portal"])("writes the brand and boot object in at %s", async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const html = await response.text();
    expect(html).toContain("<title>Gentry Lab</title>");
    expect(bootIn(html)).toEqual({ brand: { title: "Gentry Lab" }, theme: { mode: "dark" }, home: "page:inventory/hosts" });
  });

  it("passes static files and /api through", async () => {
    expect(await (await app.request("/assets/app.js")).text()).toBe("asset");
    expect((await app.request("/api/nope")).status).toBe(404);
  });

  it("escapes a title that would break out of the element", () => {
    const html = renderIndexHtml(TEMPLATE, deckBootOf(manifest('</title><script>alert("x")</script>'), {}));
    expect(html).toContain("<title>&#60;/title&#62;&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</title>");
    expect(html).not.toContain("<script>alert");
    // Inside the JSON, `<` is <, so the element cannot be closed early, and the title survives.
    expect(bootIn(html).brand?.title).toBe('</title><script>alert("x")</script>');
  });

  it("carries the home page's id, null when no page can be home, and none without a manifest", () => {
    expect(deckBootOf(manifest("Lab", null), {}).home).toBeNull();
    expect(deckBootOf(manifest("Lab", { page: "page:portal/overview", path: "/portal" }), {}).home).toBe("page:portal/overview");
    expect(bootIn(renderIndexHtml(TEMPLATE, deckBootOf(manifest("Lab", null), {}))).home).toBeNull();
  });

  it("defaults the title to Deck and the mode to none without a manifest or ui.theme", () => {
    expect(deckBootOf(undefined, {})).toEqual({ bootApi: 1, brand: { title: "Deck" }, theme: {} });
    expect(deckBootOf(undefined, { ui: { theme: { mode: "neon" } } }).theme).toEqual({});
  });

  it("serves a template without the boot element as it is, but titled", () => {
    expect(renderIndexHtml("<title>Deck</title><body></body>", deckBootOf(manifest("Lab"), {}))).toBe("<title>Lab</title><body></body>");
  });

  it("re-reads index.html when it changes (a rebuilt dist), and not otherwise", async () => {
    const changing = mkdtempSync(join(tmpdir(), "deck-index-changing-"));
    try {
      const file = join(changing, "index.html");
      writeFileSync(file, "<title>Deck</title>one");
      utimesSync(file, 1_000, 1_000);
      const served = createApp({ config: { schemaVersion: 2, estate: { name: "lab" } }, providers, logger, webDistDir: changing });
      expect(await (await served.request("/")).text()).toBe("<title>Deck</title>one");
      writeFileSync(file, "<title>Deck</title>two");
      utimesSync(file, 1_000, 1_000);
      // Same mtime: the cached copy stands (one stat, no read).
      expect(await (await served.request("/")).text()).toBe("<title>Deck</title>one");
      utimesSync(file, 2_000, 2_000);
      expect(await (await served.request("/hosts")).text()).toBe("<title>Deck</title>two");
      rmSync(file);
      expect((await served.request("/hosts")).status).toBe(404);
    } finally {
      rmSync(changing, { recursive: true, force: true });
    }
  });

  it("404s an SPA path while the dist has no index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "deck-index-empty-"));
    try {
      const bare = createApp({ config: { schemaVersion: 2, estate: { name: "lab" } }, providers, logger, webDistDir: empty });
      expect((await bare.request("/hosts")).status).toBe(404);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
