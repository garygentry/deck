/**
 * Integration tests for the four read-only source routes, driven through
 * `app.request()` on an app running the source modules (markdown-tree, file-tree, sources) as
 * boot runs them. Covers the read routes at the legacy `/api/sources` alias and the module
 * prefix, HTTP confinement rejections (400/404 with no leaked path), the unknown-id 404s, an
 * acquired-but-empty tree (fileCount 0 is success, not an error), and the read-only meta-guard
 * (every route registerSourceRoutes adds is GET).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Hono } from "hono";

import { stopScheduler } from "../src/providers/registry.js";
import { sourcesModule } from "../../../modules/sources/server/module.js";
import { RAW_ASSET_POLICY, registerSourceRoutes, type SourceRoutesDeps } from "../../../modules/sources/server/route.js";
import { ACTIVE_SVG, materializeFixture } from "./fixtures/sources-estate/materialize.js";
import { sourcesApp } from "./util/sources-module.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  stopScheduler();
  vi.restoreAllMocks();
});

/**
 * Build an app over the materialized estate; `withSources:false` runs only the `sources`
 * module, with no data source serving a store. When sources are present, each declared
 * source is primed with one tree read — the acquisition the provider scheduler performs on its
 * first poll in a live server — so the read routes observe a last-good confined root (before
 * the first acquisition every read is SOURCE_UNAVAILABLE, by design: store.ts).
 */
