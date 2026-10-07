import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POLL_DEFAULTS,
  type Provider,
  type ProviderFetchContext,
} from "../src/contract/index.js";
import { HttpHealthProvider } from "../src/providers/http-health/index.js";
import { LinkProvider } from "../src/providers/link/index.js";
import { registerHttpHealth, registerLink } from "./util/register-kinds.js";
import {
  deriveState,
  listEnvelopes,
  listHealth,
  listMetrics,
  listStats,
  providerCount,
  read,
  register,
  resolveTiming,
  startScheduler,
  stopScheduler,
} from "../src/providers/registry.js";

const base = {
  isStatic: false,
  hasSuccess: true,
  errored: false,
  failureFreshness: "immediate-unreachable" as const,
  ageMs: 0,
  ttlMs: 1_000,
  unreachableAfterMs: 3_000,
};

describe("provider registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("derives static first", () => {
    expect(deriveState({ ...base, isStatic: true, hasSuccess: false, errored: true })).toBe("static");
  });

  it("derives pending before any success", () => {
    expect(deriveState({ ...base, hasSuccess: false })).toBe("pending");
  });

  it("derives unreachable for the last poll error", () => {
    expect(deriveState({ ...base, errored: true })).toBe("unreachable");
  });

  it("derives unreachable beyond the unreachable threshold", () => {
    expect(deriveState({ ...base, ageMs: 3_001 })).toBe("unreachable");
  });

  it("derives stale beyond ttl through the unreachable threshold", () => {
    expect(deriveState({ ...base, ageMs: 3_000 })).toBe("stale");
  });

  it("derives fresh through the ttl threshold", () => {
    expect(deriveState({ ...base, ageMs: 1_000 })).toBe("fresh");
  });

  it("resolves defaults and derives unreachable from an overridden ttl", () => {
    expect(resolveTiming()).toEqual({ ...POLL_DEFAULTS, failureFreshness: "immediate-unreachable" });
    expect(resolveTiming({ ttlMs: 10_000 })).toEqual({
      pollIntervalMs: POLL_DEFAULTS.pollIntervalMs,
      ttlMs: 10_000,
      unreachableAfterMs: 30_000,
      timeoutMs: POLL_DEFAULTS.timeoutMs,
      failureFreshness: "immediate-unreachable",
    });
    expect(resolveTiming({ failureFreshness: "age-retained" }).failureFreshness).toBe("age-retained");
  });

  it("rejects duplicate ids with a stable code", () => {
    const provider = makeProvider("same", "test", async () => "value");
    register(provider);
    expect(() => register(provider)).toThrow(expect.objectContaining({ code: "PROVIDER_DUPLICATE_ID" }));
  });

  it("seeds a permanent static link without an interval", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    register(makeProvider("link-b", "link", async () => ({ href: "/b" })), undefined, undefined, { static: true });
    register(makeProvider("link-a", "link", async () => ({ href: "/a" })), undefined, undefined, { static: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(interval).not.toHaveBeenCalled();
    expect(read("link-a")).toMatchObject({
      freshness: { state: "static", observedAt: null, ageMs: null, ttlMs: null },
      data: { href: "/a" },
    });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    expect(read("link-a")?.freshness.state).toBe("static");
    expect(listEnvelopes().map(({ id }) => id)).toEqual(["link-a", "link-b"]);
    expect(providerCount()).toBe(2);
  });

  it("re-derives freshness on read and returns undefined for an unknown id", async () => {
    register(makeProvider("polled", "test", async () => "cached"), {
      pollIntervalMs: 10_000,
      ttlMs: 1_000,
      unreachableAfterMs: 3_000,
    });
    expect(read("missing")).toBeUndefined();
    expect(read("polled")?.freshness.state).toBe("pending");

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("polled")?.freshness.state).toBe("fresh");
    vi.advanceTimersByTime(1_001);
    expect(read("polled")?.freshness.state).toBe("stale");
    vi.advanceTimersByTime(2_000);
    expect(read("polled")?.freshness.state).toBe("unreachable");
  });

  it("contains a failed tick and publishes its error", async () => {
    register(makeProvider("broken", "test", async () => {
      throw new Error("upstream unavailable");
    }), { pollIntervalMs: 10_000 });

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("broken")).toMatchObject({
      freshness: { state: "pending", observedAt: null, ageMs: null },
      data: null,
      error: { message: "upstream unavailable" },
    });
  });

  it("retains per-provider poll counters and last-poll latency for listMetrics", async () => {
    let fail = false;
    register(makeProvider("flaky", "test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (fail) throw new Error("down");
      return "ok";
    }), { pollIntervalMs: 10_000, timeoutMs: 5_000 });

    expect(listMetrics()).toEqual([
      { id: "flaky", kind: "test", successTotal: 0, failureTotal: 0, lastLatencyMs: null },
    ]);

    startScheduler();
    await vi.advanceTimersByTimeAsync(250);
    fail = true;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(listMetrics()).toEqual([
      { id: "flaky", kind: "test", successTotal: 1, failureTotal: 1, lastLatencyMs: 250 },
    ]);
  });

  it("adds each provider's cached-data age to its counters for listStats", async () => {
    register(makeProvider("polled", "test", async () => "ok"), { pollIntervalMs: 10_000 });
    register(makeProvider("fixed", "test", async () => "ok"), undefined, undefined, { static: true });

    expect(listStats()).toEqual([
      { id: "fixed", kind: "test", successTotal: 0, failureTotal: 0, lastLatencyMs: null, ageMs: null },
      { id: "polled", kind: "test", successTotal: 0, failureTotal: 0, lastLatencyMs: null, ageMs: null },
    ]);

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(listStats().find((entry) => entry.id === "polled")).toMatchObject({ successTotal: 1, ageMs: 4_000 });
    expect(listStats().find((entry) => entry.id === "fixed")).toMatchObject({ ageMs: null });
  });
});

