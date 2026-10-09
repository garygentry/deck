import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { UiManifest } from "@deck/module-sdk";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { createModuleHost } from "../src/modules/host.js";
import { HttpJsonError } from "../src/providers/http-json/index.js";
import { registerAllProviders } from "../src/providers/index.js";
import { checkDescribe, REMOTE_MAX_STRING, REMOTE_WIDGET_TYPES } from "../src/providers/remote/describe.js";
import { RemoteDirectory } from "../src/providers/remote/directory.js";
import { RemoteProvider } from "../src/providers/remote/provider.js";
import { listHealth, listProviders, providerCount, read, setProjections, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { buildUiManifest } from "../src/ui/manifest.js";
import { collectRuntimePages, runtimePageSources } from "../src/ui/runtime-pages.js";
import { captureLogger } from "./util/modules.js";
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

const DESCRIBE = {
  deck: 1,
  id: "ups",
  version: "1.2.0",
  title: "UPS",
  columns: 2,
  widgets: [
    { id: "load", type: "core/meter", title: "Load", select: "load", options: { max: 100, unit: "%" } },
    { id: "status", type: "core/key-value", title: "Status", options: { items: [{ field: "status" }] } },
  ],
  links: [{ title: "NUT", href: "https://nut.example/" }],
  nav: [{ id: "nut", label: "NUT web UI", href: "https://nut.example/ui" }],
};
const DATA = { data: { load: 42, status: "OL" }, observedAt: "2026-10-09T09:00:00Z" };

const sidecar = new Sidecar();
const other = new Sidecar();

beforeAll(async () => {
  await sidecar.start();
  await other.start();
  sidecar.routes.set("/deck/v1/describe", json(DESCRIBE));
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

function provider(url: string, extra: Partial<ConstructorParameters<typeof RemoteProvider>[1]> = {}) {
  const directory = new RemoteDirectory();
  directory.declare("ups", "UPS", { path: "/remote/ups" });
  return { directory, provider: new RemoteProvider("ups", { url, request: {}, ...extra }, directory) };
}

describe("checkDescribe: declarative only, the config's own descriptors", () => {
  it("accepts a full document", () => {
    expect(checkDescribe(DESCRIBE, "ups")).toMatchObject({ ok: true, notes: [] });
  });

  it("allows only deck's declarative core types: never core/embed, health pills or another module's", () => {
    expect([...REMOTE_WIDGET_TYPES]).not.toContain("core/embed");
    for (const type of ["core/embed", "core/health-pills", "portal/groups", "evil/script"]) {
      const result = checkDescribe({ ...DESCRIBE, widgets: [{ id: "w", type }] }, "ups");
      expect(result, type).toEqual({ ok: false, problem: `/widgets/0 type "${type}" is not one a sidecar may place` });
    }
  });

  it.each([
    ["a source of its own", { widgets: [{ id: "w", type: "core/json", source: "prometheus" }] }, /additional properties/],
    ["options its type refuses", { widgets: [{ id: "w", type: "core/meter", options: { max: "lots" } }] }, /^\/widgets\/0 options: its type refuses the options/],
    ["a select deck cannot compile", { widgets: [{ id: "w", type: "core/json", select: "nosuchfn(@)" }] }, /^\/widgets\/0 select:/],
    ["a select over the work limits", { widgets: [{ id: "w", type: "core/json", select: Array.from({ length: 300 }, () => "a").join(".") }] }, /^\/widgets\/0 select: it has \d+ parts/],
    ["a repeated widget id", { widgets: [{ id: "w", type: "core/json" }, { id: "w", type: "core/json" }] }, /repeats widget id "w"/],
    ["deck's own links widget id", { widgets: [{ id: "links", type: "core/json" }] }, /is deck's own/],
    ["a javascript: link", { links: [{ title: "x", href: "javascript:alert(1)" }] }, /^\/links\/0\/href/],
    ["a protocol-relative link", { links: [{ title: "x", href: "//evil.example/" }] }, /^\/links\/0\/href/],
    ["a link with a backslash", { links: [{ title: "x", href: "/a\\evil.example" }] }, /^\/links\/0\/href is not a safe link/],
    ["a link-tiles option with a backslash", { widgets: [{ id: "w", type: "core/link-tiles", options: { links: [{ title: "x", href: "/a\\b" }] } }] }, /links\/0\/href is not a safe link/],
    ["an internal nav path", { nav: [{ id: "n", label: "N", href: "/portal" }] }, /^\/nav\/0\/href/],
    ["a repeated nav id", { nav: [{ id: "n", label: "N", href: "https://a.example/" }, { id: "n", label: "M", href: "https://b.example/" }] }, /repeats nav id/],
    ["an overlong title", { title: "t".repeat(81) }, /^\/title/],
    ["an overlong icon", { links: [{ title: "x", href: "https://x.example/", icon: "a".repeat(65) }] }, /^\/links\/0\/icon/],
    ["an overlong string anywhere", { widgets: [{ id: "w", type: "core/markdown", options: { content: "x".repeat(REMOTE_MAX_STRING + 1) } }] }, /^\/widgets\/0\/options\/content is longer than/],
    ["another protocol version", { deck: 2 }, /^\/deck/],
  ])("refuses %s", (_label, patch, problem) => {
    const result = checkDescribe({ ...DESCRIBE, ...patch }, "ups");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problem).toMatch(problem);
  });

  it("uses a document naming another id, with a note: the id picks nothing", () => {
    expect(checkDescribe({ ...DESCRIBE, id: "nut" }, "ups")).toMatchObject({
      ok: true,
      notes: ['it names itself "nut", not "ups"; the integration\'s id is used'],
    });
  });
});

describe("the remote provider: data", () => {
  it("serves the envelope's data, reading /deck/v1/data under the base URL", async () => {
    const { provider: remote } = provider(`${sidecar.url}/`);
    await expect(remote.fetch()).resolves.toEqual(DATA.data);
    expect(sidecar.seen.map((seen) => seen.path)).toContain("/deck/v1/data");
    expect(await remote.health()).toMatchObject({ ok: true, detail: expect.stringMatching(/^data: HTTP 200, observed 2026-10-09T09:00:00Z; describe: /) });
  });

  it.each([
    ["a bare body", { load: 42 }, "sidecar data response is not a { data } envelope"],
    ["a list", [1, 2], "sidecar data response is not a { data } envelope"],
    ["a bad observedAt", { data: 1, observedAt: "yesterday" }, "sidecar data response's observedAt is not an RFC 3339 time"],
  ])("refuses %s", async (_label, body, message) => {
    other.routes.set("/deck/v1/data", json(body));
    const { provider: remote } = provider(other.url);
    const error = await remote.fetch().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpJsonError);
    expect((error as Error).message).toBe(message);
    expect((await remote.health()).ok).toBe(false);
  });

  it("sends the env-held credential on both requests, and refuses a response echoing it", async () => {
    other.routes.set("/deck/v1/data", (req, res) => json({ data: { auth: req.headers.authorization } })(req, res));
    other.routes.set("/deck/v1/describe", (req, res) => json({ ...DESCRIBE, title: String(req.headers.authorization).slice(0, 80) })(req, res));
    const { directory, provider: remote } = provider(other.url, { request: { credentialEnv: "SIDECAR_TOKEN", auth: { scheme: "bearer" }, env: env({ SIDECAR_TOKEN: SECRET }) } });
    await expect(remote.fetch()).rejects.toThrow("upstream response contains the credential; not published");
    await remote.describing();
    expect(other.seen.map((seen) => [seen.path, seen.authorization]).sort()).toEqual([
      ["/deck/v1/data", `Bearer ${SECRET}`],
      ["/deck/v1/describe", `Bearer ${SECRET}`],
    ]);
    expect(directory.snapshot()[0]).toMatchObject({ problem: { code: "REMOTE_DESCRIBE_UNREACHABLE", message: "upstream response contains the credential; not published" } });
    expect(JSON.stringify(directory.snapshot())).not.toContain(SECRET);
  });

  it("refuses a cross-origin redirect of an authenticated describe", async () => {
    other.routes.set("/deck/v1/describe", (_req, res) => res.writeHead(302, { location: `${sidecar.url}/deck/v1/describe` }).end());
    const { directory, provider: remote } = provider(other.url, { request: { credentialEnv: "SIDECAR_TOKEN", env: env({ SIDECAR_TOKEN: SECRET }) } });
    await remote.describe();
    expect(directory.snapshot()[0]?.problem?.message).toBe("cross-origin redirect refused for an authenticated request");
    expect(sidecar.seen).toEqual([]);
  });
});

describe("the remote provider: data timeout", () => {
  it("times out on its own timeoutMs", async () => {
    other.routes.set("/deck/v1/data", () => {});
    other.routes.set("/deck/v1/describe", json(DESCRIBE));
    const { provider: remote } = provider(other.url, { timeoutMs: 200 });
    await expect(remote.fetch()).rejects.toThrow("timed out after 200ms");
    await remote.describing();
  });
});

describe("the remote provider: describe on its own cadence", () => {
  it("accepts a good describe into the directory", async () => {
    const { directory, provider: remote } = provider(sidecar.url);
    await remote.describe();
    expect(directory.snapshot()).toEqual([{ instance: "ups", title: "UPS", page: { path: "/remote/ups" }, describe: { ...DESCRIBE } }]);
    expect((await remote.health()).detail).toMatch(/describe: ok \(ups 1\.2\.0\)$/);
  });

  it("a hung describe never delays a poll, nor fails its health", async () => {
    other.routes.set("/deck/v1/describe", () => {});
    other.routes.set("/deck/v1/data", json(DATA));
    const { provider: remote } = provider(other.url, { timeoutMs: 2_000 });
    const started = Date.now();
    await expect(remote.fetch()).resolves.toEqual(DATA.data);
    // Well inside the describe's own 2s timeout: the poll never waited for it.
    expect(Date.now() - started).toBeLessThan(1_500);
    await remote.describing();
    const health = await remote.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toMatch(/describe: unreachable \(timed out after 2000ms\)$/);
  });

  it("an invalid describe keeps the last good one, with the problem", async () => {
    let body: unknown = DESCRIBE;
    other.routes.set("/deck/v1/describe", (req, res) => json(body)(req, res));
    const { directory, provider: remote } = provider(other.url);
    await remote.describe();
    body = { ...DESCRIBE, widgets: [{ id: "frame", type: "core/embed", options: { url: "https://evil.example/" } }] };
    await remote.describe();
    const [entry] = directory.snapshot();
    expect(entry?.describe).toEqual(DESCRIBE);
    expect(entry?.problem).toEqual({ code: "REMOTE_DESCRIBE_INVALID", message: '/widgets/0 type "core/embed" is not one a sidecar may place' });
    body = DESCRIBE;
    await remote.describe();
    expect(directory.snapshot()[0]?.problem).toBeUndefined();
  });

  it("asks again after describeIntervalMs once one succeeded, and at the next poll after a failure", async () => {
    let now = 1_000;
    let answer: Route = json(DESCRIBE);
    other.routes.set("/deck/v1/describe", (req, res) => answer(req, res));
    other.routes.set("/deck/v1/data", json(DATA));
    const { provider: remote } = provider(other.url, { describeIntervalMs: 60_000, clock: { now: () => now } });
    const describes = () => other.seen.filter((seen) => seen.path === "/deck/v1/describe").length;
    // The first poll starts one; the next, within the interval, does not.
    await remote.fetch();
    await remote.describing();
    await remote.fetch();
    await remote.describing();
    expect(describes()).toBe(1);
    now += 60_000;
    answer = json({}, 500);
    await remote.fetch();
    await remote.describing();
    expect(describes()).toBe(2);
    // A failed one is asked again at the very next poll.
    await remote.fetch();
    await remote.describing();
    expect(describes()).toBe(3);
  });

  it("the directory tells listeners only of a changed snapshot, key order aside", async () => {
    const directory = new RemoteDirectory();
    const heard = vi.fn();
    directory.subscribe(heard);
    directory.declare("ups", "UPS", { path: "/remote/ups" });
    const reordered = Object.fromEntries(Object.entries(DESCRIBE).reverse()) as typeof DESCRIBE;
    directory.accept("ups", checkOk(DESCRIBE), []);
    directory.accept("ups", checkOk(reordered), []);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

function checkOk(value: unknown) {
  const result = checkDescribe(value, "ups");
  if (!result.ok) throw new Error(result.problem);
  return result.describe;
}

describe("the remote kind in an estate", () => {
  const base = { schemaVersion: 2, estate: { name: "rm" } };
  const dirs: Array<() => void> = [];
  afterAll(() => dirs.forEach((cleanup) => cleanup()));
  const configDir = (integrations: unknown[], ui?: unknown) => {
    const dir = makeConfigDir({ "00-base.yaml": base, "10-overlay.yaml": { schemaVersion: 2, integrations, ...(ui === undefined ? {} : { ui }) } });
    dirs.push(dir.cleanup);
    return dir.dir;
  };
  const instance = (extra: Record<string, unknown> = {}) => ({ id: "ups", kind: "remote", title: "UPS", url: sidecar.url, ...extra });
  const errors = (result: ReturnType<typeof load>) => result.findings.filter((finding) => finding.severity === "error");

  it("validates a full instance", () => {
    const result = load({
      arg: configDir([
        instance({
          credentialEnv: "UPS_TOKEN",
          auth: { scheme: "bearer" },
          pollIntervalMs: 15_000,
          timeoutMs: 2_000,
          ttlMs: 30_000,
          maxBytes: 65_536,
          describeIntervalMs: 60_000,
          page: { path: "/power/ups", icon: "zap", nav: { group: "health", order: 5 } },
        }),
      ]),
      env: {},
    });
    expect(errors(result)).toEqual([]);
  });

  it.each([
    ["a URL with a query", { url: "http://ups.lan:9000/?token=x" }],
    ["a URL with user:password@", { url: "http://a:b@ups.lan:9000" }],
    ["an ftp URL", { url: "ftp://ups.lan" }],
    ["an id that cannot name a page", { id: "UPS One" }],
    ["literal headers", { headers: { "X-Api-Key": "x" } }],
    ["auth without credentialEnv", { auth: { scheme: "bearer" } }],
    ["a page path with a parameter", { page: { path: "/remote/:id" } }],
    ["a describe interval under 10s", { describeIntervalMs: 1_000 }],
  ])("refuses %s", (_label, extra) => {
    expect(errors(load({ arg: configDir([instance(extra)]), env: {} })).length).toBeGreaterThan(0);
  });

  it("refuses an id that is another kind's fixed provider id in the estate", () => {
    const result = load({
      arg: configDir([
        instance({ id: "prometheus" }),
        { id: "prom", kind: "prometheus", title: "Prometheus", baseUrl: "http://prom.lan:9090" },
      ]),
      env: {},
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "REMOTE_ID_RESERVED", severity: "error" }));
  });

  /** Boot's sequence: plan, register the kinds' providers, start, then resolve the UI manifest. */
  async function boot(integrations: unknown[], ui?: unknown) {
    const result = load({ arg: configDir(integrations, ui), env: {} });
    expect(errors(result)).toEqual([]);
    const config = result.config!;
    const { logger } = captureLogger();
    const host = createModuleHost({
      modules: BUILTIN_MODULES,
      builtins: new Set(BUILTIN_MODULES),
      sectionOf: () => undefined,
      instancesOf: (list) => (config as unknown as Record<string, unknown[]>)[list] ?? [],
      env: {},
      logger,
    });
    registerAllProviders(config, host.kindHandlers());
    await host.start();
    // The remote kind's directory is its runtime page source, as boot finds it.
    const sources = runtimePageSources(host);
    expect(sources.map((offer) => offer.module)).toEqual(["remote"]);
    const directory = sources[0]!.source as RemoteDirectory;
    const providers = { read, count: providerCount, listHealth, listProviders, setProjections };
    const manifest = () => buildUiManifest({ config, providers, modules: host, capabilities: {}, runtimePages: () => collectRuntimePages(sources) });
    return { config, host, directory, providers, manifest };
  }

  const page = (ui: UiManifest, id: string) => ui.pages.find((candidate) => candidate.id === id);

  it("renders a sidecar's widgets on its page, each reading that integration; nav joins the page's group", async () => {
    const { host, directory, manifest } = await boot([instance({ page: { nav: { group: "health" } } })]);
    try {
      startScheduler();
      // The first poll starts the describe; a loaded CI runner can take a few seconds.
      await vi.waitFor(() => expect(directory.snapshot()[0]?.describe).toBeDefined(), { timeout: 10_000 });
      const ui = manifest();
      expect(page(ui, "page:remote/ups")).toMatchObject({
        module: "remote",
        path: "/remote/ups",
        title: "UPS",
        component: "ConfigPage",
        layout: {
          sections: [
            {
              title: "UPS",
              columns: 2,
              widgets: [
                expect.objectContaining({ id: "widget:remote/ups.load", type: "core/meter", source: { id: "ups", kind: "remote" }, select: "load", projection: "widget:remote/ups.load" }),
                expect.objectContaining({ id: "widget:remote/ups.status", type: "core/key-value", source: { id: "ups", kind: "remote" } }),
                expect.objectContaining({ id: "widget:remote/ups.links", type: "core/link-tiles", title: "Links", span: 2, options: { links: DESCRIBE.links } }),
              ],
            },
          ],
        },
      });
      expect(ui.nav.filter((entry) => entry.module === "remote")).toEqual([
        expect.objectContaining({ id: "nav:remote/ups", page: "page:remote/ups", group: "health" }),
        expect.objectContaining({ id: "nav:remote/ups.nut", href: "https://nut.example/ui", group: "health", label: "NUT web UI" }),
      ]);
      // The select is evaluated server-side into the envelope, like a config page's.
      await vi.waitFor(() => expect(read("ups")?.projections?.["widget:remote/ups.load"]).toEqual({ value: 42 }), { timeout: 10_000 });
      expect(ui.findings.filter((finding) => finding.code.startsWith("REMOTE_"))).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it("routes the page before the first describe, with a placeholder; nav entries need the page's own entry", async () => {
    const { host, directory, manifest } = await boot([instance({ url: other.url })]);
    try {
      other.routes.set("/deck/v1/describe", json({}, 503));
      expect(page(manifest(), "page:remote/ups")?.layout?.sections).toEqual([
        expect.objectContaining({ widgets: [expect.objectContaining({ id: "widget:remote/ups.waiting", type: "core/markdown", source: null })] }),
      ]);
      directory.accept("ups", checkOk(DESCRIBE), []);
      const ui = manifest();
      expect(ui.nav.filter((entry) => entry.module === "remote")).toEqual([]);
      expect(ui.findings).toContainEqual(expect.objectContaining({ code: "REMOTE_NAV_UNPLACED", severity: "info", id: "page:remote/ups" }));
    } finally {
      await host.stop();
    }
  });

  it("an unreachable sidecar is its own degraded health entry and a finding; another sidecar stays ok", async () => {
    other.routes.delete("/deck/v1/describe");
    other.routes.set("/deck/v1/data", json({}, 503));
    const { host, directory, manifest, providers } = await boot([
      instance({ pollIntervalMs: 1_000 }),
      instance({ id: "pdu", title: "PDU", url: other.url, pollIntervalMs: 1_000 }),
    ]);
    try {
      startScheduler();
      // Health is read at each poll, so a describe's outcome shows from the poll after it.
      await vi.waitFor(() => {
        expect(read("ups")?.data).toEqual(DATA.data);
        expect(read("pdu")?.error).not.toBeNull();
        expect(directory.snapshot().find((entry) => entry.instance === "pdu")?.problem).toBeDefined();
        expect(listHealth().ups?.detail).toContain("describe: ok");
      }, { timeout: 10_000 });
      const app = createApp({ config: {} as never, providers, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger });
      const health = (await (await app.request("/api/health")).json()) as { status: string; providers: Record<string, { ok: boolean; detail?: string }> };
      expect(health.status).toBe("degraded");
      expect(health.providers.ups).toMatchObject({ ok: true, detail: expect.stringContaining("describe: ok (ups 1.2.0)") });
      // A failed poll's detail is its error, as for every provider; the describe problem is a finding.
      expect(health.providers.pdu).toMatchObject({ ok: false, detail: "upstream answered HTTP 503" });
      expect(manifest().findings).toContainEqual({
        code: "REMOTE_DESCRIBE_UNREACHABLE",
        severity: "warning",
        message: 'remote integration "pdu": upstream answered HTTP 404',
        id: "page:remote/pdu",
      });
    } finally {
      await host.stop();
    }
  });

  it("the ui config wins a contested path, and an override can switch the page or a widget off", async () => {
    const ui = {
      pages: [{ id: "power", path: "/remote/ups", title: "Power", sections: [{ title: "Mine", widgets: [{ type: "core/json", source: "ups" }] }] }],
      extensions: { "widget:remote/pdu.load": false, "page:remote/off": false },
    };
    const { host, directory, manifest } = await boot([instance(), instance({ id: "pdu", title: "PDU" }), instance({ id: "off", title: "Off" })], ui);
    try {
      for (const id of ["ups", "pdu", "off"]) directory.accept(id, checkOk({ ...DESCRIBE, id }), []);
      const resolved = manifest();
      expect(page(resolved, "page:ui/power")?.path).toBe("/remote/ups");
      expect(page(resolved, "page:remote/ups")).toBeUndefined();
      expect(resolved.findings).toContainEqual(expect.objectContaining({ code: "UI_PAGE_PATH_COLLISION", id: "page:remote/ups" }));
      const pduWidgets = page(resolved, "page:remote/pdu")?.layout?.sections.flatMap((section) => ("widgets" in section ? section.widgets.map((widget) => widget.id) : []));
      expect(pduWidgets).toEqual(["widget:remote/pdu.status", "widget:remote/pdu.links"]);
      expect(page(resolved, "page:remote/off")).toBeUndefined();
      expect(resolved.findings.filter((finding) => finding.code === "UI_UNKNOWN_EXTENSION")).toEqual([]);
    } finally {
      await host.stop();
    }
  });
});
