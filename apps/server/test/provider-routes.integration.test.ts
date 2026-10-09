import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, setProjections, stopScheduler } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";

describe("configured provider routes", () => {
  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves docker and gatus envelopes and rejects an unknown provider", async () => {
    const result = load({ arg: "test/fixtures/portal-estate" });
    expect(result.exitClass).toBe(0);
    if (result.exitClass !== 0) throw new Error("portal-estate fixture did not load");

    registerAllProviders(result.config);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const app = createApp({
      config: result.config,
      providers: { read, count: providerCount, listHealth, listProviders, setProjections },
      logger,
    });

    for (const id of ["docker", "gatus"]) {
      const response = await app.request(`/api/providers/${id}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id,
        kind: id,
        freshness: {
          state: "pending",
          observedAt: null,
          ageMs: null,
        },
        data: null,
        error: null,
      });
    }

    const missing = await app.request("/api/providers/unknown");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "No provider registered with id 'unknown'",
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("lists the registered providers at GET /api/providers so the web polls only what exists", async () => {
    const result = load({ arg: "test/fixtures/portal-estate" });
    expect(result.exitClass).toBe(0);
    if (result.exitClass !== 0) throw new Error("portal-estate fixture did not load");

    registerAllProviders(result.config);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const app = createApp({
      config: result.config,
      providers: { read, count: providerCount, listHealth, listProviders, setProjections },
      logger,
    });

    const response = await app.request("/api/providers");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: { id: string; kind: string }[] };

    // The fixture declares docker + gatus integrations; both are listed with their kinds.
    expect(body.providers).toEqual(
      expect.arrayContaining([
        { id: "docker", kind: "docker" },
        { id: "gatus", kind: "gatus" },
      ]),
    );
    // A provider the estate never declared (no snapshot source) is absent, so the
    // web never polls /api/providers/snapshot and logs no 404 for it.
    expect(body.providers.some((descriptor) => descriptor.id === "snapshot")).toBe(false);
    // Deterministic id order.
    const ids = body.providers.map((descriptor) => descriptor.id);
    expect(ids).toEqual([...ids].sort());
  });
});
