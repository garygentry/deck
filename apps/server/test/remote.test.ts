import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { kindRuntimes, planModules } from "../src/modules/host.js";
import { HttpJsonError } from "../src/providers/http-json/index.js";
import { registerAllProviders } from "../src/providers/index.js";
import { RemoteProvider } from "../src/providers/remote/provider.js";
import { listHealth, listProviders, providerCount, read, setProjections, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { makeConfigDir } from "./util/tmp-config.js";

const SECRET = "s3cr3t-sidecar-token";

type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** A fixture sidecar: routes by path, records each request's path and Authorization header. */
class Sidecar {
  readonly seen: Array<{ path: string; authorization: string | undefined }> = [];
  readonly routes = new Map<string, Route>();
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      this.seen.push({ path, authorization: req.headers.authorization });
      const route = this.routes.get(path);
      if (route === undefined) res.writeHead(404).end();
      else route(req, res);
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const json = (value: unknown, status = 200): Route => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
};

const DATA = { data: { load: 42, status: "OL" }, observedAt: "2026-10-09T09:00:00Z" };

const sidecar = new Sidecar();
const other = new Sidecar();

beforeAll(async () => {
  await sidecar.start();
  await other.start();
  sidecar.routes.set("/deck/v1/data", json(DATA));
});

afterAll(async () => {
  await sidecar.stop();
  await other.stop();
});

afterEach(() => {
  sidecar.seen.length = 0;
  other.seen.length = 0;
  stopScheduler();
});

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

describe("the remote provider: data", () => {
  it("serves the envelope's data, reading /deck/v1/data under the base URL", async () => {
    const remote = new RemoteProvider("ups", { url: `${sidecar.url}/`, request: {} });
    await expect(remote.fetch()).resolves.toEqual(DATA.data);
    expect(sidecar.seen.map((seen) => seen.path)).toEqual(["/deck/v1/data"]);
    expect(await remote.health()).toEqual({ ok: true, detail: "HTTP 200, observed 2026-10-09T09:00:00Z" });
  });

  it.each([
    ["a bare body", { load: 42 }, "sidecar data response is not a { data } envelope"],
    ["a list", [1, 2], "sidecar data response is not a { data } envelope"],
    ["a bad observedAt", { data: 1, observedAt: "yesterday" }, "sidecar data response's observedAt is not an RFC 3339 time"],
  ])("refuses %s", async (_label, body, message) => {
    other.routes.set("/deck/v1/data", json(body));
    const remote = new RemoteProvider("ups", { url: other.url, request: {} });
    const error = await remote.fetch().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpJsonError);
    expect((error as Error).message).toBe(message);
    expect(await remote.health()).toEqual({ ok: false, detail: message });
  });

  it("sends the env-held credential, and refuses a response echoing it", async () => {
    other.routes.set("/deck/v1/data", (req, res) => json({ data: { auth: req.headers.authorization } })(req, res));
    const remote = new RemoteProvider("ups", { url: other.url, request: { credentialEnv: "SIDECAR_TOKEN", auth: { scheme: "bearer" }, env: env({ SIDECAR_TOKEN: SECRET }) } });
    await expect(remote.fetch()).rejects.toThrow("upstream response contains the credential; not published");
    expect(other.seen).toEqual([{ path: "/deck/v1/data", authorization: `Bearer ${SECRET}` }]);
    expect(JSON.stringify(await remote.health())).not.toContain(SECRET);
  });

  it("refuses a cross-origin redirect of an authenticated request, never contacting the other origin", async () => {
    other.routes.set("/deck/v1/data", (_req, res) => res.writeHead(302, { location: `${sidecar.url}/deck/v1/data` }).end());
    const remote = new RemoteProvider("ups", { url: other.url, request: { credentialEnv: "SIDECAR_TOKEN", env: env({ SIDECAR_TOKEN: SECRET }) } });
    await expect(remote.fetch()).rejects.toThrow("cross-origin redirect refused for an authenticated request");
    expect(sidecar.seen).toEqual([]);
  });

  it("times out on its own timeoutMs", async () => {
    other.routes.set("/deck/v1/data", () => {});
    const remote = new RemoteProvider("ups", { url: other.url, request: {}, timeoutMs: 200 });
    await expect(remote.fetch()).rejects.toThrow("timed out after 200ms");
  });
});

