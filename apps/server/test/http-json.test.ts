import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules } from "../src/modules/host.js";
import { HttpJsonError, HttpJsonProvider, type HttpJsonConfig } from "../src/providers/http-json/index.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { makeConfigDir } from "./util/tmp-config.js";

const SECRET = "s3cr3t-value-never-echoed";

/** One request a fixture server saw. */
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Route = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A local fixture server: routes by path, records every request. */
class Fixture {
  readonly seen: Seen[] = [];
  readonly routes = new Map<string, Route>();
  private server!: Server;
  private readonly open = new Set<ServerResponse>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        this.open.add(res);
        res.on("close", () => this.open.delete(res));
        const route = this.routes.get(new URL(req.url ?? "/", "http://x").pathname);
        if (route === undefined) {
          res.writeHead(404).end();
          return;
        }
        route(req, res, body);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  url(path: string): string {
    return `${this.origin}${path}`;
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const json = (value: unknown, status = 200): Route => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
};
const redirect = (location: string, status = 302): Route => (_req, res) => {
  res.writeHead(status, { location }).end();
};

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

async function failure(provider: HttpJsonProvider): Promise<HttpJsonError> {
  const error = await provider.fetch().then(
    () => {
      throw new Error("expected the poll to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpJsonError);
  return error as HttpJsonError;
}

const fixture = new Fixture();
const other = new Fixture();

beforeAll(async () => {
  await fixture.start();
  await other.start();
  fixture.routes.set("/ok", json({ load: 42, outlets: [{ name: "a", watts: 5 }] }));
  fixture.routes.set("/text", (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>nope</html>"));
  fixture.routes.set("/empty", (_req, res) => res.writeHead(200).end());
  fixture.routes.set("/down", json({ error: SECRET }, 503));
  fixture.routes.set("/unauthorised", (req, res) => {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ echo: req.headers.authorization }));
  });
  fixture.routes.set("/hang", () => {});
  fixture.routes.set("/slow-body", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"partial":');
  });
  fixture.routes.set("/big-declared", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "2048" }).end(JSON.stringify({ pad: "x".repeat(2030) }));
  });
  fixture.routes.set("/big-chunked", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"pad":"');
    for (let i = 0; i < 64; i += 1) res.write("x".repeat(1024));
    res.end('"}');
  });
  fixture.routes.set("/echo", (req, res, body) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, body }));
  });
  other.routes.set("/ok", json({ other: true }));
});

afterAll(async () => {
  await fixture.stop();
  await other.stop();
});

afterEach(() => {
  fixture.seen.length = 0;
  other.seen.length = 0;
  stopScheduler();
});

describe("http-json provider: a 2xx JSON response", () => {
  it("is the data, parsed; literal headers and Accept are sent", async () => {
    const provider = new HttpJsonProvider("ups", { url: fixture.url("/ok"), headers: { "X-Client": "deck" } });
    await expect(provider.fetch()).resolves.toEqual({ load: 42, outlets: [{ name: "a", watts: 5 }] });
    expect(fixture.seen[0]).toMatchObject({ method: "GET", headers: { accept: "application/json", "x-client": "deck" } });
    expect(fixture.seen[0]!.headers.authorization).toBeUndefined();
    await expect(provider.health()).resolves.toEqual({ ok: true, detail: "HTTP 200" });
  });

  it("POSTs a JSON body", async () => {
    const provider = new HttpJsonProvider("q", { url: fixture.url("/echo"), method: "POST", body: { query: "{ up }" } });
    await expect(provider.fetch()).resolves.toEqual({ method: "POST", body: '{"query":"{ up }"}' });
    expect(fixture.seen[0]!.headers["content-type"]).toBe("application/json");
  });
});

