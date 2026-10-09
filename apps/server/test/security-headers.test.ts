/**
 * The browser policy deck sends: the web shell's Content-Security-Policy (a fresh script nonce
 * per response, stamped on every script of the page; frames limited to the manifest's
 * `core/embed` origins), and on every response `frame-ancestors`, `X-Frame-Options` and
 * `nosniff`, with `ui.frameAncestors` as the knob.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validate } from "@deck/schema";
import deckSchema from "@deck/schema/deck.schema.json" with { type: "json" };
import { ORIGIN_SETTING_PATTERN } from "@deck/schema/embed";
import type { UiManifest } from "@deck/module-sdk";
import { Hono, type Context, type Next } from "hono";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { createApp } from "../src/server/app.js";
import { embedOriginsOf, frameAncestorsOf, frameOriginsFor, mutableCopy, ORIGIN_SETTING, requestOrigins, securityHeaders, shellPolicy, sourceMatches } from "../src/server/security-headers.js";

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
    extensions: [{ id: "widget:ops/slot.e", kind: "widget", module: "ops", slot: "portal/summary", order: 1, widget: { type: "core/embed", options: { url: "https://placed.example:8443/x" } } }],
  }) as unknown as UiManifest;

function appWith(options: { ui?: UiManifest; frameAncestors?: string[]; frameSources?: string[] } = {}) {
  const ui = {
    ...(options.frameAncestors === undefined ? {} : { frameAncestors: options.frameAncestors }),
    ...(options.frameSources === undefined ? {} : { frameSources: options.frameSources }),
  };
  const config = { schemaVersion: 2, estate: { name: "lab" }, ui } as DeckConfig;
  return createApp({ config, providers, logger, ui: options.ui ?? manifestWith(false, []), webDistDir: dist });
}

/**
 * The policies a Content-Security-Policy header holds (a header sent twice reads as one,
 * comma-joined), each as its directives by name.
 */
function policies(header: string | null): Record<string, string>[] {
  return (header ?? "").split(",").map((policy) => Object.fromEntries(policy.split(";").map((part) => part.trim().split(/\s+/)).filter((words) => words[0] !== "").map(([name, ...values]) => [name!, values.join(" ")])));
}

/** The shell's own policy (the one naming `script-src`); the framing policy is separate. */
function directives(header: string | null): Record<string, string> {
  return policies(header).find((policy) => "script-src" in policy) ?? {};
}

