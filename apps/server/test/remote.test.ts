import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { CORE_WIDGET_TYPES } from "@deck/contract/modules/core";
import type { UiManifest } from "@deck/module-sdk";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { createModuleHost, kindRuntimes, planModules } from "../src/modules/host.js";
import { HttpJsonError } from "../src/providers/http-json/index.js";
import { registerAllProviders } from "../src/providers/index.js";
import { checkDescribe, REMOTE_MAX_STRING, REMOTE_WIDGET_TYPES } from "../src/providers/remote/describe.js";
import { RemoteDirectory } from "../src/providers/remote/directory.js";
import { RemoteProvider } from "../src/providers/remote/provider.js";
import { listHealth, listProviders, providerCount, read, register, setProjections, startScheduler, stopScheduler } from "../src/providers/registry.js";
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
// Observed a second ago, so the envelope is fresh (its observedAt sets its age).
const OBSERVED = new Date(Date.now() - 1_000).toISOString();
const DATA = { data: { load: 42, status: "OL" }, observedAt: OBSERVED };

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

type ProviderConfig = ConstructorParameters<typeof RemoteProvider>[1];

/** A provider over its own directory; `timeoutMs` is the request's. */
function provider(url: string, extra: Partial<ProviderConfig> & { timeoutMs?: number } = {}) {
  const { timeoutMs, request, ...rest } = extra;
  const directory = new RemoteDirectory();
  directory.declare("ups", "UPS", { path: "/remote/ups" });
  const config: ProviderConfig = { url, request: { ...request, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, ...rest };
  return { directory, provider: new RemoteProvider("ups", config, directory) };
}

describe("checkDescribe: declarative only, the config's own descriptors", () => {
  it("accepts a full document", () => {
    expect(checkDescribe(DESCRIBE, "ups")).toMatchObject({ ok: true, notes: [] });
  });

  it("allows only deck's declarative core types: never core/embed, health pills or another module's", () => {
    // core/embed is a real core type (it frames other sites), yet never a sidecar's.
    expect(CORE_WIDGET_TYPES.map((type) => type.type)).toContain("core/embed");
    expect([...REMOTE_WIDGET_TYPES]).not.toContain("core/embed");
    for (const type of ["core/embed", "core/health-pills", "portal/groups", "evil/script"]) {
      const result = checkDescribe({ ...DESCRIBE, widgets: [{ id: "w", type }] }, "ups");
      expect(result, type).toEqual({ ok: false, problem: `/widgets/0 type "${type}" is not one a sidecar may place` });
    }
  });

  it.each([
    ["a source of its own", { widgets: [{ id: "w", type: "core/json", source: "prometheus" }] }, /additional properties/],
    ["options its type refuses", { widgets: [{ id: "w", type: "core/meter", options: { max: "lots" } }] }, /^\/widgets\/0\/options\/max must be number$/],
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
    ["a protocol-relative markdown link", { widgets: [{ id: "w", type: "core/markdown", options: { content: "[x](//evil.example/)" } }] }, /content links somewhere other than an absolute http\(s\) URL/],
    ["a relative markdown link", { widgets: [{ id: "w", type: "core/markdown", options: { content: "see [health](/api/health)" } }] }, /content links somewhere/],
    ["a raw HTML link into deck", { widgets: [{ id: "w", type: "core/markdown", options: { content: '<a href="/api/health">x</a>' } }] }, /content links somewhere/],
    ["a markdown reference link to another scheme", { widgets: [{ id: "w", type: "core/markdown", options: { content: "[x][r]\n\n[r]: javascript:alert(1)" } }] }, /content links somewhere/],
    ["a reference link whose multi-line definition points into deck", { widgets: [{ id: "w", type: "core/markdown", options: { content: "see [x][id]\n\n[id]:\n  /api/health" } }] }, /content links somewhere/],
    ["a raw image map area into deck", { widgets: [{ id: "w", type: "core/markdown", options: { content: '<area href="/api/actions">' } }] }, /content links somewhere/],
    ["a raw button formaction into deck", { widgets: [{ id: "w", type: "core/markdown", options: { content: "<button formaction=/api/run>x</button>" } }] }, /content links somewhere/],
    ["a markdown image with a relative src", { widgets: [{ id: "w", type: "core/markdown", options: { content: "![x](img.png)" } }] }, /content links somewhere/],
  ])("refuses %s", (_label, patch, problem) => {
    const result = checkDescribe({ ...DESCRIBE, ...patch }, "ups");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problem).toMatch(problem);
  });

  it.each([
    ["prose with an attribute-like phrase", "Set data=on in upsd.conf"],
    ["prose with an assignment", "background = grey"],
    ["a fence holding a relative link", "```\n[a](/x)\n```"],
    ["a code span holding an href", "`href=\"/x\"`"],
  ])("accepts markdown with %s: only parsed links and real HTML tags are checked", (_label, content) => {
    expect(checkDescribe({ ...DESCRIBE, widgets: [{ id: "w", type: "core/markdown", options: { content } }] }, "ups").ok).toBe(true);
  });

  it("accepts markdown whose links are all absolute http(s) URLs, raw HTML included", () => {
    const content = '[a](https://a.example/) <https://b.example/> <a href="http://deck.local/api/health">c</a>';
    expect(checkDescribe({ ...DESCRIBE, widgets: [{ id: "w", type: "core/markdown", options: { content } }] }, "ups").ok).toBe(true);
  });

  it("never repeats a refused option's value in its problem", () => {
    const result = checkDescribe({ ...DESCRIBE, widgets: [{ id: "w", type: "core/meter", options: { max: "s3cr3t-looking-value" } }] }, "ups");
    expect(result.ok ? "" : result.problem).not.toContain("s3cr3t");
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
    expect(await remote.health()).toMatchObject({ ok: true, detail: expect.stringContaining(`data: HTTP 200, observed ${OBSERVED}; describe: `) });
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

  it("a describe whose markdown links into deck by a multi-line reference is refused; the last good one stays, with a finding", async () => {
    let body: unknown = DESCRIBE;
    other.routes.set("/deck/v1/describe", (req, res) => json(body)(req, res));
    const { directory, provider: remote } = provider(other.url);
    await remote.describe();
    body = { ...DESCRIBE, widgets: [{ id: "notes", type: "core/markdown", options: { content: "[x][id]\n\n[id]:\n  /api/health" } }] };
    await remote.describe();
    const [entry] = directory.snapshot();
    expect(entry?.describe).toEqual(DESCRIBE);
    expect(entry?.problem).toEqual({ code: "REMOTE_DESCRIBE_INVALID", message: "/widgets/0 options: content links somewhere other than an absolute http(s) URL" });
    expect(directory.current().findings).toContainEqual(expect.objectContaining({ code: "REMOTE_DESCRIBE_INVALID", id: "page:remote/ups" }));
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

  it("asks again after describeIntervalMs once one succeeded; after a failure, after a backoff that doubles up to the interval", async () => {
    let now = 1_000;
    let answer: Route = json(DESCRIBE);
    other.routes.set("/deck/v1/describe", (req, res) => answer(req, res));
    other.routes.set("/deck/v1/data", json(DATA));
    const { provider: remote } = provider(other.url, { describeIntervalMs: 60_000, clock: { now: () => now } });
    const describes = () => other.seen.filter((seen) => seen.path === "/deck/v1/describe").length;
    const poll = async () => {
      await remote.fetch();
      await remote.describing();
    };
    // The first poll starts one; the next, within the interval, does not.
    await poll();
    await poll();
    expect(describes()).toBe(1);
    now += 60_000;
    answer = json({}, 500);
    await poll();
    expect(describes()).toBe(2);
    // Failed: not before 5s, then 10s, 20s, 40s, and never more than the interval.
    const waits: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = describes();
      let waited = 0;
      while (describes() === before) {
        now += 1_000;
        waited += 1_000;
        await poll();
      }
      waits.push(waited);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
  });

  it("never rejects or leaves an unhandled rejection when the directory throws, and stays consistent", async () => {
    const { directory, provider: remote } = provider(sidecar.url);
    vi.spyOn(directory, "accept").mockImplementation(() => {
      throw new Error("boom");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(remote.describe()).resolves.toBeUndefined();
      await remote.fetch();
      await remote.describing();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(directory.snapshot()[0]?.problem).toEqual({ code: "REMOTE_DESCRIBE_INVALID", message: "deck could not check the describe document" });
      expect((await remote.health()).detail).toMatch(/describe: invalid \(deck could not check the describe document\)$/);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("stopped during a describe, aborts it: nothing reaches the directory and no listener hears of it", async () => {
    let started!: () => void;
    const reached = new Promise<void>((resolve) => (started = resolve));
    other.routes.set("/deck/v1/describe", () => started());
    const { directory, provider: remote } = provider(other.url, { timeoutMs: 5_000 });
    const heard = vi.fn();
    directory.subscribe(heard);
    const describing = remote.describe();
    await reached;
    const before = directory.snapshot();
    const startedAt = Date.now();
    remote.stop();
    await describing;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(directory.snapshot()).toEqual(before);
    expect(heard).not.toHaveBeenCalled();
    // A stopped provider never describes again.
    await remote.describe();
    expect(other.seen.filter((seen) => seen.path === "/deck/v1/describe")).toHaveLength(1);
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

describe("the remote provider: observedAt", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const bare = (url: string) => provider(url).provider;

  it("the sidecar's observedAt sets the envelope's observedAt and age: old data is stale", async () => {
    // Past the 60s ttl, inside the default unreachable bound.
    const old = minutesAgo(1.5);
    other.routes.set("/deck/v1/data", json({ data: { load: 1 }, observedAt: old }));
    other.routes.set("/deck/v1/describe", json(DESCRIBE));
    register(bare(other.url), { ttlMs: 60_000 });
    startScheduler();
    await vi.waitFor(() => expect(read("ups")?.data).toEqual({ load: 1 }), { timeout: 5_000 });
    expect(read("ups")?.freshness).toMatchObject({ state: "stale", observedAt: new Date(old).toISOString() });
    expect(read("ups")!.freshness.ageMs!).toBeGreaterThanOrEqual(89_000);
  });

  it("data older than unreachableAfterMs from a source that answers is stale, never unreachable; health stays ok", async () => {
    // 10 minutes old against a 60s ttl (unreachable after 3 × ttl): the poll itself succeeded.
    const old = minutesAgo(10);
    other.routes.set("/deck/v1/data", json({ data: { load: 3 }, observedAt: old }));
    other.routes.set("/deck/v1/describe", json(DESCRIBE));
    register(bare(other.url), { ttlMs: 60_000 });
    startScheduler();
    await vi.waitFor(() => expect(read("ups")?.data).toEqual({ load: 3 }), { timeout: 5_000 });
    expect(read("ups")?.freshness).toMatchObject({ state: "stale", observedAt: new Date(old).toISOString() });
    expect(read("ups")!.freshness.ageMs!).toBeGreaterThanOrEqual(599_000);
    expect(listHealth().ups).toMatchObject({ ok: true });
  });

  it("without observedAt the poll time is used, and a future observedAt counts as now", async () => {
    other.routes.set("/deck/v1/data", json({ data: { load: 1 } }));
    const ahead = new Sidecar();
    await ahead.start();
    try {
      ahead.routes.set("/deck/v1/data", json({ data: { load: 2 }, observedAt: new Date(Date.now() + 3_600_000).toISOString() }));
      register(bare(other.url), { ttlMs: 60_000 });
      const pdu = new RemoteProvider("pdu", { url: ahead.url, request: {} }, new RemoteDirectory());
      register(pdu, { ttlMs: 60_000 });
      const before = Date.now();
      startScheduler();
      await vi.waitFor(() => {
        expect(read("ups")?.data).toEqual({ load: 1 });
        expect(read("pdu")?.data).toEqual({ load: 2 });
      }, { timeout: 5_000 });
      for (const id of ["ups", "pdu"]) {
        const { state, observedAt } = read(id)!.freshness;
        expect(state, id).toBe("fresh");
        expect(Date.parse(observedAt!), id).toBeGreaterThanOrEqual(before);
        expect(Date.parse(observedAt!), id).toBeLessThanOrEqual(Date.now());
      }
    } finally {
      await ahead.stop();
    }
  });

  it("is shown normalised, and an overlong one is refused without being echoed", async () => {
    other.routes.set("/deck/v1/data", json({ data: 1, observedAt: "2026-10-09T11:00:00+02:00" }));
    other.routes.set("/deck/v1/describe", json(DESCRIBE));
    const remote = bare(other.url);
    await remote.fetch();
    expect((await remote.health()).detail).toMatch(/^data: HTTP 200, observed 2026-10-09T09:00:00\.000Z; /);
    expect(remote.observedAt()).toBe(Date.parse("2026-10-09T09:00:00Z"));
    const long = `2026-10-09T09:00:00.${"1".repeat(900_000)}Z`;
    other.routes.set("/deck/v1/data", json({ data: 1, observedAt: long }));
    const started = Date.now();
    await expect(remote.fetch()).rejects.toThrow("sidecar data response's observedAt is not an RFC 3339 time");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(await remote.health())).not.toContain("1111111111");
    await remote.describing();
  });
});

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
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "PROVIDER_ID_RESERVED", severity: "error" }));
  });

  it("wires credentialEnv, auth, maxBytes and timeoutMs from the estate through to each request", async () => {
    const seenAuth: Array<string | undefined> = [];
    other.routes.set("/deck/v1/data", (req, res) => {
      seenAuth.push(req.headers.authorization);
      json({ data: { ok: true } })(req, res);
    });
    other.routes.set("/deck/v1/describe", json(DESCRIBE));
    const big = new Sidecar();
    const slow = new Sidecar();
    await big.start();
    await slow.start();
    try {
      big.routes.set("/deck/v1/data", json({ data: { pad: "x".repeat(4_096) } }));
      slow.routes.set("/deck/v1/data", () => {});
      const hostEnv = { UPS_TOKEN: SECRET };
      const result = load({
        arg: configDir([
          instance({ url: other.url, credentialEnv: "UPS_TOKEN", auth: { scheme: "bearer" }, pollIntervalMs: 60_000 }),
          instance({ id: "big", title: "Big", url: big.url, maxBytes: 1_024, pollIntervalMs: 60_000 }),
          instance({ id: "slow", title: "Slow", url: slow.url, timeoutMs: 200, pollIntervalMs: 60_000 }),
        ]),
        env: hostEnv,
      });
      expect(errors(result)).toEqual([]);
      const { plan, usable } = planModules({ modules: BUILTIN_MODULES, sectionOf: () => undefined, env: hostEnv });
      registerAllProviders(result.config!, kindRuntimes(plan.filter((e) => e.enabled).map((e) => usable.get(e.id)!), hostEnv));
      startScheduler();
      await vi.waitFor(() => {
        expect(read("ups")?.data).toEqual({ ok: true });
        expect(read("big")?.error).not.toBeNull();
        expect(read("slow")?.error).not.toBeNull();
      }, { timeout: 5_000 });
      expect(seenAuth).toEqual([`Bearer ${SECRET}`]);
      expect(other.seen.filter((seen) => seen.path === "/deck/v1/describe").map((seen) => seen.authorization)).toEqual([`Bearer ${SECRET}`]);
      expect(read("big")?.error).toEqual({ message: "upstream response exceeds 1024 bytes" });
      expect(read("slow")?.error?.message).toMatch(/timed out after 200ms/);
    } finally {
      await big.stop();
      await slow.stop();
    }
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
    // A 1s poll: a describe that fails (a pooled socket the fixture closed, say) is asked again at the next poll.
    const { host, directory, manifest } = await boot([instance({ pollIntervalMs: 1_000, page: { nav: { group: "health" } } })]);
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
      const placeholder = () => {
        const [section] = page(manifest(), "page:remote/ups")?.layout?.sections ?? [];
        const widgets = section !== undefined && "widgets" in section ? section.widgets : [];
        expect(widgets).toEqual([expect.objectContaining({ id: "widget:remote/ups.waiting", type: "core/markdown", source: null })]);
        return widgets[0]!.options.content;
      };
      // A fixed text by state, never the problem itself.
      expect(placeholder()).toBe("This sidecar has not described any widgets yet.");
      directory.refuse("ups", { code: "REMOTE_DESCRIBE_UNREACHABLE", message: "upstream answered HTTP 503 <script>" });
      expect(placeholder()).toBe("This sidecar could not be reached to describe its widgets. See the findings in /api/ui.");
      directory.refuse("ups", { code: "REMOTE_DESCRIBE_INVALID", message: "/title must NOT have more than 80 characters" });
      expect(placeholder()).toBe("This sidecar's description was refused. See the findings in /api/ui.");
      directory.accept("ups", checkOk({ ...DESCRIBE, widgets: [], links: [], nav: [] }), []);
      expect(placeholder()).toBe("This sidecar describes no widgets.");
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
    const nav = { page: { nav: { group: "health" } } };
    const { host, directory, manifest } = await boot(
      [instance(nav), instance({ id: "pdu", title: "PDU", ...nav }), instance({ id: "off", title: "Off", ...nav })],
      ui,
    );
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
      // A sidecar's nav entries go with its page: none for the unrouted (ups) or switched-off (off) page.
      expect(resolved.nav.filter((entry) => entry.module === "remote").map((entry) => entry.id)).toEqual(["nav:remote/pdu", "nav:remote/pdu.nut"]);
      // Each widget of a runtime page renders links under the external-only policy.
      const linkPolicies = page(resolved, "page:remote/pdu")?.layout?.sections.flatMap((section) => ("widgets" in section ? section.widgets.map((widget) => widget.linkPolicy) : []));
      expect(linkPolicies).toEqual(["external", "external"]);
      expect(page(resolved, "page:ui/power")?.layout?.sections.flatMap((section) => ("widgets" in section ? section.widgets.map((widget) => widget.linkPolicy) : []))).toEqual([undefined]);
    } finally {
      await host.stop();
    }
  });
});
