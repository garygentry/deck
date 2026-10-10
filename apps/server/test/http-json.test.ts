import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules } from "../src/modules/host.js";
import { HttpJsonError, HttpJsonProvider, nestsDeeperThan, type HttpJsonConfig } from "../../../modules/http-json/server/index.js";
import { credentialBodyKeys, isCredentialName } from "../../../modules/http-json/server/literal.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, register, setProjections, startScheduler, stopScheduler } from "../src/providers/registry.js";
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
    // Keep-alive and half-open connections too, so closing never waits on a client.
    this.server.closeAllConnections();
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
  // Reflects what it was sent: the credential header and query, as a careless API might.
  fixture.routes.set("/reflect", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  fixture.routes.set("/deep", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(`${"[".repeat(100_000)}${"]".repeat(100_000)}`);
  });
  fixture.routes.set("/deep-ok", (_req, res) => {
    // 64 levels, and brackets inside strings, which do not nest.
    res.writeHead(200, { "content-type": "application/json" }).end(`${"[".repeat(63)}{"s":"[[[[ \\" ]]"}${"]".repeat(63)}`);
  });
  fixture.routes.set("/flip", (() => {
    let calls = 0;
    return (req: IncomingMessage, res: ServerResponse) => {
      calls += 1;
      if (calls === 1) json({ good: true })(req, res, "");
      else res.writeHead(200, { "content-type": "application/json" }).end(`${"[".repeat(100_000)}${"]".repeat(100_000)}`);
    };
  })());
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

  it("keeps a literal Content-Type on POST", async () => {
    const provider = new HttpJsonProvider("q", { url: fixture.url("/echo"), method: "POST", body: { a: 1 }, headers: { "Content-Type": "application/vnd.api+json" } });
    await provider.fetch();
    expect(fixture.seen[0]!.headers["content-type"]).toBe("application/vnd.api+json");
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
    ["basic: user:password, base64-encoded", { env: env({ API_TOKEN: "deck:pw-long" }), auth: { scheme: "basic" as const } }, "authorization", `Basic ${Buffer.from("deck:pw-long").toString("base64")}`],
    ["header: the value in the named header", { auth: { scheme: "header" as const, header: "X-Api-Key" } }, "x-api-key", SECRET],
  ])("%s", async (_name, extra, header, value) => {
    await authed(extra).fetch();
    expect(fixture.seen[0]!.headers[header]).toBe(value);
  });

  it("reads the variable at every poll, so a rotated credential is picked up", async () => {
    const values: Record<string, string> = { API_TOKEN: "first-token" };
    const provider = authed({ env: env(values), auth: { scheme: "bearer" } });
    await provider.fetch();
    values.API_TOKEN = "second-token";
    await provider.fetch();
    expect(fixture.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer first-token", "Bearer second-token"]);
  });

  it("query: the value in the named query parameter, never in config", async () => {
    await authed({ url: fixture.url("/ok?view=full"), auth: { scheme: "query", param: "api_key" } }).fetch();
    const sent = new URL(fixture.seen[0]!.url, "http://x");
    expect(sent.searchParams.get("api_key")).toBe(SECRET);
    expect(sent.searchParams.get("view")).toBe("full");
  });

  it("query: the parameter is sent again on a same-origin redirect", async () => {
    fixture.routes.set("/moved-q", redirect("/ok", 302));
    await authed({ url: fixture.url("/moved-q"), auth: { scheme: "query", param: "api_key" } }).fetch();
    expect(fixture.seen.map((seen) => new URL(seen.url, "http://x").searchParams.get("api_key"))).toEqual([SECRET, SECRET]);
  });

  it.each([
    ["a line break", "line\nbreak-value"],
    ["a non-Latin-1 character", "tok€n-value"],
  ])("a credential holding %s fails the poll as credential, before any request", async (_name, value) => {
    const error = await failure(authed({ env: env({ API_TOKEN: value }), auth: { scheme: "bearer" } }));
    expect(error).toMatchObject({ code: "credential", message: "credential variable API_TOKEN holds a character a header cannot carry" });
    expect(error.message).not.toContain(value);
    expect(fixture.seen).toEqual([]);
  });

  it("basic and query carry any value, encoded", async () => {
    await authed({ env: env({ API_TOKEN: "deck:pässwörd€" }), auth: { scheme: "basic" } }).fetch();
    expect(fixture.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from("deck:pässwörd€").toString("base64")}`);
  });

  it("a literal header of the credential's name never replaces it", async () => {
    // A credential-named literal is refused outright; any other name the credential takes still wins.
    await authed({ auth: { scheme: "header", header: "X-Ups-Client" }, headers: { "x-ups-client": "literal" } }).fetch();
    expect(fixture.seen[0]!.headers["x-ups-client"]).toBe(SECRET);
  });

  it("an unset variable fails the poll by name, before any request", async () => {
    const error = await failure(authed({ env: env({}) }));
    expect(error).toMatchObject({
      code: "credential",
      message: "credential variable API_TOKEN is not set or not readable by this module (see MODULE_CREDENTIAL_ENV_REFUSED)",
    });
    expect(fixture.seen).toEqual([]);
  });

  it("a rejected credential is a classified failure that never echoes the value", async () => {
    const provider = authed({ url: fixture.url("/unauthorised"), auth: { scheme: "bearer" } });
    const error = await failure(provider);
    expect(error).toMatchObject({ code: "http-status", message: "upstream answered HTTP 401" });
    expect(JSON.stringify(await provider.health())).not.toContain(SECRET);
  });
});

describe("http-json provider: a response that echoes the credential", () => {
  const reflect = (auth: HttpJsonConfig["auth"], value = SECRET) =>
    new HttpJsonProvider("echo", { url: fixture.url("/reflect"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: value }), ...(auth ? { auth } : {}) });

  it.each([
    ["raw Authorization", undefined],
    ["bearer", { scheme: "bearer" as const }],
    ["basic", { scheme: "basic" as const }],
    ["header", { scheme: "header" as const, header: "X-Api-Key" }],
    ["query", { scheme: "query" as const, param: "api_key" }],
  ])("is refused, never published (%s)", async (_name, auth) => {
    const provider = reflect(auth, auth?.scheme === "basic" ? `deck:${SECRET}` : SECRET);
    const error = await failure(provider);
    expect(error).toMatchObject({ code: "credential-echo", message: "upstream response contains the credential; not published" });
    expect(JSON.stringify(await provider.health())).not.toContain(SECRET);
  });

  it("is caught URL-encoded, and in a key", async () => {
    const value = "p@ss w/rd+value";
    fixture.routes.set("/echo-key", json({ [encodeURIComponent(value)]: 1 }));
    const provider = new HttpJsonProvider("k", { url: fixture.url("/echo-key"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: value }), auth: { scheme: "basic" } });
    expect((await failure(provider)).code).toBe("credential-echo");
  });

  it("is not flagged without a credential, or when the body merely differs", async () => {
    await expect(new HttpJsonProvider("n", { url: fixture.url("/reflect") }).fetch()).resolves.toMatchObject({ url: "/reflect" });
    fixture.routes.set("/near", json({ text: SECRET.slice(0, -1) }));
    const near = new HttpJsonProvider("near", { url: fixture.url("/near"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: SECRET }), auth: { scheme: "bearer" } });
    await expect(near.fetch()).resolves.toEqual({ text: SECRET.slice(0, -1) });
  });
});

describe("http-json provider: credential shape and wide bodies", () => {
  const app = () => createApp({
    config: { schemaVersion: 2, estate: { name: "hj" } } as never,
    providers: { read, count: providerCount, listHealth, listProviders, setProjections },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
  });

  it.each([
    ["shorter than 8 characters", "abc1234"],
    ["padded with whitespace (a header would trim it)", `  ${SECRET}  `],
    ["with a trailing tab", `${SECRET}\t`],
  ])("refuses a credential %s before any request, through the registry and API", async (_name, value) => {
    register(new HttpJsonProvider("shape", { url: fixture.url("/reflect"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: value }), auth: { scheme: "header", header: "X-Api-Key" } }));
    startScheduler();
    await vi.waitFor(() => expect(read("shape")?.error).not.toBeNull());
    const body = await (await app().request("/api/providers/shape")).json();
    expect(body).toMatchObject({
      data: null,
      error: { message: "credential variable API_TOKEN must hold at least 8 characters, without surrounding whitespace" },
    });
    expect(JSON.stringify(body)).not.toContain(value.trim());
    expect(fixture.seen).toEqual([]);
  });

  it("an 8-character credential echoed back is refused, through the registry and API", async () => {
    register(new HttpJsonProvider("echo8", { url: fixture.url("/reflect"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: "k8chars!" }), auth: { scheme: "header", header: "X-Api-Key" } }));
    startScheduler();
    await vi.waitFor(() => expect(read("echo8")?.error).not.toBeNull());
    const text = await (await app().request("/api/providers/echo8")).text();
    expect(JSON.parse(text)).toMatchObject({ data: null, error: { message: "upstream response contains the credential; not published" } });
    expect(text).not.toContain("k8chars!");
  });

  it("a wide, shallow body under the default cap is scanned and served", async () => {
    fixture.routes.set("/wide", json(new Array(200_000).fill(0)));
    const provider = new HttpJsonProvider("wide", { url: fixture.url("/wide"), credentialEnv: "API_TOKEN", env: env({ API_TOKEN: SECRET }), auth: { scheme: "bearer" } });
    const data = await provider.fetch();
    expect(Array.isArray(data) && data.length).toBe(200_000);
  });

  it("a wide literal body is walked without overflowing", () => {
    expect(credentialBodyKeys({ rows: new Array(200_000).fill({ v: 1 }) })).toEqual([]);
  });
});

describe("http-json provider: nesting depth", () => {
  it("refuses a response nested past 64 levels, under the size cap, before parsing", async () => {
    const error = await failure(new HttpJsonProvider("d", { url: fixture.url("/deep") }));
    expect(error).toMatchObject({ code: "too-deep", message: "upstream response nests deeper than 64 levels" });
  });

  it("accepts 64 levels, and ignores brackets inside strings", async () => {
    await expect(new HttpJsonProvider("d", { url: fixture.url("/deep-ok") }).fetch()).resolves.toBeDefined();
    expect(nestsDeeperThan('{"a":"[[[[[[[[[["}', 2)).toBe(false);
    expect(nestsDeeperThan('[["\\\\"],[[1]]]', 2)).toBe(true);
    expect(nestsDeeperThan('["\\"[[[["]', 1)).toBe(false);
  });

  it("through the registry: a deep payload is a classified failure, the last good data is kept, and the process carries on", async () => {
    register(new HttpJsonProvider("flip", { url: fixture.url("/flip") }), { pollIntervalMs: 50, ttlMs: 60_000 });
    startScheduler();
    await vi.waitFor(() => expect(read("flip")?.data).toEqual({ good: true }));
    await vi.waitFor(() => expect(read("flip")?.error).toEqual({ message: "upstream response nests deeper than 64 levels" }));
    expect(read("flip")?.data).toEqual({ good: true });
  });

  it("the registry freezes provider data of any depth without overflowing the stack", async () => {
    let deep: unknown = { leaf: true };
    for (let level = 0; level < 200_000; level += 1) deep = { child: deep };
    register({ id: "deep-any", kind: "test", health: async () => ({ ok: true }), fetch: async () => deep });
    startScheduler();
    await vi.waitFor(() => expect(read("deep-any")?.freshness.state).toBe("fresh"));
    expect(read("deep-any")?.error).toBeNull();
    expect(Object.isFrozen(read("deep-any")?.data)).toBe(true);
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

  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"])(
    "the runtime's own %s is a timeout, its message never shown",
    async (code) => {
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(`timeout talking to ${SECRET}`), { code }) });
      });
      try {
        const error = await failure(new HttpJsonProvider("t", { url: fixture.url("/ok") }));
        expect(error).toMatchObject({ code: "timeout", message: `timed out (${code})` });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

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

  it.each([
    ["header", { scheme: "header" as const, header: "X-Api-Key" }],
    ["bearer", { scheme: "bearer" as const }],
    ["query", { scheme: "query" as const, param: "api_key" }],
  ])("refuses any cross-origin redirect of an authenticated request (%s)", async (_name, auth) => {
    fixture.routes.set("/away", redirect(other.url("/ok")));
    await expect(authed(fixture.url("/away"), { auth }).fetch()).rejects.toMatchObject({
      code: "redirect",
      message: "cross-origin redirect refused for an authenticated request",
    });
    expect(other.seen).toEqual([]);
  });

  it("refuses a Location reflecting the credential to another origin, which is never contacted", async () => {
    fixture.routes.set("/reflect-redirect", (req, res) => {
      const key = new URL(req.url ?? "/", "http://x").searchParams.get("api_key");
      res.writeHead(302, { location: other.url(`/ok?leak=${key}`) }).end();
    });
    const error = await failure(authed(fixture.url("/reflect-redirect"), { auth: { scheme: "query", param: "api_key" } }));
    expect(error.code).toBe("redirect");
    expect(error.message).not.toContain(SECRET);
    expect(other.seen).toEqual([]);
  });

  it("follows a cross-origin redirect of an unauthenticated request", async () => {
    fixture.routes.set("/away-open", redirect(other.url("/ok")));
    await expect(new HttpJsonProvider("o", { url: fixture.url("/away-open") }).fetch()).resolves.toEqual({ other: true });
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
    ["a non-ASCII header value", { headers: { "X-Client": "café" } }],
    ["a control character in a header value", { headers: { "X-Client": "a\u0001b" } }],
    ["auth scheme query without a param", { credentialEnv: "UPS_TOKEN", auth: { scheme: "query" } }],
    ["a param on a non-query scheme", { credentialEnv: "UPS_TOKEN", auth: { scheme: "bearer", param: "k" } }],
  ])("refuses %s", (_name, extra) => {
    const result = validate([instance(extra)]);
    expect(result.exitClass).not.toBe(0);
    expect(shapeErrors(result).length).toBeGreaterThan(0);
  });

  it.each([
    ["a malformed IPv6 host", "http://[::1/status.json", "HTTP_JSON_URL_INVALID", "/integrations/0/url"],
    ["an out-of-range port", "http://ups.lan:99999/status.json", "HTTP_JSON_URL_INVALID", "/integrations/0/url"],
    ["a credential-named query parameter", "http://ups.lan/status.json?view=1&API_KEY=abc", "HTTP_JSON_LITERAL_CREDENTIAL", "/integrations/0/url"],
    ["an access_token query parameter", "https://ups.lan/s?access_token=abc", "HTTP_JSON_LITERAL_CREDENTIAL", "/integrations/0/url"],
  ])("reports %s, which the schema pattern lets through, as a validate finding", (_name, url, code, path) => {
    const result = validate([instance({ url })]);
    expect(result.exitClass).not.toBe(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code, severity: "error", path }));
  });

  it("reports a credential-named key in a literal body", () => {
    const result = validate([instance({ method: "POST", body: { query: "up", variables: { password: "x" } } })]);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "HTTP_JSON_LITERAL_CREDENTIAL", severity: "error", path: "/integrations/0/body" }));
  });

  it("accepts auth scheme query, whose value comes from credentialEnv", () => {
    const result = validate([instance({ credentialEnv: "UPS_TOKEN", auth: { scheme: "query", param: "api_key" } })]);
    expect(shapeErrors(result)).toEqual([]);
  });

  it.each(["prometheus", "gatus", "docker", "alertmanager"])("reports an id equal to the fixed provider id of a %s integration in the estate", (kind) => {
    const result = validate([{ id: `${kind}-main`, kind, title: kind, baseUrl: `http://${kind}.lan` }, instance({ id: kind })]);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "PROVIDER_ID_RESERVED", severity: "error", path: "/integrations/1/id" }));
  });

  it("does not report a fixed id whose kind has no instance in the estate", () => {
    for (const id of ["prometheus", "gatus", "snapshot"]) {
      expect(validate([instance({ id })]).findings.filter((finding) => finding.code === "PROVIDER_ID_RESERVED")).toEqual([]);
    }
  });

  it.each([
    ["header", { headers: { "X-Author": "deck", "X-Sort-Key": "name", Keys: "a,b" } }],
    ["query", { url: "http://ups.lan/s?author=me&keys=a&sort_key=b&passed=1&keyword=x" }],
    ["body", { method: "POST", body: { author: "me", keys: [1], sort_key: "b", passed: true } }],
  ])("accepts %s names that only contain a credential word (author, keys, sort_key, passed)", (_name, extra) => {
    const result = validate([instance(extra)]);
    expect(result.findings.filter((finding) => finding.code === "HTTP_JSON_LITERAL_CREDENTIAL")).toEqual([]);
    expect(result.exitClass).toBe(0);
  });

  it.each([
    ["header", { headers: { "X-Api-Key": "abc" } }, "/integrations/0/headers/X-Api-Key"],
    ["query", { url: "http://ups.lan/s?accessToken=abc" }, "/integrations/0/url"],
    ["body", { method: "POST", body: { api_key: "abc" } }, "/integrations/0/body"],
  ])("refuses %s names that are credentials (api_key, accessToken)", (_name, extra, path) => {
    expect(validate([instance(extra)]).findings).toContainEqual(expect.objectContaining({ code: "HTTP_JSON_LITERAL_CREDENTIAL", severity: "error", path }));
  });

  it("matches credential names by whole token", () => {
    for (const name of ["api_key", "X-Api-Key", "X-API-Key", "APIKey", "apikey", "accessToken", "access_token", "Authorization", "Proxy-Authorization", "Cookie", "X-Auth-Token", "password", "client_secret", "sig", "key"]) {
      expect(isCredentialName(name), name).toBe(true);
    }
    for (const name of ["author", "keys", "sort_key", "passed", "keyword", "Accept", "Content-Type", "X-Client", "monkey", "signal", "tokenizer"]) {
      expect(isCredentialName(name), name).toBe(false);
    }
  });

  it("refuses a literal credential at the request boundary too, before any request", async () => {
    const byHeader = await failure(new HttpJsonProvider("l", { url: fixture.url("/ok"), headers: { "X-Api-Key": "abc" } }));
    expect(byHeader).toMatchObject({ code: "credential", message: "header X-Api-Key names a credential; credentials come from credentialEnv" });
    const byUrl = await failure(new HttpJsonProvider("l", { url: fixture.url("/ok?token=abc") }));
    expect(byUrl).toMatchObject({ code: "credential" });
    expect(byUrl.message).not.toContain("abc");
    const byBody = await failure(new HttpJsonProvider("l", { url: fixture.url("/echo"), method: "POST", body: { password: "abc" } }));
    expect(byBody).toMatchObject({ code: "credential", message: "body key password looks like a credential; credentials come from credentialEnv" });
    expect(fixture.seen).toEqual([]);
  });

  it("requires a title and a url", () => {
    expect(validate([{ id: "ups", kind: "http-json", url: "http://ups.lan/" }]).exitClass).not.toBe(0);
    expect(validate([{ id: "ups", kind: "http-json", title: "UPS" }]).exitClass).not.toBe(0);
  });

  it("registers each instance under its own id, polls it, and serves the JSON as the envelope's data", async () => {
    // Its own server: a fresh origin, so no connection pooled by an earlier test and no
    // request log or route another test shares. Every request this test makes lands here.
    const own = new Fixture();
    await own.start();
    own.routes.set("/ok", fixture.routes.get("/ok")!);
    own.routes.set("/unauthorised", fixture.routes.get("/unauthorised")!);
    own.routes.set("/hang", () => {});
    try {
      await pollsEachInstance(own);
    } finally {
      await own.stop();
    }
    // Real config loading and three real polls (one waits out its 200ms timeout): more than the
    // default 5s on a loaded host.
  }, 15_000);

  async function pollsEachInstance(own: Fixture): Promise<void> {
    const hostEnv = { UPS_TOKEN: SECRET, OTHER_TOKEN: "other-instance-secret" };
    const result = load({
      arg: makeDir([
        instance({ url: own.url("/ok"), credentialEnv: "UPS_TOKEN", auth: { scheme: "bearer" }, pollIntervalMs: 60_000 }),
        instance({ id: "down", title: "Down", url: own.url("/unauthorised"), credentialEnv: "OTHER_TOKEN" }),
        instance({ id: "slow", title: "Slow", url: own.url("/hang"), timeoutMs: 200 }),
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

    // The envelopes first, so a failure names the poll's own error.
    expect(read("down")?.error).toEqual({ message: "upstream answered HTTP 401" });
    expect(read("slow")?.error?.message).toMatch(/timed out after 200ms/);
    // Freshness follows the instance's own poll interval.
    expect(read("ups")?.freshness).toMatchObject({ state: "fresh", ttlMs: 60_000 });
    // Each provider saw only its own instance's credential.
    const sentTo = (path: string) => own.seen.filter((seen) => seen.url === path).map((seen) => seen.headers.authorization);
    expect(sentTo("/ok")).toEqual([`Bearer ${SECRET}`]);
    expect(sentTo("/unauthorised")).toEqual(["other-instance-secret"]);

    // Nothing /api serves carries a credential value: not the envelopes, health or config.
    const app = createApp({
      config: result.config!,
      providers: { read, count: providerCount, listHealth, listProviders, setProjections },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });
    for (const path of ["/api/providers/ups", "/api/providers/down", "/api/providers/slow", "/api/health", "/api/config"]) {
      const text = await (await app.request(path)).text();
      expect(text, path).not.toContain(SECRET);
      expect(text, path).not.toContain("other-instance-secret");
    }
  }

  it("never reads a credentialEnv that names a deck setting", async () => {
    const hostEnv = { DECK_DATA_DIR: "kernel-path" };
    const arg = makeDir([instance({ url: fixture.url("/ok"), credentialEnv: "DECK_DATA_DIR" })]);
    // deck validate warns; boot carries on without the variable.
    expect(load({ arg, env: hostEnv }).findings).toContainEqual(expect.objectContaining({ code: "MODULE_CREDENTIAL_ENV_REFUSED", severity: "warning" }));
    const config = load({ arg, env: hostEnv, boot: true }).config!;
    const { plan, usable } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: hostEnv });
    registerAllProviders(config, kindRuntimes(plan.filter((e) => e.enabled).map((e) => usable.get(e.id)!), hostEnv));
    startScheduler();
    await vi.waitFor(() => expect(read("ups")?.error).toEqual({
      message: "credential variable DECK_DATA_DIR is not set or not readable by this module (see MODULE_CREDENTIAL_ENV_REFUSED)",
    }));
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