async function buildApp(
  withSources: boolean,
): Promise<{ app: Hono; lines: Record<string, unknown>[] }> {
  const fixture = materializeFixture();
  cleanups.push(fixture.cleanup);
  const env = { DECK_SOURCES_CACHE_DIR: fixture.cacheDir };
  const modules = withSources ? undefined : [sourcesModule];
  const { app, lines } = await sourcesApp(fixture.config, { env, ...(modules === undefined ? {} : { modules }) });
  if (withSources) {
    // Prime every store's last-good root (simulates the scheduler's first successful poll).
    await Promise.all((fixture.config.sources ?? []).map((source) => app.request(`/api/sources/${source.id}/tree`)));
  }
  return { app, lines };
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

describe("source routes — raw assets are served inert", () => {
  it("every raw image carries the sandbox policy, so an SVG cannot run script as deck", async () => {
    const { app } = await buildApp(true);
    expect(RAW_ASSET_POLICY).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    for (const [path, type] of [["img/active.svg", "image/svg+xml"], ["img/logo.png", "image/png"]] as const) {
      const res = await app.request(`/api/sources/docs/raw?path=${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(type);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      // The framing policy every response carries is a second policy beside it (both apply).
      expect(res.headers.get("Content-Security-Policy")?.split(", ")).toContain(RAW_ASSET_POLICY);
    }
    // The bytes are served as committed (the policy, not a rewrite, makes the script inert).
    const svg = await app.request("/api/sources/docs/raw?path=img/active.svg");
    expect(await svg.text()).toBe(ACTIVE_SVG);
  });
});

/** GET `path` at both route prefixes; they must agree, and the legacy answer is returned. */
async function atBoth(app: Hono, path: string): Promise<{ status: number; code?: string }> {
  const answers = await Promise.all(
    ["/api/sources", "/api/m/sources"].map(async (prefix) => {
      const res = await app.request(`${prefix}${path}`);
      const code = res.ok ? undefined : ((await res.json()) as { code: string }).code;
      return { status: res.status, ...(code === undefined ? {} : { code }) };
    }),
  );
  expect(answers[1], path).toEqual(answers[0]);
  return answers[0];
}

const q = (path: string): string => encodeURIComponent(path);

describe("source routes — reads honour include/exclude", () => {
  it("lists only the files include/exclude keep, by listed and real path, whatever the exclude's case", async () => {
    const { app } = await buildApp(true);
    const manifest = (await (await app.request("/api/sources/curated/tree")).json()) as { fileCount: number; tree: unknown };
    // index.md only: not alias.md or pub/secret.md (aliases of excluded files), notes-link.md (a
    // markdown name for a non-included file), Private/upper.md or Build/out.md (excluded by
    // `private/**` and `build/**` whatever the case).
    expect(manifest.fileCount).toBe(1);
    expect(JSON.stringify(manifest.tree)).not.toMatch(/alias|pub|secret|notes|Private|Build/);
  });

  it("a file in the tree reads; one left out by include or exclude is 404 PATH_NOT_FOUND", async () => {
    const { app } = await buildApp(true);
    expect((await atBoth(app, "/curated/file?path=index.md")).status).toBe(200);
    const missing = await (await app.request("/api/sources/curated/file?path=missing.md")).json();
    // Spelled any way, an excluded or not-included path reads like a missing file.
    for (const path of ["private/secret.md", "./private/secret.md", "private//secret.md", "Private/upper.md", "Build/out.md", "notes.txt", "notes-link.md", "img/logo.png"]) {
      expect(await atBoth(app, `/curated/file?path=${q(path)}`), path).toEqual({ status: 404, code: "PATH_NOT_FOUND" });
      expect(await (await app.request(`/api/sources/curated/file?path=${q(path)}`)).json()).toEqual(missing);
    }
  });

  it("an alias of an excluded file (a file or directory symlink) is 404 on file and raw, and absent from search", async () => {
    const { app } = await buildApp(true);
    for (const path of ["/curated/file?path=alias.md", "/curated/file?path=pub/secret.md", "/curated/raw?path=pub/photo.png"]) {
      expect(await atBoth(app, path), path).toEqual({ status: 404, code: "PATH_NOT_FOUND" });
    }
    const search = (await (await app.request("/api/sources/curated/search?q=secret")).json()) as { matches: unknown[] };
    expect(search.matches).toEqual([]);
  });

  it("raw serves an image in the tree or under an include's base, and nothing excluded or out of reach", async () => {
    const { app } = await buildApp(true);
    // include ["**/*.md"]: its base is the root, so images anywhere not excluded are served.
    for (const path of ["img/logo.png", "deep/art/pic.png"]) {
      expect((await atBoth(app, `/curated/raw?path=${q(path)}`)).status, path).toBe(200);
    }
    for (const path of ["private/photo.png", "./private/photo.png", "private//photo.png", "notes.txt"]) {
      expect(await atBoth(app, `/curated/raw?path=${q(path)}`), path).toEqual({ status: 404, code: "PATH_NOT_FOUND" });
    }
    // include ["docs/**/*.md"]: the image a doc embeds is served; one outside docs/ is not.
    expect((await atBoth(app, "/scoped/raw?path=docs/img/x.png")).status).toBe(200);
    expect(await atBoth(app, "/scoped/raw?path=other/y.png")).toEqual({ status: 404, code: "PATH_NOT_FOUND" });
  });

  it("an include reaches the directories of its brace alternatives and of its literal files", async () => {
    const { app } = await buildApp(true);
    // ["README.md", "docs/**/*.md"]: README.md reaches its own directory, the root.
    expect((await atBoth(app, "/readme/raw?path=assets/logo.png")).status).toBe(200);
    // ["{docs,guides}/**/*.md"]: docs/ and guides/, nothing else.
    expect((await atBoth(app, "/braced/raw?path=docs/x.png")).status).toBe(200);
    expect((await atBoth(app, "/braced/raw?path=guides/y.png")).status).toBe(200);
    expect(await atBoth(app, "/braced/raw?path=personal/scan.png")).toEqual({ status: 404, code: "PATH_NOT_FOUND" });
    // ["*.md"]: root-level files, so the root, so the whole source.
    expect((await atBoth(app, "/rootmd/raw?path=img/z.png")).status).toBe(200);
  });

  it("raw refuses bytes that are not the image their name promises", async () => {
    const { app } = await buildApp(true);
    // SVG text in a .tsx or .json, SVG inside HTML, and an image name that links to an SVG.
    // An .svg whose root element is not <svg> (an <svg> inside HTML) is not SVG either.
    for (const path of ["img/widget.tsx", "img/page.html", "img/data.json", "img/alias.png", "img/not-svg.svg"]) {
      expect(await atBoth(app, `/docs/raw?path=${q(path)}`), path).toEqual({ status: 400, code: "PATH_NOT_CONFINED" });
    }
  });

  it("raw serves an SVG whose root follows a byte-order mark, XML declaration, comment and doctype", async () => {
    const { app } = await buildApp(true);
    const res = await app.request("/api/sources/docs/raw?path=img/prolog.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("a traversal outside the tree still answers 400 PATH_NOT_CONFINED", async () => {
    const { app } = await buildApp(true);
    for (const route of ["file", "raw"]) {
      expect(await atBoth(app, `/curated/${route}?path=../docs/index.md`)).toEqual({ status: 400, code: "PATH_NOT_CONFINED" });
    }
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
  it("with no data source serving a store, every route returns 404 SOURCE_NOT_FOUND", async () => {
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

describe("source routes — module prefix", () => {
  it("answer at /api/m/sources exactly as at the legacy /api/sources alias", async () => {
    const { app } = await buildApp(true);
    for (const path of ["/docs/tree", "/configs/file?path=app.yaml", "/docs/search?q=nginx", "/nope/tree"]) {
      const legacy = await app.request(`/api/sources${path}`);
      const current = await app.request(`/api/m/sources${path}`);
      expect(current.status).toBe(legacy.status);
      expect(await current.json()).toEqual(await legacy.json());
    }
  });

  it("logs a failure through the module logger with the source id and failure kind only", async () => {
    const { app, lines } = await buildApp(true);
    const res = await app.request("/api/sources/docs/file?path=../../etc/passwd");
    expect(res.status).toBe(400);
    const logged = lines.find((line) => line.event === "sources.failure");
    expect(logged).toMatchObject({ module: "sources", sourceId: "docs", code: "PATH_NOT_CONFINED", msg: "source.failure" });
    expect(JSON.stringify(logged)).not.toContain("passwd");
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

describe("source routes — read-only meta-guard", () => {
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

    const deps: SourceRoutesDeps = { sources: { get: () => undefined }, logFailure: () => {} };
    registerSourceRoutes(recorder, deps);

    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === "get")).toBe(true);
    for (const verb of ["post", "put", "patch", "delete"]) {
      expect(calls.some((c) => c.method === verb)).toBe(false);
    }
    expect(calls.map((c) => c.path)).toEqual([
      "/:id/tree",
      "/:id/file",
      "/:id/raw",
      "/:id/search",
    ]);
  });
});
