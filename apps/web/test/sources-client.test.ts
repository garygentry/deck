import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOURCE_ENDPOINTS,
  fetchConfig,
  fetchFile,
  fetchManifest,
  fetchSearch,
  fetchTree,
  isSourceClientError,
  rawAssetUrl,
  type SourceClientError,
} from "../src/features/sources-docs-and-configs/client.js";

/** Stub global fetch with a single canned response (or a rejection). */
function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SOURCE_ENDPOINTS", () => {
  it("is frozen and percent-encodes ids and paths", () => {
    expect(Object.isFrozen(SOURCE_ENDPOINTS)).toBe(true);
    expect(SOURCE_ENDPOINTS.envelope("a b")).toBe("/api/providers/a%20b");
    expect(SOURCE_ENDPOINTS.tree("docs")).toBe("/api/sources/docs/tree");
    expect(SOURCE_ENDPOINTS.file("docs", "dir/x y.md")).toBe(
      "/api/sources/docs/file?path=dir%2Fx%20y.md",
    );
    expect(SOURCE_ENDPOINTS.raw("docs", "img/a b.png")).toBe(
      "/api/sources/docs/raw?path=img%2Fa%20b.png",
    );
    expect(SOURCE_ENDPOINTS.search("docs", "a&b")).toBe(
      "/api/sources/docs/search?q=a%26b",
    );
    expect(SOURCE_ENDPOINTS.config).toBe("/api/config");
  });
});

describe("rawAssetUrl", () => {
  it("mirrors SOURCE_ENDPOINTS.raw (pure string builder, no fetch)", () => {
    stubFetch(() => Promise.reject(new Error("must not be called")));
    expect(rawAssetUrl("docs", "img/logo.png")).toBe(
      SOURCE_ENDPOINTS.raw("docs", "img/logo.png"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("never-throw wrappers", () => {
  it("returns the parsed payload on 2xx", async () => {
    const envelope = {
      id: "docs",
      kind: "markdown-tree",
      freshness: { state: "fresh", observedAt: null, ageMs: null, ttlMs: null },
      data: { sourceId: "docs", kind: "markdown-tree", title: "Docs", fileCount: 2, tree: {} },
      error: null,
    };
    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(envelope), { status: 200 })),
    );
    const result = await fetchManifest("docs");
    expect(isSourceClientError(result)).toBe(false);
    expect(result).toMatchObject({ id: "docs", data: { fileCount: 2 } });
  });

  it("maps a non-2xx typed { error, code } body to a SourceClientError", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Not confined.", code: "PATH_NOT_CONFINED" }), {
          status: 400,
        }),
      ),
    );
    const result = await fetchFile("docs", "../escape");
    expect(isSourceClientError(result)).toBe(true);
    const err = result as SourceClientError;
    expect(err.message).toBe("Not confined.");
    expect(err.code).toBe("PATH_NOT_CONFINED");
  });

  it("degrades an unparseable non-2xx body to a REQUEST error (no leaked detail)", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("<html>oops</html>", { status: 500 })),
    );
    const result = await fetchTree("docs");
    expect(isSourceClientError(result)).toBe(true);
    expect((result as SourceClientError).code).toBe("REQUEST");
  });

  it("degrades a rejected fetch (offline/abort) to a REQUEST error, never throwing", async () => {
    stubFetch(() => Promise.reject(new Error("network down")));
    const result = await fetchConfig();
    expect(isSourceClientError(result)).toBe(true);
    expect((result as SourceClientError).code).toBe("REQUEST");
  });

  it("degrades a 2xx non-JSON body to a REQUEST error", async () => {
    stubFetch(() => Promise.resolve(new Response("not json", { status: 200 })));
    const result = await fetchManifest("docs");
    expect(isSourceClientError(result)).toBe(true);
    expect((result as SourceClientError).code).toBe("REQUEST");
  });
});

describe("fetchSearch", () => {
  it("short-circuits an empty/whitespace query without a round-trip", async () => {
    stubFetch(() => Promise.reject(new Error("must not be called")));
    const result = await fetchSearch("docs", "   ");
    expect(isSourceClientError(result)).toBe(false);
    expect(result).toEqual({ sourceId: "docs", matches: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches and returns the result for a non-empty query", async () => {
    const payload = { sourceId: "docs", matches: [{ path: "a.md", kind: "name" }] };
    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    );
    const result = await fetchSearch("docs", "term");
    expect(isSourceClientError(result)).toBe(false);
    expect(result).toMatchObject({ matches: [{ path: "a.md" }] });
    expect(fetch).toHaveBeenCalledWith(
      SOURCE_ENDPOINTS.search("docs", "term"),
      expect.objectContaining({ method: "GET" }),
    );
  });
});
