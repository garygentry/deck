import { mkdirSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import type { Source } from "@deck/schema";

import { registerAllProviders } from "../src/providers/index.js";
import { stopScheduler } from "../src/providers/registry.js";
import { resolveCacheDir } from "../../../modules/sources/server/runtime.js";
import { SOURCE_READER, type SourceStore } from "../../../modules/sources/server/store.js";
import { makeCacheDir } from "../../../modules/sources/test/server/util/make-cache-dir.js";
import { testHost, testModule } from "./util/modules.js";
import { sourceModules } from "./util/sources-module.js";

// --- Fixtures & helpers ---------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  stopScheduler();
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
  return { schemaVersion: 2, estate: { name: "test" }, sources } as DeckConfig;
}

/**
 * Run the source modules over `cfg` as boot does: their kind handlers build the stores while
 * providers are registered, then the modules start (the sources module creates and prunes the
 * cache). A probe module reads the `sources/reader` service the data sources offer. A no-op
 * git spawner keeps git and the network untouched.
 */
async function runSources(cfg: DeckConfig, env: Record<string, string>) {
  let readers: () => readonly { get(id: string): SourceStore | undefined }[] = () => [];
  const probe = testModule({ id: "probe", services: { uses: [SOURCE_READER.name] } }, (ctx) => {
    readers = () => ctx.services.get(SOURCE_READER);
  });
  const { host } = testHost([...sourceModules(), probe], { env, instancesOf: (list) => cfg[list] ?? [] });
  registerAllProviders(cfg, host.kindHandlers());
  await host.start();
  const get = (id: string) => readers().map((reader) => reader.get(id)).find((store) => store !== undefined);
  return { host, get, readers };
}

// --- Store construction per declared source (REQ-SRC-01/05) ---------------------------

describe("the source modules — store construction", () => {
  it("build one store per supported-kind source and skip unknown kinds", async () => {
    const cacheDir = scratch();
    const cfg = config([
      source("docs", "markdown-tree", scratch()),
      source("infra", "file-tree", scratch()),
      source("future", "diagram-tree", scratch()), // unsupported kind
    ]);

    const stores = await runSources(cfg, { DECK_SOURCES_CACHE_DIR: cacheDir });

    expect(stores.readers()).toHaveLength(2); // one reader per running data source
    expect(stores.get("future")).toBeUndefined(); // "future" dropped
    expect(stores.get("docs")?.kind).toBe("markdown-tree");
    expect(stores.get("infra")?.kind).toBe("file-tree");
  });

  it("the readers' get is undefined for unknown ids and serves each declared source", async () => {
    const cacheDir = scratch();
    const cfg = config([
      source("a", "markdown-tree", scratch()),
      source("b", "file-tree", scratch()),
    ]);

    const stores = await runSources(cfg, { DECK_SOURCES_CACHE_DIR: cacheDir });

    expect(stores.get("nope")).toBeUndefined();
    expect(stores.get("future")).toBeUndefined(); // an unsupported kind never entered stores
    expect(stores.get("a")?.id).toBe("a");
    expect(stores.get("b")?.id).toBe("b");
  });

  it("an absent config.sources yields empty-but-present readers", async () => {
    const cacheDir = scratch();
    const stores = await runSources(config([]), { DECK_SOURCES_CACHE_DIR: cacheDir });
    expect(stores.readers()).toHaveLength(2);
    expect(stores.get("docs")).toBeUndefined();
  });

});

// --- Cache dir default & fail-fast (REQ-FRESH-05, exit-2 posture) ----------------------

describe("the sources cache dir", () => {
  it("DECK_SOURCES_CACHE_DIR unset falls back to a stable OS-temp subdir", () => {
    expect(resolveCacheDir({ get: () => undefined })).toBe(join(tmpdir(), "deck-sources-cache"));
  });

  it("uses the configured cache dir when DECK_SOURCES_CACHE_DIR is set", () => {
    const cacheDir = scratch();
    const env: Record<string, string> = { DECK_SOURCES_CACHE_DIR: cacheDir };
    expect(resolveCacheDir({ get: (name) => env[name] })).toBe(cacheDir);
  });

  it("is created at init when missing", async () => {
    const cacheDir = join(scratch(), "nested", "cache");
    await runSources(config([]), { DECK_SOURCES_CACHE_DIR: cacheDir });
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("fails boot (SOURCES_CONFIG_INVALID, as the sources module's init) when it cannot be created", async () => {
    // Point the cache dir under a regular file so mkdir(recursive) throws ENOTDIR.
    const root = scratch();
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x");
    const bad = join(asFile, "cache");

    const failure = await runSources(config([]), { DECK_SOURCES_CACHE_DIR: bad }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "MODULE_INIT_FAILED", moduleId: "sources" });
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe("SOURCES_CONFIG_INVALID");
  });
});

// --- Orphaned cache pruning (REQ-FRESH-05) --------------------------------------------

describe("the sources module — orphan cache prune", () => {
  it("prunes cache dirs with no matching source id and preserves declared ones", async () => {
    const cacheDir = scratch();
    // Pre-seed the cache: one dir per declared source (one of each kind), one orphan.
    mkdirSync(join(cacheDir, "kept"));
    mkdirSync(join(cacheDir, "kept-configs"));
    mkdirSync(join(cacheDir, "orphan"), { recursive: true });
    writeFileSync(join(cacheDir, "orphan", "stale.md"), "old");

    await runSources(
      config([source("kept", "markdown-tree", scratch()), source("kept-configs", "file-tree", scratch())]),
      { DECK_SOURCES_CACHE_DIR: cacheDir },
    );

    const remaining = readdirSync(cacheDir);
    expect(remaining).toContain("kept"); // declared source cache preserved
    expect(remaining).toContain("kept-configs"); // whichever module declared it
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

    const { get } = await runSources(
      config([source("docs", "markdown-tree", treeDir)]),
      { DECK_SOURCES_CACHE_DIR: cacheDir },
    );
    const store = get("docs")!;

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

    const { get } = await runSources(
      config([source("docs", "markdown-tree", treeDir)]),
      { DECK_SOURCES_CACHE_DIR: cacheDir },
    );
    const store = get("docs")!;
    await store.buildManifest();

    await expect(store.readRaw("../secret")).rejects.toMatchObject({ code: "PATH_NOT_CONFINED" });
  });
});