/** The framing policies of a response: every `frame-ancestors` it carries. */
function ancestors(header: string | null): string[] {
  return policies(header).flatMap((policy) => (policy["frame-ancestors"] === undefined ? [] : [policy["frame-ancestors"]]));
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
    });
    expect(ancestors((await appWith().request("/")).headers.get("content-security-policy"))).toEqual(["'self'"]);
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
    expect(shellPolicy({ nonce: "n", frameOrigins: ["https://a.example"] })).toBe(
      "default-src 'self'; script-src 'self' 'nonce-n'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self'; frame-src https://a.example; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(embedOriginsOf(undefined)).toEqual([]);
  });

  it("walks placed widgets only, once per manifest", () => {
    const manifest = { ...manifestWith(true, ["https://grafana.example.net/d"]), stray: { type: "core/embed", options: { url: "https://stray.example" } } } as unknown as UiManifest;
    const origins = embedOriginsOf(manifest);
    expect(origins).toEqual(["https://grafana.example.net", "https://placed.example:8443"]);
    expect(embedOriginsOf(manifest)).toBe(origins);
  });

  describe("never frames deck's own origin", () => {
    const urls = ["https://deck.example.net/portal", "https://grafana.example.net/d"];

    it("as the request reached it (Host)", async () => {
      const response = await appWith({ ui: manifestWith(true, urls) }).request("https://deck.example.net/");
      expect(directives(response.headers.get("content-security-policy"))["frame-src"]).toBe("https://grafana.example.net https://placed.example:8443");
      expect(await response.text()).toContain('"frameOrigins":["https://grafana.example.net","https://placed.example:8443"]');
    });

    it("behind the reverse proxy (X-Forwarded-Host and -Proto)", async () => {
      const response = await appWith({ ui: manifestWith(true, urls) }).request("http://deck:8095/", { headers: { "X-Forwarded-Host": "deck.example.net", "X-Forwarded-Proto": "https" } });
      expect(directives(response.headers.get("content-security-policy"))["frame-src"]).toBe("https://grafana.example.net https://placed.example:8443");
    });

    it("nor a ui.frameSources entry, or a wildcard, that covers it", async () => {
      const response = await appWith({ ui: manifestWith(true, ["https://grafana.example.net/d"]), frameSources: ["https://*.example.net", "https://deck.example.net", "https://auth.lab.example"] }).request("https://deck.example.net/");
      expect(directives(response.headers.get("content-security-policy"))["frame-src"]).toBe("https://auth.lab.example https://grafana.example.net https://placed.example:8443");
    });

    it("requestOrigins / sourceMatches", () => {
      const none = () => undefined;
      expect(requestOrigins("http://deck:8095/x", none)).toEqual(["http://deck:8095"]);
      expect(requestOrigins("http://deck:8095/x", (name) => ({ "x-forwarded-host": "deck.example.net, inner", "x-forwarded-proto": "https" })[name])).toEqual(["http://deck:8095", "https://deck.example.net"]);
      expect(requestOrigins("http://deck:8095/x", (name) => ({ "x-forwarded-host": "deck.example.net" })[name])).toEqual(["http://deck:8095", "http://deck.example.net", "https://deck.example.net"]);
      expect(sourceMatches("https://*.example.net", "https://deck.example.net")).toBe(true);
      expect(sourceMatches("https://*.example.net", "https://example.net")).toBe(false);
      expect(sourceMatches("http://deck.example.net", "https://deck.example.net")).toBe(true);
      expect(sourceMatches("https://deck.example.net:8443", "https://deck.example.net")).toBe(false);
      expect(sourceMatches("https://deck.example.net", "https://deck.example.net:443")).toBe(true);
      expect(frameOriginsFor(manifestWith(false, ["https://a.example"]), { ui: { frameSources: ["https://b.example"] } }, []).allowed).toEqual([]);
    });

    it("compares ports as numbers, and refuses a leading-zero port in the settings", () => {
      // Deck at https://deck.example: `:0443` is its port 443, exact or through a wildcard.
      expect(sourceMatches("https://deck.example:0443", "https://deck.example")).toBe(true);
      expect(sourceMatches("https://*.example:0443", "https://deck.example")).toBe(true);
      expect(sourceMatches("https://deck.example:443", "https://deck.example")).toBe(true);
      expect(sourceMatches("https://deck.example:8443", "https://deck.example")).toBe(false);
      for (const entry of ["https://deck.example:0443", "https://*.example:0443"]) {
        expect(ORIGIN_SETTING.test(entry)).toBe(false);
        for (const key of ["frameSources", "frameAncestors"]) {
          expect(validate({ schemaVersion: 2, estate: { name: "lab" }, ui: { [key]: [entry] } }).findings).toContainEqual(expect.objectContaining({ code: "SCHEMA_INVALID" }));
        }
        const { allowed } = frameOriginsFor(manifestWith(true, ["https://grafana.example.net/d"]), { ui: { frameSources: [entry] } }, ["https://deck.example"]);
        expect(allowed).not.toContain(entry);
      }
    });

    it("publishes an embed of deck's own origin (behind the proxy) as frameSelf, for the widget to name", async () => {
      const response = await appWith({ ui: manifestWith(true, ["http://deck.example/portal", "https://grafana.example.net/d"]) }).request("http://deck:8095/", { headers: { "X-Forwarded-Host": "deck.example", "X-Forwarded-Proto": "http" } });
      const html = await response.text();
      expect(html).toContain('"frameSelf":["http://deck.example"]');
      expect(directives(response.headers.get("content-security-policy"))["frame-src"]).not.toContain("deck.example ");
      const direct = await (await appWith({ ui: manifestWith(true, ["https://grafana.example.net/d"]) }).request("/")).text();
      expect(direct).not.toContain("frameSelf");
    });

    it("warns once per config about a ui.frameSources entry that covers deck, naming it", async () => {
      const warnings: unknown[] = [];
      const capturing = { ...logger, warn: (line: unknown) => void warnings.push(line) } as unknown as Logger;
      const config = { schemaVersion: 2, estate: { name: "lab" }, ui: { frameSources: ["https://*.example.net", "https://auth.example.org"] } } as DeckConfig;
      const app = createApp({ config, providers, logger: capturing, ui: manifestWith(true, ["https://grafana.example.net/d"]), webDistDir: dist });
      for (let i = 0; i < 3; i += 1) await app.request("https://deck.example.net/");
      expect(warnings.filter((line) => (line as { event?: string }).event === "ui.frame-source-dropped")).toEqual([{ event: "ui.frame-source-dropped", source: "https://*.example.net" }]);
    });
  });

  it("adds ui.frameSources while embeds are on (a sign-in portal the framed app redirects to)", async () => {
    const on = await appWith({ ui: manifestWith(true, ["https://grafana.example.net/d"]), frameSources: ["https://auth.example.net"] }).request("/");
    expect(directives(on.headers.get("content-security-policy"))["frame-src"]).toBe("https://auth.example.net https://grafana.example.net https://placed.example:8443");
    const off = await appWith({ ui: manifestWith(false, []), frameSources: ["https://auth.example.net"] }).request("/");
    expect(directives(off.headers.get("content-security-policy"))["frame-src"]).toBe("'none'");
  });
});

