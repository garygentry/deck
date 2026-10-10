import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { JsonObject, ProviderBinding, ProviderKindContext } from "@deck/module-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { POLL_DEFAULTS } from "../src/contract/index.js";
import { logger } from "../src/log/logger.js";
import { listHealth, read, register, resolveTiming, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { instanceRequest } from "../../../modules/http-json/server/request-config.js";
import { HttpHealthProvider } from "../../../modules/http-health/server/index.js";
import { httpHealthModule } from "../../../modules/http-health/server/module.js";
import { linkModule } from "../../../modules/link/server/module.js";
import { makeConfigDir } from "./util/tmp-config.js";

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Load an estate with one host whose overlay carries `bindings` (and any `extra` overlay keys). */
function loadBindings(bindings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const estateDir = makeConfigDir({
    "00-base.yaml": { schemaVersion: 2, estate: { name: "bindings" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }] },
    "10-overlay.yaml": { schemaVersion: 2, hosts: [{ name: "alpha", bindings }], ...extra },
  });
  try {
    return load({ arg: estateDir.dir, modules: BUILTIN_MODULES, env: {} });
  } finally {
    estateDir.cleanup();
  }
}

/** Call a kind's binding handler the way the kernel does, with an unchecked binding value. */
function offers(handler: { binding?: (binding: ProviderBinding, context: ProviderKindContext) => readonly unknown[] } | undefined, kind: string, value: JsonObject) {
  return handler!.binding!({ id: `${kind}:host:alpha`, owner: "host:alpha", value, env: { get: () => undefined } }, {} as ProviderKindContext);
}

describe("link binding href", () => {
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:ops@example.com",
    "docs/runbook",
    "//evil.example/",
    "/\\evil.example/",
    "https://ok.example/\tx",
  ])("refuses %j at validation with LINK_HREF_UNSAFE", (href) => {
    const result = loadBindings({ link: { href } });
    expect(result.exitClass).not.toBe(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "LINK_HREF_UNSAFE", severity: "error", path: "/hosts/0/bindings/link/href" }));
  });

  it.each(["https://grafana.lab/", "http://10.0.0.5:3000/d/x", "/inventory/hosts/alpha"])("accepts %j", (href) => {
    const result = loadBindings({ link: { href } });
    expect(result.exitClass).toBe(0);
    expect(result.findings.filter((finding) => finding.code === "LINK_HREF_UNSAFE")).toEqual([]);
  });

  it.each([
    ["missing", {}, "/hosts/0/bindings/link"],
    ["not text", { href: 42 }, "/hosts/0/bindings/link/href"],
  ])("reports an href that is %s as LINK_HREF_MISSING", (_name, binding, path) => {
    const result = loadBindings({ link: binding });
    expect(result.exitClass).not.toBe(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "LINK_HREF_MISSING", severity: "error", path }));
  });

  it("registers no provider for an unsafe href even when validation is bypassed, so it is never served", () => {
    const handler = linkModule.kinds?.link;
    expect(offers(handler, "link", { href: "javascript:alert(1)", label: "x" })).toEqual([]);
    expect(offers(handler, "link", { href: "data:text/html,x" })).toEqual([]);
    const [offer] = offers(handler, "link", { href: "https://grafana.lab/", label: "Grafana" }) as Array<{ provider: { fetch(): Promise<unknown> } }>;
    return expect(offer!.provider.fetch()).resolves.toEqual({ label: "Grafana", href: "https://grafana.lab/" });
  });
});

