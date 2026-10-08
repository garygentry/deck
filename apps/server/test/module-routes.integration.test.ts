/**
 * Module routes and health through the real app: `/api/m/<id>`, declared legacy aliases,
 * declared root paths vs the SPA fallback, and `/api/health.modules`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DisabledRouteDecl, RoutesDecl } from "@deck/module-sdk";
import { Hono, type Context, type Next } from "hono";
import type { Logger } from "pino";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { DeckConfig, HealthResponse } from "../src/contract/index.js";
import { ModuleInitError, type ModuleHost } from "../src/modules/host.js";
import { createApp, kernelRouteTable } from "../src/server/app.js";
import { testHost, testModule } from "./util/modules.js";

// The static/SPA fallback is Bun-only; stand in a fake that serves "index" for rewrites.
vi.mock("hono/bun", () => ({
  serveStatic: () => async (_context: Context, next: Next) => next(),
}));

/** A web dist directory whose \`index.html\` the SPA fallback serves. */
const webDist = mkdtempSync(join(tmpdir(), "deck-web-dist-"));
writeFileSync(join(webDist, "index.html"), "<!doctype html>index");
afterAll(() => rmSync(webDist, { recursive: true, force: true }));

const config = { schemaVersion: 2, estate: { name: "x" } } as DeckConfig;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const providers = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] };

function appWith(host: ModuleHost, webDistDir?: string) {
  return createApp({ config, providers, logger, modules: host, ...(webDistDir ? { webDistDir } : {}) });
}

async function startedHost() {
  const { host } = testHost([
    testModule(
      {
        id: "usage",
        contributes: { routes: { legacyAliases: ["/api/usage-v1"], rootPaths: ["/usage.txt"] } },
        health: { legacyKey: "llmUsage" },
      },
      (ctx) => {
        ctx.http.get("/", (c) => c.json({ enabled: true, via: c.req.path }));
        ctx.http.get("/refresh", (c) => c.json({ refreshed: true }));
        ctx.http.post("/ingest", (c) => c.body(null, 204));
        ctx.rootRoute("/usage.txt", () => new Response("usage 1\n", { headers: { "content-type": "text/plain" } }));
        ctx.health.report(() => ({ state: "error", detail: "upstream down", data: { mode: "backoff", lastPollAt: null, consecutiveErrors: 3 } }));
      },
    ),
    testModule({ id: "off", enabledBy: { config: true } }, (ctx) => {
      ctx.http.get("/", (c) => c.text("never"));
    }),
  ]);
  await host.start();
  return host;
}

