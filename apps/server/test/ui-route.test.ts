import type { UiManifest } from "@deck/module-sdk";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createApp, planningRouteTable, type ProviderReader } from "../src/server/app.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const UI: UiManifest = { uiApi: 1, brand: { title: "t" }, navGroups: [], modules: [], slots: [], pages: [], disabledPages: [], nav: [], extensions: [], providers: [], findings: [] };

function deps(providers: Partial<ProviderReader> = {}) {
  return {
    config: { schemaVersion: 2, estate: { name: "t" } } as never,
    providers: {
      read: () => undefined,
      count: () => 0,
      listHealth: () => ({}),
      listProviders: () => [],
      ...providers,
    } as ProviderReader,
    logger,
  };
}

describe("GET /api/ui", () => {
  it("serves the manifest boot resolved, as given", async () => {
    const response = await createApp({ ...deps(), ui: UI }).request("/api/ui");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(UI);
  });

  it("answers 404 UI_MANIFEST_UNAVAILABLE when the app was built without one", async () => {
    const response = await createApp(deps()).request("/api/ui");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "UI_MANIFEST_UNAVAILABLE" });
  });

  it("building the app (and the planning route table) resolves nothing", () => {
    // The app no longer resolves the manifest itself: provider discovery is never consulted,
    // so route-table planning cannot be broken by the resolver or its inputs.
    const listProviders = vi.fn(() => {
      throw new Error("listProviders must not be called while building the app");
    });
    expect(() => createApp(deps({ listProviders }))).not.toThrow();
    expect(listProviders).not.toHaveBeenCalled();
    expect(planningRouteTable()).toContainEqual({ method: "GET", path: "/api/ui" });
  });
});