describe("http-health binding timing", () => {
  it.each([
    ["0", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "5000"],
    ["past the timer limit (3e9)", 3e9],
    ["below the 1000 ms floor (1)", 1],
    ["a fraction (0.5)", 0.5],
    ["a non-integer (1500.5)", 1500.5],
  ])("refuses a %s poll interval at validation with HTTP_HEALTH_TIMING_INVALID, failing validate and boot", (_name, bad) => {
    const result = loadBindings({ "http-health": { url: "http://alpha/", timing: { pollIntervalMs: bad, timeoutMs: 2_000 } } });
    expect(result.exitClass).not.toBe(0);
    const invalid = result.findings.filter((finding) => finding.code === "HTTP_HEALTH_TIMING_INVALID");
    expect(invalid).toEqual([expect.objectContaining({ severity: "error", path: "/hosts/0/bindings/http-health/timing/pollIntervalMs", message: expect.stringContaining("from 1000 to 2147483647") })]);
  });

  it.each([
    ["3e9", 3e9, true],
    ["0.5", 0.5, true],
    ["1", 1, false],
    ["2147483647", 2 ** 31 - 1, false],
  ])("checks timeoutMs %s against [1, 2^31-1] in whole ms", (_name, value, refused) => {
    const result = loadBindings({ "http-health": { url: "http://alpha/", timing: { timeoutMs: value } } });
    const invalid = result.findings.filter((finding) => finding.code === "HTTP_HEALTH_TIMING_INVALID");
    expect(invalid.length > 0).toBe(refused);
  });

  it.each([
    ["not an object", 5_000, "/hosts/0/bindings/http-health/timing"],
    ["a list", [5_000], "/hosts/0/bindings/http-health/timing"],
    ["an unknown key", { pollIntervalMs: 5_000, intervalMs: 5_000 }, "/hosts/0/bindings/http-health/timing/intervalMs"],
  ])("refuses a timing that is %s", (_name, value, path) => {
    const result = loadBindings({ "http-health": { url: "http://alpha/", timing: value } });
    expect(result.exitClass).not.toBe(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "HTTP_HEALTH_TIMING_INVALID", path }));
  });

  it("accepts positive, finite timing", () => {
    const result = loadBindings({ "http-health": { url: "http://alpha/", timing: { pollIntervalMs: 15_000, ttlMs: 30_000, unreachableAfterMs: 90_000, timeoutMs: 2_500 } } });
    expect(result.exitClass).toBe(0);
    expect(result.findings.filter((finding) => finding.code === "HTTP_HEALTH_TIMING_INVALID")).toEqual([]);
  });

  it("drops 0, negative, NaN and out-of-range values at runtime, so the scheduler never sees them", () => {
    const handler = httpHealthModule.kinds?.["http-health"];
    const [offer] = offers(handler, "http-health", {
      url: "http://alpha/",
      timing: { pollIntervalMs: 0, ttlMs: -1, unreachableAfterMs: Number.NaN, timeoutMs: 3e9 },
    } as unknown as JsonObject) as Array<{ timing?: unknown }>;
    expect(offer!.timing).toEqual({});
    const [valid] = offers(handler, "http-health", { url: "http://alpha/", timing: { pollIntervalMs: 0, timeoutMs: 2_000 } }) as Array<{ timing?: unknown }>;
    expect(valid!.timing).toEqual({ timeoutMs: 2_000 });
  });
});

describe("http-health probe", () => {
  it("passes the poll's signal to fetch and does not follow redirects", async () => {
    const fetchStub = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchStub);
    const controller = new AbortController();
    await new HttpHealthProvider("probe", { url: "http://alpha/" }).fetch({ signal: controller.signal });
    expect(fetchStub.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual", signal: controller.signal });
  });

  it("cancels the unread response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull: (stream) => stream.enqueue(new Uint8Array(1024)), cancel: () => { cancelled = true; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const result = await new HttpHealthProvider("probe", { url: "http://alpha/" }).fetch({ signal: new AbortController().signal });
    expect(result).toMatchObject({ up: true, status: 200 });
    expect(cancelled).toBe(true);
  });

  it("lets a late answer to an aborted probe change nothing: it rejects and health stays down", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      return new Response(null, { status: 200 });
    }));
    const provider = new HttpHealthProvider("late", { url: "http://alpha/" });
    await expect(provider.fetch({ signal: controller.signal })).rejects.toThrow();
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "probe aborted" });
  });

  it("is aborted by the registry when the poll times out", async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      seen = init.signal!;
      init.signal!.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    })));
    vi.useFakeTimers();
    const provider = new HttpHealthProvider("slow", { url: "http://alpha/" });
    register(provider, { pollIntervalMs: 60_000, timeoutMs: 50 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(60);
    expect(seen?.aborted).toBe(true);
    expect(read("slow")).toMatchObject({ freshness: { state: "pending" }, error: { message: expect.stringContaining("timed out") } });
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "probe aborted" });
  });

  it("never lets a superseded probe write health: A times out, B succeeds, A settles late", async () => {
    let settleA: ((response: Response) => void) | undefined;
    const fetchStub = vi.fn()
      // A ignores its signal and answers only when the test says so.
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { settleA = resolve; }))
      .mockImplementation(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    vi.useFakeTimers();
    const provider = new HttpHealthProvider("overlap", { url: "http://alpha/" });
    register(provider, { pollIntervalMs: 1_000, timeoutMs: 50 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(60); // A times out
    expect(read("overlap")?.error).toEqual({ message: expect.stringContaining("timed out") });
    await vi.advanceTimersByTimeAsync(1_000); // B succeeds
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(read("overlap")).toMatchObject({ freshness: { state: "fresh" }, data: { up: true, status: 200 }, error: null });

    settleA!(new Response(null, { status: 503 })); // A settles late, with a worse answer
    await vi.advanceTimersByTimeAsync(0);
    await expect(provider.health()).resolves.toEqual({ ok: true, detail: "status 200" });
    expect(listHealth().overlap).toMatchObject({ ok: true, detail: "status 200" });
    expect(read("overlap")).toMatchObject({ data: { up: true, status: 200 }, error: null });
  });

  describe("against a real server", () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/moved") {
          response.writeHead(302, { location: "/down" }).end();
        } else {
          response.writeHead(500).end("down");
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("counts a 3xx as up, without following it to the target", async () => {
      const provider = new HttpHealthProvider("moved", { url: `${base}/moved` });
      await expect(provider.fetch({ signal: new AbortController().signal })).resolves.toMatchObject({ up: true, status: 302 });
      await expect(provider.health()).resolves.toEqual({ ok: true, detail: "status 302" });
    });

    it("counts a 5xx as down", async () => {
      await expect(new HttpHealthProvider("down", { url: `${base}/down` }).fetch()).resolves.toMatchObject({ up: false, status: 500 });
    });
  });
});