describe("stage-one providers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("implements a zero-network static link that never ages or schedules an interval", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const descriptor = { label: "Documentation", href: "/docs", icon: "book" };
    const provider = new LinkProvider("docs", descriptor);

    expect(await provider.health()).toEqual({ ok: true });
    expect(await provider.fetch()).toBe(descriptor);
    expect(fetchSpy).not.toHaveBeenCalled();
    registerLink("docs", descriptor);
    await vi.advanceTimersByTimeAsync(0);

    expect(interval).not.toHaveBeenCalled();
    expect(read("docs")).toMatchObject({
      kind: "link",
      freshness: { state: "static", observedAt: null, ageMs: null, ttlMs: null },
      data: descriptor,
    });
    vi.setSystemTime(new Date("2036-01-01T00:00:00.000Z"));
    expect(read("docs")?.freshness.state).toBe("static");
  });

  it("reports non-success HTTP statuses as successful fresh observations", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchStub);
    const provider = new HttpHealthProvider("probe", { url: "https://example.invalid/probe", method: "HEAD" });

    expect(await provider.fetch()).toEqual({ up: false, status: 503, latencyMs: expect.any(Number) });
    expect(fetchStub).toHaveBeenCalledWith("https://example.invalid/probe", { method: "HEAD" });
    expect(await provider.health()).toEqual({ ok: false, detail: "status 503" });

    registerHttpHealth("registered-probe", {
      url: "https://example.invalid/probe",
      timing: { pollIntervalMs: 10_000 },
    });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("registered-probe")).toMatchObject({
      freshness: { state: "fresh" },
      data: { up: false, status: 503, latencyMs: expect.any(Number) },
      error: null,
    });
  });

  it("ages an HTTP observation from fresh to stale to unreachable on reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    registerHttpHealth("aging", {
      url: "https://example.invalid/aging",
      timing: { pollIntervalMs: 10_000, ttlMs: 1_000, unreachableAfterMs: 3_000 },
    });

    expect(read("aging")?.freshness.state).toBe("pending");
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("aging")?.freshness.state).toBe("fresh");
    vi.setSystemTime(new Date("2026-01-01T00:00:01.500Z"));
    expect(read("aging")?.freshness.state).toBe("stale");
    vi.setSystemTime(new Date("2026-01-01T00:00:03.500Z"));
    expect(read("aging")).toMatchObject({ freshness: { state: "unreachable" }, data: { status: 204 } });
  });

  it("retains the last success and becomes unreachable after a transport failure", async () => {
    // Persistent rejection (not `...Once`) so the second poll fails deterministically;
    // health() is now a non-I/O cached snapshot and issues no probe fetch.
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValue(new TypeError("connection refused"));
    vi.stubGlobal("fetch", fetchStub);
    registerHttpHealth("flaky", {
      url: "https://example.invalid/flaky",
      timing: { pollIntervalMs: 1_000 },
    });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const successfulData = read("flaky")?.data;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(read("flaky")).toMatchObject({
      freshness: { state: "unreachable" },
      data: successfulData,
      error: { message: "connection refused" },
    });
  });

  it("maps transport failures to unhealthy while fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const provider = new HttpHealthProvider("down", { url: "https://example.invalid/down" });

    await expect(provider.fetch()).rejects.toThrow("network down");
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "network down" });
  });

  it("returns cached non-I/O health that never calls fetch itself", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const provider = new HttpHealthProvider("cached", { url: "https://example.invalid/cached" });

    // Before any poll: awaiting, and health() alone issues no request.
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "Awaiting first poll" });
    expect(fetchStub).not.toHaveBeenCalled();

    // A successful fetch caches up/status health; health() reads it without a new request.
    await provider.fetch();
    await expect(provider.health()).resolves.toEqual({ ok: true, detail: "status 200" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing HTTP provider from a healthy sibling and static link", async () => {
    let failingPolls = 0;
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/failing") && failingPolls++ > 0) {
        throw new Error("transport unavailable");
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);
    registerHttpHealth("failing", {
      url: "https://example.invalid/failing",
      timing: { pollIntervalMs: 1_000 },
    });
    registerHttpHealth("healthy", {
      url: "https://example.invalid/healthy",
      timing: { pollIntervalMs: 1_000 },
    });
    registerLink("link", { label: "Link", href: "/link" });

    expect(() => startScheduler()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("failing")?.freshness.state).toBe("fresh");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read("failing")?.error?.message).toBe("transport unavailable");
    expect(read("failing")?.freshness.state).toBe("unreachable");
    expect(read("healthy")?.freshness.state).toBe("fresh");
    expect(read("link")?.freshness.state).toBe("static");
  });

  it("uses POLL_DEFAULTS for an HTTP provider without timing overrides", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const interval = vi.spyOn(globalThis, "setInterval");
    registerHttpHealth("defaults", { url: "https://example.invalid/defaults" });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(interval).toHaveBeenCalledWith(expect.any(Function), POLL_DEFAULTS.pollIntervalMs);
    expect(read("defaults")?.freshness.ttlMs).toBe(POLL_DEFAULTS.ttlMs);
    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00.000Z") + POLL_DEFAULTS.unreachableAfterMs + 1));
    expect(read("defaults")?.freshness.state).toBe("unreachable");
  });
});

