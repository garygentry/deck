/**
 * The browser policy deck sends: the web shell's Content-Security-Policy (a fresh script nonce
 * per response, stamped on every script of the page; frames limited to the manifest's
 * `core/embed` origins), and on every response `frame-ancestors`, `X-Frame-Options` and
 * `nosniff`, with `ui.frameAncestors` as the knob.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validate } from "@deck/schema";
import type { UiManifest } from "@deck/module-sdk";
import type { Context, Next } from "hono";
import type { Logger } from "pino";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { createApp } from "../src/server/app.js";
import { FRAME_ANCESTOR, frameAncestorsOf, frameOriginsOf, shellPolicy } from "../src/server/security-headers.js";

vi.mock("hono/bun", () => ({
  serveStatic: () => async (context: Context, next: Next) =>
    context.req.path === "/assets/app.js" ? context.text("asset") : next(),
}));

/** A built page's shape: the import map and pre-paint script inline, the app as a module script. */
const TEMPLATE = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "  <head>",
  "    <script type=\"importmap\">{\"imports\":{\"react\":\"/assets/react.js\"}}</script>",
  "    <title>Deck</title>",
  "    <script type=\"application/json\" id=\"deck-boot\"></script>",
  "    <script>(function () { document.documentElement.classList.toggle(\"dark\", false); })();</script>",
  "    <script type=\"module\" crossorigin src=\"/assets/index.js\"></script>",
  "  </head>",
  "  <body><div id=\"app\"></div></body>",
  "</html>",
].join("\n");
const dist = mkdtempSync(join(tmpdir(), "deck-csp-"));
writeFileSync(join(dist, "index.html"), TEMPLATE);
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => logger } as unknown as Logger;
const providers = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [], setProjections: () => {} };

const embed = (url: string) => ({ id: "widget:ui/lab.e", type: "core/embed", source: null, options: { url }, span: 1, rows: 1 });
const manifestWith = (allowUnsafeEmbeds: boolean, urls: string[]) =>
  ({
    brand: { title: "Lab" },
    home: null,
    ...(allowUnsafeEmbeds ? { allowUnsafeEmbeds: true } : {}),
    pages: [{ id: "page:ui/lab", module: "ui", path: "/lab", title: "Lab", component: "ConfigPage", layout: { sections: [{ columns: 2, widgets: urls.map(embed) }] } }],
    extensions: [{ id: "widget:ui/slot.e", kind: "widget", type: "core/embed", options: { url: "https://placed.example:8443/x" } }],
  }) as unknown as UiManifest;

function appWith(options: { ui?: UiManifest; frameAncestors?: string[] } = {}) {
  const config = { schemaVersion: 2, estate: { name: "lab" }, ...(options.frameAncestors === undefined ? {} : { ui: { frameAncestors: options.frameAncestors } }) } as DeckConfig;
  return createApp({ config, providers, logger, ui: options.ui ?? manifestWith(false, []), webDistDir: dist });
}

/** The directives of a policy, by name. */
function directives(policy: string | null): Record<string, string> {
  return Object.fromEntries((policy ?? "").split(";").map((part) => part.trim().split(/\s+/)).filter((words) => words[0] !== "").map(([name, ...values]) => [name!, values.join(" ")]));
}