describe("module routes", () => {
  it("serves a root-only module's root path, and mounts no /api/m prefix for it", async () => {
    const { host } = testHost([testModule({ id: "probe", contributes: { routes: { rootPaths: ["/probe.txt"] } } }, (ctx) => {
      ctx.rootRoute("/probe.txt", () => new Response("probe ok\n", { headers: { "content-type": "text/plain" } }));
    })]);
    await host.start();
    const app = appWith(host);
    const response = await app.request("/probe.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("probe ok\n");
    expect(app.routes.some((route) => route.path.startsWith("/api/m/probe"))).toBe(false);
  });

  it("mounts a module whose only route is its own catch-all", async () => {
    const { host } = testHost([testModule({ id: "catcher" }, (ctx) => {
      ctx.http.all("*", (c) => c.text(`caught ${c.req.path}`));
    })]);
    await host.start();
    const response = await appWith(host).request("/api/m/catcher/anything");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("caught /api/m/catcher/anything");
  });

  it("mounts nothing for a module with no routes at all", async () => {
    const { host } = testHost([testModule({ id: "quiet" })]);
    await host.start();
    const app = appWith(host);
    expect(app.routes.some((route) => route.path.startsWith("/api/m/quiet"))).toBe(false);
    expect((await app.request("/api/m/quiet")).status).toBe(404);
  });

  it("mounts a module's sub-app at /api/m/<id>", async () => {
    const app = appWith(await startedHost());
    const response = await app.request("/api/m/usage");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, via: "/api/m/usage" });
    expect(await (await app.request("/api/m/usage/refresh")).json()).toEqual({ refreshed: true });
  });

  it("serves the same routes at each declared legacy alias", async () => {
    const app = appWith(await startedHost());
    expect(await (await app.request("/api/usage-v1")).json()).toEqual({ enabled: true, via: "/api/usage-v1" });
    expect(await (await app.request("/api/usage-v1/refresh")).json()).toEqual({ refreshed: true });
    expect((await app.request("/api/usage-v1/ingest", { method: "POST" })).status).toBe(204);
  });

  it("boots with the kernel route table: a colliding module is disabled and the kernel route still answers (N3)", async () => {
    const { host } = testHost(
      [testModule({ id: "shadow", contributes: { routes: { legacyAliases: ["/api/providers/x"] } } }, (ctx) => {
        ctx.http.get("/", (c) => c.text("module"));
      })],
      { kernelRoutes: kernelRouteTable({ config, providers, logger }) },
    );
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/shadow" })]);
    await host.start();
    const app = createApp({ config, providers, logger, modules: host });
    const response = await app.request("/api/providers/x");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("answers a late registration inside a module request with a 500, not a crash (N2)", async () => {
    const { host } = testHost([testModule({ id: "late" }, (ctx) => {
      ctx.http.get("/register", (c) => {
        ctx.scheduler.schedule({ name: "x", run: async () => {}, cadence: () => 1 });
        return c.text("unreachable");
      });
    })]);
    await host.start();
    const response = await appWith(host).request("/api/m/late/register");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error", code: "INTERNAL" });
  });

  // Backstop: planning given no kernel table still never lets a kernel route silently win.
  it.each<[string, RoutesDecl, string]>([
    ["a legacy alias", { legacyAliases: ["/api/config"] }, 'route prefix "/api/config" collides with kernel route GET /api/config'],
    ["an alias under a parameterised kernel route (C1)", { legacyAliases: ["/api/providers/custom"] }, "collides with kernel route GET /api/providers/:id"],
    ["an alias above kernel routes", { legacyAliases: ["/api/providers"] }, "collides with kernel route GET /api/providers"],
  ])("refuses %s the kernel already serves instead of being silently shadowed", async (_label, routes, message) => {
    const { host } = testHost([testModule({ id: "dup", contributes: { routes } }, (ctx) => {
      for (const path of routes.rootPaths ?? []) ctx.rootRoute(path, () => new Response("x"));
    })]);
    await host.start();
    expect(() => createApp({ config, providers, logger, modules: host })).toThrow(message);
  });

  it("refuses at mount a root path the kernel reserves there, even one planning was not told about", async () => {
    const { host } = testHost([testModule({ id: "dup", contributes: { routes: { rootPaths: ["/kernel.txt"] } } }, (ctx) => {
      ctx.rootRoute("/kernel.txt", () => new Response("x"));
    })]);
    await host.start();
    expect(() => host.mount(new Hono(), { reservedRootPaths: ["/kernel.txt"] })).toThrow('root path "/kernel.txt" is reserved by the kernel');
  });

  it("mounts a sibling alias next to a kernel route without false collisions", async () => {
    const { host } = testHost([testModule({ id: "sib", contributes: { routes: { legacyAliases: ["/api/providers-v0", "/api/m-legacy"] } } }, (ctx) => {
      ctx.http.get("/", (c) => c.text("sib"));
    })]);
    await host.start();
    const app = createApp({ config, providers, logger, modules: host });
    expect(await (await app.request("/api/providers-v0")).text()).toBe("sib");
    expect(await (await app.request("/api/m-legacy")).text()).toBe("sib");
  });

  it("keeps a wildcard root-path module out of the router entirely (C2)", async () => {
    const { host } = testHost([testModule({ id: "grabby", contributes: { routes: { rootPaths: ["/:prefix/*"] } } }, (ctx) => {
      ctx.rootRoute("/:prefix/*", () => new Response("hijacked"));
    })]);
    await host.start();
    const app = createApp({ config, providers, logger, modules: host });
    const response = await app.request("/api/unknown");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });

  it("reserves a disabled module's declared root paths from the SPA fallback (C7)", async () => {
    const { host } = testHost([testModule({ id: "feed", enabledBy: { config: true }, contributes: { routes: { rootPaths: ["/feed.txt"] } } }, (ctx) => {
      ctx.rootRoute("/feed.txt", () => new Response("feed"));
    })]);
    await host.start();
    expect(host.rootPaths()).toEqual(["/feed.txt"]);
    const app = appWith(host, webDist);
    expect((await app.request("/feed.txt")).status).toBe(404);
    expect(await (await app.request("/hosts/gov")).text()).toBe("<!doctype html>index");
  });

  it("answers a disabled module's paths with the API's JSON 404", async () => {
    const app = appWith(await startedHost());
    const response = await app.request("/api/m/off");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });

  it("answers a switched-off module's declared whenDisabled routes at its prefixes, running none of its code", async () => {
    const init = vi.fn();
    const whenDisabled: DisabledRouteDecl[] = [
      { method: "GET", path: "", status: 200, body: { enabled: false } },
      { method: "POST", path: "/jobs/:id", status: 403, body: { error: "Off.", code: "GADGET_OFF" } },
    ];
    const { host } = testHost([testModule({ id: "gadget", enabledBy: { env: "GADGET_ON" }, contributes: { routes: { legacyAliases: ["/api/gadget"], whenDisabled } } }, init)]);
    await host.start();
    const app = createApp({ config, providers, logger, modules: host });
    for (const prefix of ["/api/m/gadget", "/api/gadget"]) {
      const probe = await app.request(prefix);
      expect(probe.status).toBe(200);
      expect(await probe.text()).toBe('{"enabled":false}');
      const refused = await app.request(`${prefix}/jobs/7`, { method: "POST" });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe('{"error":"Off.","code":"GADGET_OFF"}');
      // Anything undeclared is the API's JSON 404, as for any unknown path.
      expect((await app.request(`${prefix}/jobs/7`)).status).toBe(404);
    }
    expect(init).not.toHaveBeenCalled();
  });

  it("serves the module's own routes, not its whenDisabled answers, while it runs", async () => {
    const whenDisabled: DisabledRouteDecl[] = [{ method: "GET", path: "", status: 200, body: { enabled: false } }];
    const { host } = testHost([testModule({ id: "gadget", contributes: { routes: { whenDisabled } } }, (ctx) => {
      ctx.http.get("/", (c) => c.json({ enabled: true }));
    })]);
    await host.start();
    const app = createApp({ config, providers, logger, modules: host });
    expect(await (await app.request("/api/m/gadget")).json()).toEqual({ enabled: true });
  });

  it.each<[string, unknown, string]>([
    ["a list", { method: "GET", path: "", status: 200, body: {} }, "whenDisabled must be a list of routes"],
    ["a method", [{ method: "HEAD", path: "", status: 200, body: {} }], 'whenDisabled route method "HEAD" must be one of'],
    ["a path", [{ method: "GET", path: "/a/../b", status: 200, body: {} }], 'whenDisabled route path "/a/../b"'],
    ["a wildcard", [{ method: "GET", path: "/*", status: 200, body: {} }], 'whenDisabled route path "/*"'],
    ["a status", [{ method: "GET", path: "", status: 99, body: {} }], 'whenDisabled route GET "" status must be an integer from 200 to 599'],
    ["a body", [{ method: "GET", path: "", status: 200 }], 'whenDisabled route GET "" must have a body'],
    ["a status with a body (204)", [{ method: "POST", path: "/x", status: 204, body: {} }], 'whenDisabled route POST "/x" status 204 cannot carry a body'],
    ["a status with a body (205)", [{ method: "POST", path: "/x", status: 205, body: {} }], "status 205 cannot carry a body"],
    ["a status with a body (304)", [{ method: "GET", path: "/x", status: 304, body: {} }], "status 304 cannot carry a body"],
    ["unique routes", [{ method: "GET", path: "", status: 200, body: {} }, { method: "GET", path: "", status: 403, body: {} }], 'whenDisabled route GET "" is declared twice'],
  ])("disables a module whose whenDisabled is malformed: %s", (_label, whenDisabled, message) => {
    const { host } = testHost([testModule({ id: "bad", contributes: { routes: { whenDisabled } as RoutesDecl } })]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining(message) })]);
  });

  it("serves declared root paths ahead of the SPA fallback, which still serves other paths", async () => {
    const host = await startedHost();
    expect(host.rootPaths()).toEqual(["/usage.txt"]);
    const app = appWith(host, webDist);
    const root = await app.request("/usage.txt");
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("usage 1\n");
    expect(await (await app.request("/hosts/gov")).text()).toBe("<!doctype html>index");
  });

  it("refuses a root route the manifest does not declare", async () => {
    const { host } = testHost([testModule({ id: "sneaky" }, (ctx) => {
      ctx.rootRoute("/admin", () => new Response("x"));
    })]);
    const failure = await host.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModuleInitError);
    expect(String((failure as Error).message)).toContain('root path "/admin" without declaring it');
  });
});