describe("registry failure and health contracts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("derives age-retained freshness only when explicitly selected", () => {
    const retained = { ...base, errored: true, failureFreshness: "age-retained" as const };
    // Boundaries: fresh through ttl, stale through unreachable, unreachable beyond.
    expect(deriveState({ ...retained, ageMs: 0 })).toBe("fresh");
    expect(deriveState({ ...retained, ageMs: 1_000 })).toBe("fresh");
    expect(deriveState({ ...retained, ageMs: 1_001 })).toBe("stale");
    expect(deriveState({ ...retained, ageMs: 3_000 })).toBe("stale");
    expect(deriveState({ ...retained, ageMs: 3_001 })).toBe("unreachable");
    // Default immediate-unreachable is unchanged: an error jumps straight to unreachable.
    expect(deriveState({ ...base, errored: true })).toBe("unreachable");
    // No success is always pending regardless of policy.
    expect(deriveState({ ...retained, hasSuccess: false })).toBe("pending");
  });

  it("passes one timeout-owned signal that aborts exactly at the timeout", async () => {
    let captured: AbortSignal | undefined;
    const provider: Provider<string> = {
      id: "slow",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: (context?: ProviderFetchContext) => {
        captured = context?.signal;
        return new Promise<string>(() => {});
      },
    };
    register(provider, { pollIntervalMs: 100_000, timeoutMs: 5_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(captured?.aborted).toBe(true);
    expect(read("slow")).toMatchObject({
      data: null,
      error: { message: "Provider poll timed out after 5000ms" },
      freshness: { state: "pending" },
    });
    expect(listHealth().slow).toEqual({
      kind: "test",
      ok: false,
      detail: "Provider poll timed out after 5000ms",
    });
  });

  it("skips overlapping ticks while a poll is in flight", async () => {
    let calls = 0;
    let resolveFetch: (value: string) => void = () => {};
    const provider: Provider<string> = {
      id: "gated",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          resolveFetch = resolve;
        });
      },
    };
    register(provider, { pollIntervalMs: 1_000, timeoutMs: 100_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);

    resolveFetch("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(read("gated")?.data).toBe("done");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  it("ignores a legacy fetch that settles after the timeout race", async () => {
    let resolveLate: (value: string) => void = () => {};
    const provider: Provider<string> = {
      id: "late",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    };
    register(provider, { pollIntervalMs: 100_000, timeoutMs: 5_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read("late")?.error?.message).toBe("Provider poll timed out after 5000ms");

    resolveLate("late-value");
    await vi.advanceTimersByTimeAsync(0);
    expect(read("late")?.data).toBeNull();
    expect(read("late")?.error?.message).toBe("Provider poll timed out after 5000ms");
  });

  it("swaps in one deeply frozen envelope per completed poll", async () => {
    register(makeProvider("frozen", "test", async () => ({ nested: { v: 1 } })), {
      pollIntervalMs: 10_000,
    });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    const env = read("frozen")!;
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.freshness)).toBe(true);
    expect(Object.isFrozen(env.data)).toBe(true);
    expect(Object.isFrozen((env.data as { nested: object }).nested)).toBe(true);
  });

  it("projects retained data on failure without advancing the success clock", async () => {
    let call = 0;
    const provider: Provider<{ value: string; failed: boolean }> = {
      id: "proj",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: async () => {
        if (call++ === 0) return { value: "ok", failed: false };
        throw new Error("boom");
      },
      onFetchError: (_error, retained) =>
        retained === null ? null : { value: retained.value, failed: true },
    };
    register(provider, { pollIntervalMs: 1_000, failureFreshness: "age-retained" });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const observedAt = read("proj")!.freshness.observedAt;
    expect(read("proj")).toMatchObject({ data: { value: "ok", failed: false }, error: null });

    await vi.advanceTimersByTimeAsync(1_000);
    const env = read("proj")!;
    expect(env.data).toEqual({ value: "ok", failed: true });
    expect(Object.isFrozen(env.data)).toBe(true);
    expect(env.error?.message).toBe("boom");
    expect(env.freshness.observedAt).toBe(observedAt);
    expect(env.freshness.state).toBe("fresh");
  });

  it("keeps the original outer error and pre-hook data when onFetchError throws", async () => {
    let call = 0;
    const provider: Provider<string> = {
      id: "hook-throw",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: async () => {
        if (call++ === 0) return "good";
        throw new Error("outer failure");
      },
      onFetchError: () => {
        throw new Error("hook detail leak");
      },
    };
    register(provider, { pollIntervalMs: 1_000, failureFreshness: "age-retained" });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    const env = read("hook-throw")!;
    expect(env.data).toBe("good");
    expect(env.error?.message).toBe("outer failure");
  });

  it("keeps a first failed poll pending with null data and unhealthy cached health", async () => {
    const provider: Provider<string> = {
      id: "first-fail",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: async () => {
        throw new Error("cannot read");
      },
      onFetchError: (_error, retained) => retained,
    };
    register(provider, { pollIntervalMs: 10_000, failureFreshness: "age-retained" });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(read("first-fail")).toMatchObject({
      data: null,
      error: { message: "cannot read" },
      freshness: { state: "pending" },
    });
    expect(listHealth()["first-fail"]).toEqual({
      kind: "test",
      ok: false,
      detail: "cannot read",
    });
  });

  it("isolates a rejecting health snapshot without failing a successful fetch", async () => {
    const provider: Provider<string> = {
      id: "bad-health",
      kind: "test",
      health: async () => {
        throw new Error("health probe blew up");
      },
      fetch: async () => "payload",
    };
    register(provider, { pollIntervalMs: 10_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(read("bad-health")).toMatchObject({ data: "payload", error: null });
    expect(listHealth()["bad-health"]).toEqual({
      kind: "test",
      ok: false,
      detail: "Provider health unavailable",
    });
  });

  it("exposes id-sorted, frozen, non-I/O health that updates from completed polls", async () => {
    expect(Object.keys(listHealth())).toEqual([]);
    register(makeProvider("b", "kb", async () => "b"), { pollIntervalMs: 10_000 });
    register(makeProvider("a", "ka", async () => "a"), { pollIntervalMs: 10_000 });

    const initial = listHealth();
    expect(Object.keys(initial)).toEqual(["a", "b"]);
    expect(initial.a).toEqual({ kind: "ka", ok: false, detail: "Awaiting first poll" });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.a)).toBe(true);
    expect(() => {
      (initial as Record<string, unknown>).c = {};
    }).toThrow();

    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    const polled = listHealth();
    expect(polled.a).toEqual({ kind: "ka", ok: true });
    expect(polled.b).toEqual({ kind: "kb", ok: true });
  });

  it("accepts a zero-argument fetch and still supplies a signal to context-aware providers", async () => {
    const zeroArg: Provider<string> = {
      id: "zero",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: async () => "z",
    };
    let signal: AbortSignal | undefined;
    const contextAware: Provider<string> = {
      id: "ctx",
      kind: "test",
      health: async () => ({ ok: true }),
      fetch: async (context) => {
        signal = context?.signal;
        return "c";
      },
    };
    register(zeroArg, { pollIntervalMs: 10_000 });
    register(contextAware, { pollIntervalMs: 10_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(read("zero")?.data).toBe("z");
    expect(read("ctx")?.data).toBe("c");
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

function makeProvider<T>(
  id: string,
  kind: string,
  fetch: (context?: ProviderFetchContext) => Promise<T>,
): Provider<T> {
  return { id, kind, health: async () => ({ ok: true }), fetch };
}
