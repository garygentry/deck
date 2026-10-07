import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchActionsEnabled } from "../src/features/governed-actions/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchActionsEnabled", () => {
  it("returns the enabled flag from GET /api/actions", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse({ enabled: true })));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchActionsEnabled()).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/actions");
  });

  it("returns false when the capability reports disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ enabled: false }))));
    expect(await fetchActionsEnabled()).toBe(false);
  });

  it("falls back to enabled=true on a non-ok response (poll anyway)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))));
    expect(await fetchActionsEnabled()).toBe(true);
  });

  it("falls back to enabled=true when the probe rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await fetchActionsEnabled()).toBe(true);
  });
});