describe("/api/health with modules", () => {
  it("keeps every existing field, mirrors legacy keys, and adds modules without degrading status", async () => {
    const app = appWith(await startedHost());
    const body = (await (await app.request("/api/health")).json()) as HealthResponse;
    expect(Object.keys(body)).toEqual(["status", "uptimeMs", "providerCount", "providers", "llmUsage", "modules"]);
    expect(body).toEqual({
      status: "ok",
      uptimeMs: expect.any(Number),
      providerCount: 0,
      providers: {},
      llmUsage: { mode: "backoff", lastPollAt: null, consecutiveErrors: 3 },
      modules: {
        off: { state: "disabled", detail: "not enabled: no modules.off section" },
        usage: { state: "error", detail: "upstream down", data: { mode: "backoff", lastPollAt: null, consecutiveErrors: 3 } },
      },
    });
  });

  it.each<[string, () => unknown]>([
    ["cyclic data", () => {
      const data: Record<string, unknown> = {};
      data.self = data;
      return { state: "ok", data };
    }],
    ["bigint data", () => ({ state: "ok", data: { n: 1n } })],
    ["a non-string detail", () => ({ state: "ok", detail: { not: "text" } })],
  ])("isolates a reporter returning %s as the module's error entry, never a 500 (C6)", async (_label, report) => {
    const { host } = testHost([testModule({ id: "bad", health: { legacyKey: "badLegacy" } }, (ctx) => ctx.health.report(report as never))]);
    await host.start();
    const response = await appWith(host).request("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthResponse & Record<string, unknown>;
    expect(body.modules).toEqual({ bad: { state: "error", detail: "Module health unavailable" } });
    expect(body).not.toHaveProperty("badLegacy");
    expect(body.status).toBe("ok");
  });

  it("reports modules: {} when there is no module host", async () => {
    const app = createApp({ config, providers, logger });
    const body = (await (await app.request("/api/health")).json()) as HealthResponse;
    expect(body.modules).toEqual({});
  });
});
