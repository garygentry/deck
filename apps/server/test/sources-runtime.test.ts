import { mkdirSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import type { Source } from "@deck/schema";

import { resolveSourcesRuntime } from "../src/sources/runtime.js";
import { createFakeGitSpawner } from "./util/fake-git-spawner.js";
import { makeCacheDir } from "./util/make-cache-dir.js";

// --- Fixtures & helpers ---------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A self-cleaning scratch dir (cache root or source tree). */
function scratch(): string {
  const { dir, cleanup } = makeCacheDir();
  cleanups.push(cleanup);
  return dir;
}

function source(id: string, kind: string, path: string): Source {
  return { id, kind, title: id, location: { path } };
}

function config(sources: Source[]): DeckConfig {
  return { schemaVersion: 1, estate: { name: "test" }, sources } as DeckConfig;
}

/** A no-op git spawner so no real git/network is ever touched (local-path sources). */
const noGit = () => ({ git: createFakeGitSpawner({}) });

// --- Store construction per declared source (REQ-SRC-01/05) ---------------------------

describe("resolveSourcesRuntime — store construction", () => {
  it("builds one store per supported-kind source and skips unknown kinds", () => {
    const cacheDir = scratch();
    const cfg = config([
      source("docs", "markdown-tree", scratch()),
      source("infra", "file-tree", scratch()),
      source("future", "diagram-tree", scratch()), // unsupported kind
    ]);

    const deps = resolveSourcesRuntime(cfg, { DECK_SOURCES_CACHE_DIR: cacheDir }, noGit());

    expect([...deps.stores.keys()]).toEqual(["docs", "infra"]); // "future" dropped
    expect(deps.runtime.sources.map((s) => s.id)).toEqual(["docs", "infra"]);
    expect(deps.stores.get("docs")?.kind).toBe("markdown-tree");
    expect(deps.stores.get("infra")?.kind).toBe("file-tree");
  });

  it("SourceReader.get is undefined for unknown ids; list() enumerates in insertion order", () => {
    const cacheDir = scratch();
    const cfg = config([
      source("a", "markdown-tree", scratch()),
      source("b", "file-tree", scratch()),
    ]);

    const { reader, stores } = resolveSourcesRuntime(cfg, { DECK_SOURCES_CACHE_DIR: cacheDir }, noGit());

    expect(reader.get("nope")).toBeUndefined();
    expect(reader.get("future")).toBeUndefined(); // an unsupported kind never entered stores
    expect(reader.get("a")).toBe(stores.get("a"));
    expect(reader.list().map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("an absent config.sources yields an empty stores map + empty-but-present reader", () => {
    const cacheDir = scratch();
    const deps = resolveSourcesRuntime(config([]), { DECK_SOURCES_CACHE_DIR: cacheDir }, noGit());
    expect(deps.stores.size).toBe(0);
    expect(deps.reader.list()).toEqual([]);
  });
});

// --- Cache dir default & fail-fast (REQ-FRESH-05, exit-2 posture) ----------------------

describe("resolveSourcesRuntime — cache dir", () => {
  it("DECK_SOURCES_CACHE_DIR unset falls back to a stable OS-temp subdir", () => {
    const deps = resolveSourcesRuntime(config([]), {}, noGit());
    expect(deps.runtime.cacheDir).toBe(join(tmpdir(), "deck-sources-cache"));
  });

  it("uses the configured cache dir when DECK_SOURCES_CACHE_DIR is set", () => {
    const cacheDir = scratch();
    const deps = resolveSourcesRuntime(config([]), { DECK_SOURCES_CACHE_DIR: cacheDir }, noGit());
    expect(deps.runtime.cacheDir).toBe(cacheDir);
  });

  it("fails fast (SOURCES_CONFIG_INVALID) when the cache dir cannot be created", () => {
    // Point the cache dir under a regular file so mkdir(recursive) throws ENOTDIR.
    const root = scratch();
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x");
    const bad = join(asFile, "cache");

    let thrown: unknown;
    try {
      resolveSourcesRuntime(config([]), { DECK_SOURCES_CACHE_DIR: bad }, noGit());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe("SOURCES_CONFIG_INVALID");
  });
});

// --- Orphaned cache pruning (REQ-FRESH-05) --------------------------------------------

describe("resolveSourcesRuntime — orphan cache prune", () => {
  it("prunes cache dirs with no matching source id and preserves declared ones", () => {
    const cacheDir = scratch();
    // Pre-seed the cache: one dir for a declared source, one orphan.
    mkdirSync(join(cacheDir, "kept"));
    mkdirSync(join(cacheDir, "orphan"), { recursive: true });
    writeFileSync(join(cacheDir, "orphan", "stale.md"), "old");

    resolveSourcesRuntime(
      config([source("kept", "markdown-tree", scratch())]),
      { DECK_SOURCES_CACHE_DIR: cacheDir },
      noGit(),
    );

    const remaining = readdirSync(cacheDir);
    expect(remaining).toContain("kept"); // declared source cache preserved
    expect(remaining).not.toContain("orphan"); // undeclared source cache released
  });
});

// --- readRaw — sniffed image content-type + confined bounded bytes (REQ-DOCS-05) -------

describe("SourceStore.readRaw", () => {
  it("returns an image content-type and the confined bytes for an image", async () => {
    const cacheDir = scratch();
    const treeDir = scratch();
    // A minimal but valid PNG signature followed by a few bytes.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
      0x00, 0x01, 0x02, 0x03,
    ]);
    mkdirSync(join(treeDir, "img"), { recursive: true });
    writeFileSync(join(treeDir, "img", "logo.png"), png);

    const { stores } = resolveSourcesRuntime(
      config([source("docs", "markdown-tree", treeDir)]),
      { DECK_SOURCES_CACHE_DIR: cacheDir },
      noGit(),
    );
    const store = stores.get("docs")!;

    // A read before the first acquisition is SOURCE_UNAVAILABLE (no current root yet).
    await expect(store.readRaw("img/logo.png")).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    // Acquire (local path in place) to advance the current root, then read raw.
    await store.buildManifest();
    const raw = await store.readRaw("img/logo.png");

    expect(raw.path).toBe("img/logo.png");
    expect(raw.contentType).toBe("image/png");
    expect(Buffer.from(raw.bytes).equals(png)).toBe(true);
  });

  it("a traversal path is refused by confinement before any read", async () => {
    const cacheDir = scratch();
    const treeDir = scratch();
    writeFileSync(join(treeDir, "a.md"), "alpha");

    const { stores } = resolveSourcesRuntime(
      config([source("docs", "markdown-tree", treeDir)]),
      { DECK_SOURCES_CACHE_DIR: cacheDir },
      noGit(),
    );
    const store = stores.get("docs")!;
    await store.buildManifest();

    await expect(store.readRaw("../secret")).rejects.toMatchObject({ code: "PATH_NOT_CONFINED" });
  });
});
