/**
 * Integration tests for the four read-only source routes (05-http-routes.md), driven through
 * `app.request()` (mirrors provider-routes.integration.test.ts). Covers the read routes, HTTP
 * confinement rejections (400/404 with no leaked path), the capability-off / unknown-id 404s,
 * an acquired-but-empty tree (fileCount 0 is success, not an error), and the read-only
 * meta-guard (every route registerSourceRoutes adds is GET).
 */

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Hono } from "hono";

import { createApp, type AppDeps } from "../src/server/app.js";
import { registerSourceRoutes } from "../src/sources/route.js";
import { resolveSourcesRuntime } from "../src/sources/runtime.js";
import type { SourceStore } from "../src/sources/store.js";
import { createFakeGitSpawner } from "./util/fake-git-spawner.js";
import { materializeFixture } from "./fixtures/sources-estate/materialize.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

/** A no-op git spawner — local-path sources never spawn, but this guarantees no real git. */
const noGit = () => ({ git: createFakeGitSpawner({}) });

function stubLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * Build an app over the materialized estate; `withSources:false` omits the capability. When
 * sources are present, each store is primed with one `buildManifest()` — the acquisition the
 * provider scheduler performs on its first poll in a live server — so the read routes observe a
 * last-good confined root (before the first acquisition every read is SOURCE_UNAVAILABLE, by
 * design: store.ts).
 */
async function buildApp(
  withSources: boolean,
): Promise<{ app: Hono; deps: AppDeps; logger: Logger }> {
  const fixture = materializeFixture();
  cleanups.push(fixture.cleanup);
  const logger = stubLogger();
  const base: AppDeps = {
    config: fixture.config,
    providers: { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] },
    logger,
  };
  if (!withSources) return { app: createApp(base), deps: base, logger };

  const runtime = resolveSourcesRuntime(
    fixture.config,
    { DECK_SOURCES_CACHE_DIR: fixture.cacheDir },
    noGit(),
  );
  // Prime every store's last-good root (simulates the scheduler's first successful poll).
  await Promise.all(
    [...runtime.stores.values()].map((store: SourceStore) => store.buildManifest()),
  );
  const deps: AppDeps = { ...base, sources: runtime.reader };
  return { app: createApp(deps), deps, logger };
}

describe("source routes — read surface", () => {
  it("GET /tree returns a 200 SourceManifest with only POSIX-relative paths", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/tree");
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      sourceId: string;
      kind: string;
      fileCount: number;
      tree: { path: string };
    };
    expect(manifest.sourceId).toBe("docs");
    expect(manifest.kind).toBe("markdown-tree");
    expect(manifest.fileCount).toBeGreaterThan(0);
    expect(manifest.tree.path).toBe("");
    // No absolute on-disk path leaks into the tree payload.
    expect(JSON.stringify(manifest)).not.toContain("/tmp");
  });

  it("GET /file returns a FileReadResult with content + language for a small text file", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/configs/file?path=app.yaml");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      language?: string;
      truncated: boolean;
      binary: boolean;
      content?: string;
    };
    expect(body.path).toBe("app.yaml");
    expect(body.truncated).toBe(false);
    expect(body.binary).toBe(false);
    expect(body.content).toContain("port: 8080");
    expect(body.language).toBe("yaml");
  });

  it("GET /raw serves image bytes with image content-type and X-Content-Type-Options: nosniff", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/raw?path=img/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x89); // PNG signature first byte
  });

  it("GET /raw refuses a non-image path with 400 PATH_NOT_CONFINED (no leak)", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/raw?path=index.md");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("PATH_NOT_CONFINED");
    expect(JSON.stringify(body)).not.toContain("/tmp");
  });

  it("GET /search returns a scoped, capped SourceSearchResult", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/search?q=nginx");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sourceId: string;
      matches: Array<{ path: string; kind: string }>;
    };
    expect(body.sourceId).toBe("docs");
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches.some((m) => m.path === "guide.md")).toBe(true);
  });
});

describe("source routes — missing query params", () => {
  it("missing path on /file → 400 (not 500)", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/file");
    expect(res.status).toBe(400);
  });

  it("missing path on /raw → 400 (not 500)", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/raw");
    expect(res.status).toBe(400);
  });

  it("empty/whitespace q on /search → 400 (not an unbounded scan)", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/search?q=%20%20");
    expect(res.status).toBe(400);
  });
});

describe("source routes — confinement rejections over HTTP", () => {
  it("a traversal path → 400 PATH_NOT_CONFINED, no attempted path in the body", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/file?path=../escape");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("PATH_NOT_CONFINED");
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("escape");
    expect(serialized).not.toContain("/tmp");
  });

  it("a confined-but-missing file → 404 PATH_NOT_FOUND, no path leaked", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/file?path=does-not-exist.md");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("PATH_NOT_FOUND");
    expect(JSON.stringify(body)).not.toContain("does-not-exist");
  });
});

describe("source routes — capability gate", () => {
  it("an app without deps.sources returns 404 SOURCE_NOT_FOUND for every route", async () => {
    const { app } = await buildApp(false);
    const paths = [
      "/api/sources/docs/tree",
      "/api/sources/docs/file?path=index.md",
      "/api/sources/docs/raw?path=img/logo.png",
      "/api/sources/docs/search?q=nginx",
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("SOURCE_NOT_FOUND");
    }
  });

  it("an unknown / typed-off id → 404 SOURCE_NOT_FOUND (indistinguishable from feature-off)", async () => {
    const { app } = await buildApp(true);
    for (const id of ["nope", "future"]) {
      const res = await app.request(`/api/sources/${id}/tree`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("SOURCE_NOT_FOUND");
    }
  });
});

describe("source routes — acquired-but-empty tree", () => {
  it("a matches-nothing source returns 200 with fileCount 0 (success, not error)", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/empty/tree");
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { fileCount: number; tree: { children?: unknown[] } };
    expect(manifest.fileCount).toBe(0);
    expect(manifest.tree.children ?? []).toEqual([]);
  });
});

describe("source routes — read-only meta-guard (REQ-RO-01, SC-10)", () => {
  it("registerSourceRoutes adds exactly four routes, all GET, no mutating verb", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    // A recorder that captures any HTTP verb registerSourceRoutes might call. If the module
    // ever registered a POST/PUT/PATCH/DELETE, it would show up here.
    const recorder = new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          (path: string): void => {
            calls.push({ method, path });
          },
      },
    ) as unknown as Hono;

    const { deps } = await buildApp(true);
    registerSourceRoutes(recorder, deps);

    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === "get")).toBe(true);
    for (const verb of ["post", "put", "patch", "delete"]) {
      expect(calls.some((c) => c.method === verb)).toBe(false);
    }
    expect(calls.map((c) => c.path)).toEqual([
      "/api/sources/:id/tree",
      "/api/sources/:id/file",
      "/api/sources/:id/raw",
      "/api/sources/:id/search",
    ]);
  });
});