describe("frame-ancestors on every response", () => {
  const paths = ["/", "/assets/app.js", "/api/health", "/api/nope", "/modules/x/web.js", "/nope.png"];

  it.each(paths)("by default, %s may be framed by deck's own origin only (with X-Frame-Options and nosniff)", async (path) => {
    const response = await appWith().request(path);
    expect(ancestors(response.headers.get("content-security-policy"))).toEqual(["'self'"]);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(paths)("with ui.frameAncestors, %s may be framed by those origins too, and X-Frame-Options is not sent", async (path) => {
    const response = await appWith({ frameAncestors: ["https://ha.example.net", "https://*.lab.example"] }).request(path);
    expect(ancestors(response.headers.get("content-security-policy"))).toEqual(["'self' https://ha.example.net https://*.lab.example"]);
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("only the shell carries the full policy; other responses carry frame-ancestors alone", async () => {
    expect(policies((await appWith().request("/api/health")).headers.get("content-security-policy"))).toEqual([{ "frame-ancestors": "'self'" }]);
  });

  /** A bare app behind the middleware, with routes that set policies or answer immutable responses. */
  function routes(extra: string[]) {
    const upstream = new Hono();
    upstream.get("/", (context) => context.text("upstream", 200, { "X-Upstream": "yes" }));
    const app = new Hono();
    app.use("*", securityHeaders(() => extra));
    app.get("/strict", (context) => {
      context.header("Content-Security-Policy", "default-src 'none'");
      return context.text("strict");
    });
    app.get("/loose", (context) => {
      context.header("Content-Security-Policy", "frame-ancestors *");
      context.header("X-Frame-Options", "ALLOWALL");
      return context.text("loose");
    });
    app.get("/redirect", () => Response.redirect("https://deck.example.net/elsewhere", 302));
    app.get("/fetched", () => fetch(upstreamUrl));
    app.get("/locked", async () => locked(await upstream.request("/")));
    return app;
  }

  /**
   * Headers that refuse every change: a real `Headers` (so each runtime's own methods accept
   * it), as Node's `fetch()` and `Response.redirect` give; Bun gives mutable ones, so this is
   * how the copy path runs on both.
   */
  class LockedHeaders extends Headers {
    override set(): never {
      throw new TypeError("immutable");
    }
    override append(): never {
      throw new TypeError("immutable");
    }
    override delete(): never {
      throw new TypeError("immutable");
    }
  }

  /** `response` with locked headers. */
  async function locked(response: Response): Promise<Response> {
    const copy = new Response(await response.text(), { status: response.status, headers: response.headers });
    Object.defineProperty(copy, "headers", { value: new LockedHeaders(response.headers) });
    return copy;
  }

  /** A real listener for `fetch()`, whose responses are immutable under Node. */
  let upstreamServer: Server;
  let upstreamUrl = "";
  beforeAll(async () => {
    upstreamServer = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/plain", "X-Upstream": "yes" }).end("upstream"));
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise((resolve) => upstreamServer.close(resolve)));

  it.each([["a route's own strict policy", "/strict"], ["a route's permissive frame-ancestors *", "/loose"]])("keeps framing enforced beside %s", async (_label, path) => {
    for (const extra of [[], ["https://ha.example.net"]]) {
      const response = await routes(extra).request(path);
      const header = response.headers.get("content-security-policy");
      // The route's own policy stays, and deck's framing policy applies beside it.
      expect(policies(header)).toContainEqual({ "frame-ancestors": ["'self'", ...extra].join(" ") });
      expect(header).toContain(path === "/strict" ? "default-src 'none'" : "frame-ancestors *");
      expect(response.headers.get("x-frame-options")).toBe(extra.length === 0 ? "SAMEORIGIN" : null);
    }
  });

  it.each(["/redirect", "/fetched", "/locked"])("sets the headers on %s (immutable headers under Node; /locked on every runtime), without failing it", async (path) => {
    const response = await routes([]).request(path);
    expect(response.status).toBe(path === "/redirect" ? 302 : 200);
    expect(ancestors(response.headers.get("content-security-policy"))).toEqual(["'self'"]);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    if (path === "/redirect") expect(response.headers.get("location")).toBe("https://deck.example.net/elsewhere");
    else {
      expect(response.headers.get("x-upstream")).toBe("yes");
      expect(await response.text()).toBe("upstream");
    }
  });

  it("mutableCopy keeps the body, status and every header, set-cookie included", async () => {
    const headers = new LockedHeaders([["X-One", "1"], ["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]]);
    const original = new Response("body", { status: 201, statusText: "Made" });
    Object.defineProperty(original, "headers", { value: headers });
    const copy = mutableCopy(original);
    copy.headers.set("X-Two", "2");
    expect([copy.status, copy.statusText, await copy.text()]).toEqual([201, "Made", "body"]);
    expect(copy.headers.get("x-one")).toBe("1");
    expect(copy.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });
});

describe.each(["frameAncestors", "frameSources"] as const)("ui.%s", (key) => {
  const config = (origins: unknown) => ({ schemaVersion: 2, estate: { name: "lab" }, ui: { [key]: origins } });

  it("holds the same pattern as the server's check", () => {
    const ui = (deckSchema as unknown as { $defs: Record<string, { properties: Record<string, { items: { pattern: string } }> }> }).$defs.Ui!.properties;
    expect(ui[key]!.items.pattern).toBe(ORIGIN_SETTING_PATTERN);
    expect(ORIGIN_SETTING.source).toBe(new RegExp(ORIGIN_SETTING_PATTERN).source);
  });

  it.each([["https://ha.example.net"], ["http://10.0.0.5:8123"], ["https://*.example.net"], ["http://homeassistant"]])("accepts %s", (origin) => {
    expect(validate(config([origin])).findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(ORIGIN_SETTING.test(origin)).toBe(true);
  });

  it.each([["https://ha.example.net/path"], ["ftp://ha.example.net"], ["'self'"], ["*"], ["https://ha.example.net; script-src *"], ["https://a.example/"], ["javascript:alert(1)"]])("refuses %s", (origin) => {
    expect(validate(config([origin])).findings).toContainEqual(expect.objectContaining({ code: "SCHEMA_INVALID", severity: "error" }));
    expect(ORIGIN_SETTING.test(origin)).toBe(false);
    // Even past validation, a value the pattern refuses never reaches the header.
    if (key === "frameAncestors") expect(frameAncestorsOf(config([origin]))).toEqual([]);
    else expect(frameOriginsFor({ allowUnsafeEmbeds: true, pages: [] } as unknown as UiManifest, config([origin]), []).allowed).toEqual([]);
  });
});
