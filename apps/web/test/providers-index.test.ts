import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRegisteredProviderIds,
  isProviderPollable,
  resetProvidersIndexCache,
} from "../src/shell/providers-index.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProvidersIndexCache();
});

describe("providers index", () => {
  it("fetches /api/providers once and memoizes the id set", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        jsonResponse({
          providers: [
            { id: "snapshot", kind: "snapshot" },
            { id: "docker", kind: "docker" },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRegisteredProviderIds();
    const second = await getRegisteredProviderIds();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/providers");
    expect([...(first ?? [])].sort()).toEqual(["docker", "snapshot"]);
    expect(second).toBe(first);
  });

  it("marks a listed provider pollable and an unlisted one not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ providers: [{ id: "snapshot", kind: "snapshot" }] })),
      ),
    );

    expect(await isProviderPollable("snapshot")).toBe(true);
    expect(await isProviderPollable("docker")).toBe(false);
  });

  it("does not cache a failed read, then memoizes a later success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValue(jsonResponse({ providers: [{ id: "docker", kind: "docker" }] }));
    vi.stubGlobal("fetch", fetchMock);

    // First read fails → null and is NOT cached, so callers poll anyway.
    expect(await getRegisteredProviderIds()).toBeNull();

    // The next read succeeds and is memoized; gating is then strict.
    const ids = await getRegisteredProviderIds();
    expect([...(ids ?? [])]).toEqual(["docker"]);
    expect(await isProviderPollable("docker")).toBe(true);
    expect(await isProviderPollable("prometheus")).toBe(false);
    // One failed fetch + one successful fetch; the memoized result serves the rest.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected fetch as index-unavailable (pollable) without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

    expect(await getRegisteredProviderIds()).toBeNull();
    expect(await isProviderPollable("snapshot")).toBe(true);
  });
});