describe("the remote kind in an estate", () => {
  const base = { schemaVersion: 2, estate: { name: "rm" } };
  const dirs: Array<() => void> = [];
  afterAll(() => dirs.forEach((cleanup) => cleanup()));
  const configDir = (integrations: unknown[]) => {
    const dir = makeConfigDir({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, integrations } });
    dirs.push(dir.cleanup);
    return dir.dir;
  };
  const instance = (extra: Record<string, unknown> = {}) => ({ id: "ups", kind: "remote", title: "UPS", url: sidecar.url, ...extra });
  const errors = (result: ReturnType<typeof load>) => result.findings.filter((finding) => finding.severity === "error");

  it("validates a full instance", () => {
    const result = load({
      arg: configDir([
        instance({ credentialEnv: "UPS_TOKEN", auth: { scheme: "bearer" }, pollIntervalMs: 15_000, timeoutMs: 2_000, ttlMs: 30_000, maxBytes: 65_536, deepLink: "https://ups.lan/" }),
      ]),
      env: {},
    });
    expect(errors(result)).toEqual([]);
  });

  it.each([
    ["a URL with a query", { url: "http://ups.lan:9000/?token=x" }],
    ["a URL with user:password@", { url: "http://a:b@ups.lan:9000" }],
    ["an ftp URL", { url: "ftp://ups.lan" }],
    ["an id that is not lowercase kebab-case", { id: "UPS One" }],
    ["literal headers", { headers: { "X-Api-Key": "x" } }],
    ["auth without credentialEnv", { auth: { scheme: "bearer" } }],
  ])("refuses %s", (_label, extra) => {
    expect(errors(load({ arg: configDir([instance(extra)]), env: {} })).length).toBeGreaterThan(0);
  });

  it("refuses an id that is another kind's fixed provider id in the estate", () => {
    const result = load({
      arg: configDir([instance({ id: "prometheus" }), { id: "prom", kind: "prometheus", title: "Prometheus", baseUrl: "http://prom.lan:9090" }]),
      env: {},
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "REMOTE_ID_RESERVED", severity: "error" }));
  });

  it("registers each sidecar as its own provider: one down degrades only its own health entry", async () => {
    other.routes.set("/deck/v1/data", json({}, 503));
    const result = load({ arg: configDir([instance({ pollIntervalMs: 1_000 }), instance({ id: "pdu", title: "PDU", url: other.url, pollIntervalMs: 1_000 })]), env: {} });
    expect(errors(result)).toEqual([]);
    const { plan, usable } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: {} });
    registerAllProviders(result.config!, kindRuntimes(plan.filter((e) => e.enabled).map((e) => usable.get(e.id)!), {}));
    expect(listProviders().filter((p) => p.kind === "remote").map((p) => p.id).sort()).toEqual(["pdu", "ups"]);
    startScheduler();
    await vi.waitFor(() => {
      expect(read("ups")?.data).toEqual(DATA.data);
      expect(read("pdu")?.error).toEqual({ message: "upstream answered HTTP 503" });
    }, { timeout: 5_000 });
    const app = createApp({
      config: result.config!,
      providers: { read, count: providerCount, listHealth, listProviders, setProjections },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });
    const health = (await (await app.request("/api/health")).json()) as { status: string; providers: Record<string, { ok: boolean; detail?: string }> };
    expect(health.status).toBe("degraded");
    expect(health.providers.ups).toMatchObject({ ok: true, detail: "HTTP 200, observed 2026-10-09T09:00:00Z" });
    expect(health.providers.pdu).toMatchObject({ ok: false, detail: "upstream answered HTTP 503" });
  });
});