describe("http-json provider: auth from the declared env var only", () => {
  const authed = (extra: Partial<HttpJsonConfig>) =>
    new HttpJsonProvider("api", { url: fixture.url("/ok"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: SECRET }), ...extra });

  it.each([
    ["no scheme: the raw Authorization value", {}, "authorization", SECRET],
    ["bearer", { auth: { scheme: "bearer" as const } }, "authorization", `Bearer ${SECRET}`],
    ["basic: user:password, base64-encoded", { env: env({ API_TOKEN: "deck:pw" }), auth: { scheme: "basic" as const } }, "authorization", `Basic ${Buffer.from("deck:pw").toString("base64")}`],
    ["header: the value in the named header", { auth: { scheme: "header" as const, header: "X-Api-Key" } }, "x-api-key", SECRET],
  ])("%s", async (_name, extra, header, value) => {
    await authed(extra).fetch();
    expect(fixture.seen[0]!.headers[header]).toBe(value);
  });

  it("reads the variable at every poll, so a rotated credential is picked up", async () => {
    const values: Record<string, string> = { API_TOKEN: "one" };
    const provider = authed({ env: env(values), auth: { scheme: "bearer" } });
    await provider.fetch();
    values.API_TOKEN = "two";
    await provider.fetch();
    expect(fixture.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer one", "Bearer two"]);
  });

  it("a literal header of the credential's name never replaces it", async () => {
    await authed({ auth: { scheme: "header", header: "X-Api-Key" }, headers: { "x-api-key": "literal" } }).fetch();
    expect(fixture.seen[0]!.headers["x-api-key"]).toBe(SECRET);
  });

  it("an unset variable fails the poll by name, before any request", async () => {
    const error = await failure(authed({ env: env({}) }));
    expect(error).toMatchObject({ code: "credential", message: "credential variable API_TOKEN is not set" });
    expect(fixture.seen).toEqual([]);
  });

  it("a rejected credential is a classified failure that never echoes the value", async () => {
    const provider = authed({ url: fixture.url("/unauthorised"), auth: { scheme: "bearer" } });
    const error = await failure(provider);
    expect(error).toMatchObject({ code: "http-status", message: "upstream answered HTTP 401" });
    expect(JSON.stringify(await provider.health())).not.toContain(SECRET);
  });
});

