import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { load } from "../src/config/load.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, setProjections, stopScheduler } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";

function makeApp(fixture: string) {
  const result = load({ arg: `test/fixtures/${fixture}` });
  expect(result.exitClass).toBe(0);
  if (result.exitClass !== 0) throw new Error(`${fixture} fixture did not load`);

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
  return { app, config: result.config };
}

describe("alerts-and-health provider routes", () => {
  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves prometheus and alertmanager envelopes from the alerts-estate fixture", async () => {
    const { app } = makeApp("alerts-estate");

    for (const id of ["prometheus", "alertmanager"]) {
      const response = await app.request(`/api/providers/${id}`);
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(envelope).toMatchObject({
        id,
        kind: id,
        freshness: { state: "pending", observedAt: null, ageMs: null },
        data: null,
        error: null,
      });
      // Well-formed ProviderEnvelope: exactly the contract keys, no extras.
      expect(Object.keys(envelope).sort()).toEqual(
        ["data", "error", "freshness", "id", "kind"].sort(),
      );
      expect(Object.keys(envelope.freshness).sort()).toEqual(
        ["ageMs", "observedAt", "state", "ttlMs"].sort(),
      );
    }
  });

  it("returns 404 PROVIDER_NOT_FOUND for a kind that is not configured", async () => {
    // portal-estate declares only docker/gatus integrations — no prometheus/alertmanager.
    const { app } = makeApp("portal-estate");

    for (const id of ["prometheus", "alertmanager"]) {
      const response = await app.request(`/api/providers/${id}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: `No provider registered with id '${id}'`,
        code: "PROVIDER_NOT_FOUND",
      });
    }
  });

  it("registers exactly one provider per kind despite a second same-kind integration", () => {
    // alerts-estate declares two prometheus integrations, one alertmanager, one opaque kind.
    makeApp("alerts-estate");

    // Only the first prometheus and the alertmanager register; the second prometheus is
    // latched out by the guard and the opaque kind is never wired.
    expect(providerCount()).toBe(2);
    expect(read("prometheus")).toBeDefined();
    expect(read("alertmanager")).toBeDefined();
    // Providers register under fixed ids only, never under an integration id.
    expect(read("prometheus-secondary")).toBeUndefined();
    expect(read("opaque-tool")).toBeUndefined();
    expect(read("file-tree")).toBeUndefined();
  });

  it("exposes no non-GET route for the provider endpoints (read-only feature)", async () => {
    const { app } = makeApp("alerts-estate");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request("/api/providers/prometheus", { method });
      expect(response.status).toBe(404);
    }
  });
});
