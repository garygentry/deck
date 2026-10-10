import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { JsonObject, ProviderBinding, ProviderKindContext } from "@deck/module-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { read, register, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { HttpHealthProvider } from "../../../modules/http-health/server/index.js";
import { httpHealthModule } from "../../../modules/http-health/server/module.js";
import { linkModule } from "../../../modules/link/server/module.js";
import { makeConfigDir } from "./util/tmp-config.js";

afterEach(() => {
  stopScheduler();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Load an estate with one host whose overlay carries `bindings`. */
function loadBindings(bindings: Record<string, unknown>) {
  const estateDir = makeConfigDir({
    "00-base.yaml": { schemaVersion: 2, estate: { name: "bindings" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }] },
    "10-overlay.yaml": { schemaVersion: 2, hosts: [{ name: "alpha", bindings }] },
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
  ])("refuses a %s timing value at validation with HTTP_HEALTH_TIMING_INVALID", (_name, bad) => {
    const result = loadBindings({ "http-health": { url: "http://alpha/", timing: { pollIntervalMs: bad, timeoutMs: 2_000 } } });
    expect(result.exitClass).not.toBe(0);
    const invalid = result.findings.filter((finding) => finding.code === "HTTP_HEALTH_TIMING_INVALID");
    expect(invalid).toEqual([expect.objectContaining({ severity: "error", path: "/hosts/0/bindings/http-health/timing/pollIntervalMs" })]);
  });

  it("accepts positive, finite timing", () => {
    const result = loadBindings({ "http-health": { url: "http://alpha/", timing: { pollIntervalMs: 15_000, ttlMs: 30_000, unreachableAfterMs: 90_000, timeoutMs: 2_500 } } });
    expect(result.exitClass).toBe(0);
    expect(result.findings.filter((finding) => finding.code === "HTTP_HEALTH_TIMING_INVALID")).toEqual([]);
  });

  it("drops 0, negative, NaN and Infinity at runtime, so the scheduler never sees them", () => {
    const handler = httpHealthModule.kinds?.["http-health"];
    const [offer] = offers(handler, "http-health", {
      url: "http://alpha/",
      timing: { pollIntervalMs: 0, ttlMs: -1, unreachableAfterMs: Number.NaN, timeoutMs: Number.POSITIVE_INFINITY },
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
