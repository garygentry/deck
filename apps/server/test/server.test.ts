import { primary } from "@deck/schema/fixtures";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ProviderEnvelope, ProviderHealthEntry } from "../src/contract/index.js";
import { createApp, type ProviderReader } from "../src/server/app.js";

const envelope: ProviderEnvelope<{ up: boolean }> = {
  id: "health",
  kind: "http-health",
  freshness: {
    state: "fresh",
    observedAt: "2026-09-02T00:00:00.000Z",
    ageMs: 0,
    ttlMs: 30_000,
  },
  data: { up: true },
  error: null,
};

function harness(overrides: Partial<ProviderReader> = {}) {
  const providers: ProviderReader = {
    read: (id) => (id === envelope.id ? envelope : undefined),
    count: () => 1,
    listHealth: () => ({}),
    listProviders: () => [],
    ...overrides,
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return {
    app: createApp({
      config: primary.merged,
      providers,
      logger,
      startedAtMs: Date.now() - 100,
    }),
    logger,
  };
}

describe("HTTP app", () => {
  it("returns the injected config", async () => {
    const { app } = harness();
    const response = await app.request("/api/config");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(primary.merged);
  });

  it("returns a known provider envelope", async () => {
    const { app } = harness();
    const response = await app.request("/api/providers/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(envelope);
  });

  it("returns a typed 404 for an unknown provider", async () => {
    const { app } = harness();
    const response = await app.request("/api/providers/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "No provider registered with id 'missing'",
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("reports ok cached health for zero providers", async () => {
    const { app } = harness({ count: () => 0, listHealth: () => ({}) });
    const response = await app.request("/api/health");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", uptimeMs: expect.any(Number), providerCount: 0, providers: {}, modules: {} });
  });

  it("aggregates cached provider health and reports ok when every entry is ok", async () => {
    const providers: Record<string, ProviderHealthEntry> = {
      docker: { kind: "docker", ok: true, detail: "3 containers" },
      link: { kind: "link", ok: true },
    };
    const { app } = harness({ count: () => 2, listHealth: () => providers });
    const response = await app.request("/api/health");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", uptimeMs: expect.any(Number), providerCount: 2, providers, modules: {} });
  });

  it("reports degraded when any cached provider entry is not ok", async () => {
    const providers: Record<string, ProviderHealthEntry> = {
      awaiting: { kind: "http-health", ok: false, detail: "Awaiting first poll" },
      up: { kind: "http-health", ok: true, detail: "status 200" },
    };
    const { app } = harness({ count: () => 2, listHealth: () => providers });
    const response = await app.request("/api/health");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "degraded", providerCount: 2, providers });
  });

  it("reads cached provider health once per request without provider fetch", async () => {
    const listHealth = vi.fn(() => ({}));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { app } = harness({ count: () => 0, listHealth });

    await app.request("/api/health");
    await app.request("/api/health");

    expect(listHealth).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a generic 500 and logs the stack", async () => {
    const { app, logger } = harness({ count: () => { throw new Error("private detail"); } });
    const response = await app.request("/api/health");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Internal server error", code: "INTERNAL" });
    expect(JSON.stringify(body)).not.toContain("private detail");
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ stack: expect.stringContaining("private detail") }),
      "request failed",
    );
  });

  it("returns the generic 500 path when the injected health reader throws", async () => {
    const { app } = harness({ listHealth: () => { throw new Error("reader detail"); } });
    const response = await app.request("/api/health");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Internal server error", code: "INTERNAL" });
    expect(JSON.stringify(body)).not.toContain("reader detail");
  });

  it("returns a typed 404 for an unmatched API route", async () => {
    const { app } = harness();
    const response = await app.request("/api/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });
});