describe("the web shell's Content-Security-Policy", () => {
  it("names a fresh nonce per response, carried by every script of the page, and is never cached apart from it", async () => {
    const app = appWith();
    const seen = new Set<string>();
    for (const path of ["/", "/index.html", "/hosts/nas-01", "/", "/lab"]) {
      const response = await app.request(path);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      const policy = directives(response.headers.get("content-security-policy"));
      const nonce = /^'self' 'nonce-([A-Za-z0-9+/]{22}==)'$/.exec(policy["script-src"]!)?.[1];
      expect(nonce, path).toBeDefined();
      seen.add(nonce!);
      const html = await response.text();
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts).toHaveLength(4);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    }
    expect(seen.size).toBe(5);
  });

  it("allows deck's own scripts, styles and requests, images over http(s), and nothing else by default", async () => {
    const policy = directives((await appWith().request("/")).headers.get("content-security-policy"));
    expect(policy).toMatchObject({
      "default-src": "'self'",
      "style-src": "'self' 'unsafe-inline'",
      "img-src": "'self' data: blob: http: https:",
      "font-src": "'self' data:",
      "connect-src": "'self'",
      "frame-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'self'",
      "frame-ancestors": "'self'",
    });
    expect(policy["script-src"]).not.toMatch(/unsafe|strict-dynamic|\*/);
  });

  it("frames only the core/embed origins of the manifest while it allows embeds, never deck's own", async () => {
    const urls = ["https://grafana.example.net/d/ups?kiosk", "http://10.0.0.5:3000/x", "https://grafana.example.net/other", "http://[::1]:8080/", "not a url"];
    const on = directives((await appWith({ ui: manifestWith(true, urls) }).request("/")).headers.get("content-security-policy"));
    expect(on["frame-src"]).toBe("http://10.0.0.5:3000 https://grafana.example.net https://placed.example:8443");
    expect(on["frame-src"]).not.toContain("'self'");
    const off = directives((await appWith({ ui: manifestWith(false, urls) }).request("/")).headers.get("content-security-policy"));
    expect(off["frame-src"]).toBe("'none'");
  });

  it("writes the framed origins into the boot object, so a widget added later can ask for a reload", async () => {
    const html = await (await appWith({ ui: manifestWith(true, ["https://grafana.example.net/d"]) }).request("/")).text();
    expect(html).toContain("\"frameOrigins\":[\"https://grafana.example.net\",\"https://placed.example:8443\"]");
  });

  it("builds the same policy from its parts", () => {
    expect(shellPolicy({ nonce: "n", frameOrigins: ["https://a.example"], frameAncestors: ["https://ha.example"] })).toBe(
      "default-src 'self'; script-src 'self' 'nonce-n'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self'; frame-src https://a.example; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://ha.example",
    );
    expect(frameOriginsOf(undefined)).toEqual([]);
  });
});

describe("frame-ancestors on every response", () => {
  const paths = ["/", "/assets/app.js", "/api/health", "/api/nope", "/modules/x/web.js", "/nope.png"];

  it.each(paths)("by default, %s may be framed by deck's own origin only (with X-Frame-Options and nosniff)", async (path) => {
    const response = await appWith().request(path);
    expect(directives(response.headers.get("content-security-policy"))["frame-ancestors"]).toBe("'self'");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(paths)("with ui.frameAncestors, %s may be framed by those origins too, and X-Frame-Options is not sent", async (path) => {
    const response = await appWith({ frameAncestors: ["https://ha.example.net", "https://*.lab.example"] }).request(path);
    expect(directives(response.headers.get("content-security-policy"))["frame-ancestors"]).toBe("'self' https://ha.example.net https://*.lab.example");
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("only the shell carries the full policy; other responses carry frame-ancestors alone", async () => {
    expect(Object.keys(directives((await appWith().request("/api/health")).headers.get("content-security-policy")))).toEqual(["frame-ancestors"]);
  });
});

describe("ui.frameAncestors", () => {
  const config = (frameAncestors: unknown) => ({ schemaVersion: 2, estate: { name: "lab" }, ui: { frameAncestors } });

  it.each([["https://ha.example.net"], ["http://10.0.0.5:8123"], ["https://*.example.net"], ["http://homeassistant"]])("accepts %s", (origin) => {
    expect(validate(config([origin])).findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(FRAME_ANCESTOR.test(origin)).toBe(true);
  });

  it.each([["https://ha.example.net/path"], ["ftp://ha.example.net"], ["'self'"], ["*"], ["https://ha.example.net; script-src *"], ["https://a.example/"], ["javascript:alert(1)"]])("refuses %s", (origin) => {
    expect(validate(config([origin])).findings).toContainEqual(expect.objectContaining({ code: "SCHEMA_INVALID", severity: "error" }));
    expect(FRAME_ANCESTOR.test(origin)).toBe(false);
    // Even past validation, a value the pattern refuses never reaches the header.
    expect(frameAncestorsOf(config([origin]))).toEqual([]);
  });
});