describe("the shared timing rule (integer ms; poll interval 1000 to 2^31-1, timeout 1 to 2^31-1)", () => {
  it.each([
    ["3e9", 3e9, 2 ** 31 - 1],
    ["1", 1, 1_000],
    ["0.5", 0.5, 1_000],
    ["1500.5", 1500.5, 1_501],
  ])("the kernel clamps a poll interval of %s and logs a warning", (_name, given, used) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.useFakeTimers();
    register({ id: `clamp-${_name}`, kind: "test", health: async () => ({ ok: true }), fetch: async () => "ok" }, { pollIntervalMs: given });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "provider.timing-adjusted", id: `clamp-${_name}`, field: "pollIntervalMs", given: String(given), used }),
      expect.any(String),
    );
  });

  it("resolveTiming clamps timeouts into [1, 2^31-1] and gives a non-finite value its default", () => {
    const adjusted: unknown[] = [];
    const timing = resolveTiming(
      { timeoutMs: 3e9, ttlMs: 0.5, unreachableAfterMs: Number.NaN, pollIntervalMs: Number.POSITIVE_INFINITY },
      (field, given, used) => adjusted.push([field, given, used]),
    );
    expect(timing).toMatchObject({ timeoutMs: 2 ** 31 - 1, ttlMs: 1, unreachableAfterMs: 3, pollIntervalMs: POLL_DEFAULTS.pollIntervalMs });
    expect(adjusted).toHaveLength(4);
    expect(resolveTiming({ timeoutMs: 1, pollIntervalMs: 1_000 }, () => { throw new Error("in range: not adjusted"); })).toMatchObject({ timeoutMs: 1, pollIntervalMs: 1_000 });
  });

  it("http-json's runtime timing uses the same rule", () => {
    const { timing } = instanceRequest({ pollIntervalMs: 3e9, timeoutMs: 0.5, ttlMs: 1_500 }, () => ({ get: () => undefined }));
    expect(timing).toEqual({ ttlMs: 1_500 });
    expect(instanceRequest({ pollIntervalMs: 15_000, timeoutMs: 1 }, () => ({ get: () => undefined })).timing).toEqual({ pollIntervalMs: 15_000, timeoutMs: 1, ttlMs: 15_000 });
  });
});

describe("host, service and portal link hrefs", () => {
  const base = {
    schemaVersion: 2,
    estate: { name: "links" },
    hosts: [{ name: "alpha", kind: "vm", purpose: "p" }],
    services: [{ host: "alpha", name: "web", kind: "container", purpose: "p" }],
  };
  const loadLinks = (href: string) => {
    const estateDir = makeConfigDir({
      "00-base.yaml": { ...base, hosts: [{ ...base.hosts[0], links: [{ title: "H", href }] }], services: [{ ...base.services[0], links: [{ title: "S", href }] }] },
      "10-overlay.yaml": { schemaVersion: 2, modules: { portal: { groups: [{ id: "g", title: "G", items: [{ type: "link", title: "L", href }, { type: "group", id: "sub", title: "Sub", items: [{ type: "link", title: "M", href }] }] }] } } },
    });
    try {
      return load({ arg: estateDir.dir, modules: BUILTIN_MODULES, env: {} });
    } finally {
      estateDir.cleanup();
    }
  };

  it.each(["data:text/html,<script>alert(1)</script>", "javascript:alert(1)", "//evil.example/"])("refuses %j everywhere a link is rendered", (href) => {
    const result = loadLinks(href);
    expect(result.exitClass).not.toBe(0);
    const at = (code: string) => result.findings.filter((finding) => finding.code === code).map((finding) => [finding.path, finding.severity]);
    expect(at("ENTITY_LINK_HREF_UNSAFE")).toEqual([["/hosts/0/links/0/href", "error"], ["/services/0/links/0/href", "error"]]);
    expect(at("PORTAL_LINK_HREF_UNSAFE")).toEqual([
      ["/modules/portal/groups/0/items/0/href", "error"],
      ["/modules/portal/groups/0/items/1/items/0/href", "error"],
    ]);
  });

  it.each(["https://grafana.lab/", "/inventory"])("accepts %j", (href) => {
    const result = loadLinks(href);
    expect(result.findings.filter((finding) => finding.code.endsWith("_HREF_UNSAFE"))).toEqual([]);
  });
});
