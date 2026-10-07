import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatusProvider } from "../src/providers/gatus/index.js";
import { read, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { processEnv, registerGatus } from "./util/register-kinds.js";

describe("GatusProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.DECK_GATUS_TOKEN;
  });

  it("maps only the last result and converts nanoseconds to rounded milliseconds", async () => {
    const raw = [
      {
        key: "core_api",
        name: "Core API",
        group: "Core",
        results: [
          { success: false, duration: 999_000_000 },
          { success: true, duration: 1_600_000 },
        ],
        uptime: 99.99,
        history: [{ success: false }],
      },
      { key: "no-results", name: "Waiting" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(raw)));

    await expect(new GatusProvider("gatus", { baseUrl: "http://gatus" }).fetch()).resolves.toEqual({
      endpoints: [
        { key: "core_api", name: "Core API", group: "Core", up: true, latencyMs: 2 },
        { key: "no-results", name: "Waiting", group: undefined, up: false, latencyMs: null },
      ],
    });
  });

  it("issues exactly one GET and removes one trailing base-url slash", async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchStub);

    await new GatusProvider("gatus", { baseUrl: "http://gatus/" }).fetch();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith("http://gatus/api/v1/endpoints/statuses", {
      method: "GET",
      headers: {},
    });
  });

  it("resolves credentials from the environment at fetch time", async () => {
    const provider = new GatusProvider("gatus", {
      baseUrl: "http://gatus",
      credentialEnv: "DECK_GATUS_TOKEN",
      env: processEnv,
    });
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchStub);

    process.env.DECK_GATUS_TOKEN = "Bearer first";
    await provider.fetch();
    process.env.DECK_GATUS_TOKEN = "Bearer rotated";
    await provider.fetch();
    delete process.env.DECK_GATUS_TOKEN;
    await provider.fetch();

    expect(fetchStub.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Authorization: "Bearer first" },
      { Authorization: "Bearer rotated" },
      {},
    ]);
    expect(JSON.stringify(provider)).not.toContain("Bearer");
  });

  it("treats a non-2xx response as a successful empty fresh poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(new GatusProvider("direct", { baseUrl: "http://gatus" }).fetch()).resolves.toEqual({ endpoints: [] });

    registerGatus("gatus", { baseUrl: "http://gatus", timing: { pollIntervalMs: 10_000 } });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(read("gatus")).toMatchObject({
      freshness: { state: "fresh" },
      data: { endpoints: [] },
      error: null,
    });
  });

  it("throws on transport rejection and publishes unreachable while retaining prior data", async () => {
    // Persistent rejection so the second poll fails deterministically; health() is now non-I/O.
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(Response.json([{ key: "cached", results: [{ success: true, duration: 1_000_000 }] }]))
      .mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchStub);
    registerGatus("gatus", { baseUrl: "http://gatus", timing: { pollIntervalMs: 1_000 } });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const prior = read("gatus")?.data;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(read("gatus")).toMatchObject({
      freshness: { state: "unreachable" },
      data: prior,
      error: { message: "connection refused" },
    });
  });

  it("returns cached non-I/O health that never calls fetch itself", async () => {
    const raw = [{ key: "e", results: [{ success: true, duration: 1_000_000 }] }];
    const fetchStub = vi.fn(async () => Response.json(raw));
    vi.stubGlobal("fetch", fetchStub);
    const provider = new GatusProvider("gatus", { baseUrl: "http://gatus" });

    // Before any poll: awaiting, and health() alone issues no request.
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "Awaiting first poll" });
    expect(fetchStub).not.toHaveBeenCalled();

    // A successful fetch caches the endpoint-count health; health() reads it without a new request.
    await provider.fetch();
    await expect(provider.health()).resolves.toEqual({ ok: true, detail: "1 endpoints" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("caches unhealthy detail via catch-before-rethrow while fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const provider = new GatusProvider("gatus", { baseUrl: "http://gatus" });

    await expect(provider.fetch()).rejects.toThrow("network down");
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "network down" });
  });
});