describe("http-json provider: failures are classified", () => {
  it("a non-JSON body is not-json, and the body is never echoed", async () => {
    const provider = new HttpJsonProvider("t", { url: fixture.url("/text") });
    const error = await failure(provider);
    expect(error).toMatchObject({ code: "not-json", message: "upstream response is not JSON" });
    expect(error.message).not.toContain("nope");
    expect((await failure(new HttpJsonProvider("e", { url: fixture.url("/empty") }))).code).toBe("not-json");
  });

  it("a non-2xx status is http-status, its body unread", async () => {
    const provider = new HttpJsonProvider("d", { url: fixture.url("/down") });
    const error = await failure(provider);
    expect(error).toMatchObject({ code: "http-status", message: "upstream answered HTTP 503" });
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "upstream answered HTTP 503" });
    expect((await failure(new HttpJsonProvider("n", { url: fixture.url("/missing") }))).message).toBe("upstream answered HTTP 404");
  });

  it("no response within timeoutMs is a timeout", async () => {
    const error = await failure(new HttpJsonProvider("h", { url: fixture.url("/hang"), timeoutMs: 150 }));
    expect(error).toMatchObject({ code: "timeout", name: "TimeoutError", message: "timed out after 150ms" });
  });

  it("a body that stalls after the headers is a timeout too", async () => {
    const error = await failure(new HttpJsonProvider("s", { url: fixture.url("/slow-body"), timeoutMs: 150 }));
    expect(error.code).toBe("timeout");
  });

  it("the poll's own abort signal (the registry's timeout) is a timeout", async () => {
    const controller = new AbortController();
    const pending = new HttpJsonProvider("h", { url: fixture.url("/hang"), timeoutMs: 5_000 }).fetch({ signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  it("a refused connection is unreachable, with the error code only", async () => {
    const closed = new Fixture();
    await closed.start();
    const url = closed.url("/ok");
    await closed.stop();
    const error = await failure(new HttpJsonProvider("u", { url }));
    expect(error.code).toBe("unreachable");
    expect(error.message).toMatch(/^upstream unreachable( \([A-Za-z_]+\))?$/);
  });
});

describe("http-json provider: the response size cap", () => {
  it("refuses a declared Content-Length over maxBytes", async () => {
    const error = await failure(new HttpJsonProvider("b", { url: fixture.url("/big-declared"), maxBytes: 1024 }));
    expect(error).toMatchObject({ code: "too-large", message: "upstream response exceeds 1024 bytes" });
  });

  it("stops reading a chunked body once it passes maxBytes", async () => {
    const error = await failure(new HttpJsonProvider("b", { url: fixture.url("/big-chunked"), maxBytes: 4096 }));
    expect(error.code).toBe("too-large");
  });

  it("defaults to 1 MiB, which a 64 KiB body fits", async () => {
    await expect(new HttpJsonProvider("b", { url: fixture.url("/big-chunked") }).fetch()).resolves.toMatchObject({ pad: expect.any(String) });
  });
});

describe("http-json provider: redirects", () => {
  const authed = (url: string, extra: Partial<HttpJsonConfig> = {}) =>
    new HttpJsonProvider("r", { url, credentialEnv: "API_TOKEN", env: env({ API_TOKEN: SECRET }), auth: { scheme: "header", header: "X-Api-Key" }, ...extra });

  it("follows a same-origin redirect, keeping the credential", async () => {
    fixture.routes.set("/moved", redirect("/ok", 301));
    await expect(authed(fixture.url("/moved")).fetch()).resolves.toMatchObject({ load: 42 });
    expect(fixture.seen.map((seen) => [seen.url, seen.headers["x-api-key"]])).toEqual([["/moved", SECRET], ["/ok", SECRET]]);
  });

  it("drops the credential once a redirect leaves the origin, and never sends it back", async () => {
    fixture.routes.set("/away", redirect(other.url("/bounce")));
    other.routes.set("/bounce", redirect(fixture.url("/ok"), 307));
    await expect(authed(fixture.url("/away")).fetch()).resolves.toMatchObject({ load: 42 });
    expect(other.seen).toHaveLength(1);
    expect(other.seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(other.seen[0]!.headers.authorization).toBeUndefined();
    // Back on the configured origin after a foreign hop: still without it.
    expect(fixture.seen.map((seen) => seen.headers["x-api-key"])).toEqual([SECRET, undefined]);
  });

  it("drops an Authorization credential cross-origin too", async () => {
    fixture.routes.set("/away-bearer", redirect(other.url("/ok")));
    await authed(fixture.url("/away-bearer"), { auth: { scheme: "bearer" } }).fetch();
    expect(fixture.seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(other.seen[0]!.headers.authorization).toBeUndefined();
  });

  it.each([
    ["a non-http(s) scheme", "file:///etc/passwd", "redirect to a non-http(s) URL refused"],
    ["a URL carrying credentials", "http://user:pw@127.0.0.1/ok", "redirect to a URL with credentials refused"],
  ])("refuses a redirect to %s", async (_name, location, message) => {
    fixture.routes.set("/bad-redirect", redirect(location));
    await expect(authed(fixture.url("/bad-redirect")).fetch()).rejects.toMatchObject({ code: "redirect", message });
    expect(fixture.seen).toHaveLength(1);
  });

  it("refuses a redirect without a Location", async () => {
    fixture.routes.set("/no-location", (_req, res) => res.writeHead(302).end());
    await expect(authed(fixture.url("/no-location")).fetch()).rejects.toMatchObject({ code: "redirect" });
  });

  it("stops after 5 redirects", async () => {
    fixture.routes.set("/loop", redirect("/loop"));
    await expect(authed(fixture.url("/loop")).fetch()).rejects.toMatchObject({ code: "redirect", message: "more than 5 redirects" });
    expect(fixture.seen).toHaveLength(6);
  });

  it("turns a POST into a GET without a body on 303, and keeps it on 307", async () => {
    fixture.routes.set("/see-other", redirect("/echo", 303));
    fixture.routes.set("/temporary", redirect("/echo", 307));
    const post = (path: string) => new HttpJsonProvider("p", { url: fixture.url(path), method: "POST", body: { a: 1 } }).fetch();
    await expect(post("/see-other")).resolves.toEqual({ method: "GET", body: "" });
    await expect(post("/temporary")).resolves.toEqual({ method: "POST", body: '{"a":1}' });
  });
});

describe("the http-json kind in an estate", () => {
  const base = { schemaVersion: 2, estate: { name: "hj" } };
  const validate = (integrations: unknown[]) => {
    const dir = makeConfigDir({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, integrations } });
    try {
      return load({ arg: dir.dir, env: {} });
    } finally {
      dir.cleanup();
    }
  };
  const instance = (extra: Record<string, unknown> = {}) => ({ id: "ups", kind: "http-json", title: "UPS", url: "http://ups.lan/status.json", ...extra });
  const shapeErrors = (result: ReturnType<typeof load>) => result.findings.filter((finding) => finding.severity === "error");

  it("validates a full instance", () => {
    const result = validate([
      instance({
        method: "POST",
        headers: { "X-Client": "deck", Accept: "application/json" },
        body: { query: "up" },
        credentialEnv: "UPS_TOKEN",
        auth: { scheme: "header", header: "X-Api-Key" },
        pollIntervalMs: 15_000,
        timeoutMs: 2_000,
        ttlMs: 30_000,
        maxBytes: 65_536,
        deepLink: "https://ups.lan/",
      }),
    ]);
    expect(shapeErrors(result)).toEqual([]);
    expect(result.exitClass).toBe(0);
  });

  it.each([
    ["an ftp URL", { url: "ftp://ups.lan/status.json" }],
    ["a file URL", { url: "file:///etc/passwd" }],
    ["a URL with user:password@", { url: "http://admin:hunter2@ups.lan/status.json" }],
    ["an unknown method", { method: "DELETE" }],
    ["a literal Authorization header", { headers: { Authorization: "Bearer abc" } }],
    ["a literal X-API-Key header", { headers: { "X-API-Key": "abc" } }],
    ["a literal Cookie header", { headers: { cookie: "session=abc" } }],
    ["a header value with a line break", { headers: { "X-Client": "a\r\nInjected: 1" } }],
    ["auth without credentialEnv", { auth: { scheme: "bearer" } }],
    ["auth scheme header without a header name", { credentialEnv: "UPS_TOKEN", auth: { scheme: "header" } }],
    ["a header name on a non-header scheme", { credentialEnv: "UPS_TOKEN", auth: { scheme: "bearer", header: "X-Key" } }],
    ["a credential value inline", { token: SECRET }],
    ["a 0ms timeout", { timeoutMs: 0 }],
    ["a size cap over 16 MiB", { maxBytes: 16 * 1024 * 1024 + 1 }],
  ])("refuses %s", (_name, extra) => {
    const result = validate([instance(extra)]);
    expect(result.exitClass).not.toBe(0);
    expect(shapeErrors(result).length).toBeGreaterThan(0);
  });

  it("requires a title and a url", () => {
    expect(validate([{ id: "ups", kind: "http-json", url: "http://ups.lan/" }]).exitClass).not.toBe(0);
    expect(validate([{ id: "ups", kind: "http-json", title: "UPS" }]).exitClass).not.toBe(0);
  });

  it("registers each instance under its own id, polls it, and serves the JSON as the envelope's data", async () => {
    const hostEnv = { UPS_TOKEN: SECRET, OTHER_TOKEN: "other-instance-secret" };
    const result = load({
      arg: makeDir([
        instance({ url: fixture.url("/ok"), credentialEnv: "UPS_TOKEN", auth: { scheme: "bearer" }, pollIntervalMs: 60_000 }),
        instance({ id: "down", title: "Down", url: fixture.url("/unauthorised"), credentialEnv: "OTHER_TOKEN" }),
        instance({ id: "slow", title: "Slow", url: fixture.url("/hang"), timeoutMs: 200 }),
      ]),
      env: hostEnv,
    });
    expect(shapeErrors(result)).toEqual([]);
    const { plan, usable } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: hostEnv });
    registerAllProviders(result.config!, kindRuntimes(plan.filter((e) => e.enabled).map((e) => usable.get(e.id)!), hostEnv));
    expect(listProviders().filter((p) => p.kind === "http-json").map((p) => p.id).sort()).toEqual(["down", "slow", "ups"]);
    startScheduler();
    await vi.waitFor(() => {
      expect(read("ups")?.data).toEqual({ load: 42, outlets: [{ name: "a", watts: 5 }] });
      expect(read("down")?.error).not.toBeNull();
      expect(read("slow")?.error).not.toBeNull();
    }, { timeout: 3_000 });

    // Each provider saw only its own instance's credential.
    const byPath = (path: string) => fixture.seen.find((seen) => seen.url === path)!;
    expect(byPath("/ok").headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(byPath("/unauthorised").headers.authorization).toBe("other-instance-secret");
    // Freshness follows the instance's own poll interval.
    expect(read("ups")?.freshness).toMatchObject({ state: "fresh", ttlMs: 60_000 });
    expect(read("down")?.error).toEqual({ message: "upstream answered HTTP 401" });
    expect(read("slow")?.error?.message).toMatch(/timed out after 200ms/);

    // Nothing /api serves carries a credential value: not the envelopes, health or config.
    const app = createApp({
      config: result.config!,
      providers: { read, count: providerCount, listHealth, listProviders },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });
    for (const path of ["/api/providers/ups", "/api/providers/down", "/api/providers/slow", "/api/health", "/api/config"]) {
      const text = await (await app.request(path)).text();
      expect(text, path).not.toContain(SECRET);
      expect(text, path).not.toContain("other-instance-secret");
    }
  });

  it("never reads a credentialEnv that names a deck setting", async () => {
    const hostEnv = { DECK_DATA_DIR: "kernel-path" };
    const arg = makeDir([instance({ url: fixture.url("/ok"), credentialEnv: "DECK_DATA_DIR" })]);
    // deck validate warns; boot carries on without the variable.
    expect(load({ arg, env: hostEnv }).findings).toContainEqual(expect.objectContaining({ code: "MODULE_CREDENTIAL_ENV_REFUSED", severity: "warning" }));
    const config = load({ arg, env: hostEnv, boot: true }).config!;
    const { plan, usable } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: hostEnv });
    registerAllProviders(config, kindRuntimes(plan.filter((e) => e.enabled).map((e) => usable.get(e.id)!), hostEnv));
    startScheduler();
    await vi.waitFor(() => expect(read("ups")?.error).toEqual({ message: "credential variable DECK_DATA_DIR is not set" }));
    expect(fixture.seen).toEqual([]);
  });
});

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));

function makeDir(integrations: unknown[]): string {
  const dir = makeConfigDir({ "00-base.yaml": { schemaVersion: 2, estate: { name: "hj" } }, "10-overlay.yaml": { schemaVersion: 2, integrations } });
  dirs.push(dir.cleanup);
  return dir.dir;
}
