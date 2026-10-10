import type { DeckConfigDocument, Source } from "@deck/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderFetchContext } from "../src/contract/index.js";
import { kindRuntimes, planModules } from "../src/modules/host.js";
import { FileTreeProvider } from "../../../modules/file-tree/server/index.js";
import { registerAllProviders } from "../src/providers/index.js";
import { MarkdownTreeProvider } from "../../../modules/markdown-tree/server/index.js";
import {
  providerCount,
  read,
  register,
  startScheduler,
  stopScheduler,
} from "../src/providers/registry.js";
import { SourceFailure } from "../../../modules/sources/server/errors.js";
import { createSourceStore, type SourceStore } from "../../../modules/sources/server/store.js";
import type { SourceKind, SourceManifest } from "../../../modules/sources/server/tree.js";

import { createFakeGitSpawner } from "../../../modules/sources/test/server/util/fake-git-spawner.js";
import { makeCacheDir } from "../../../modules/sources/test/server/util/make-cache-dir.js";
import { sourceModules } from "./util/sources-module.js";

/** A git-repo source of the given kind; the fake spawner stages the tree, so no real git runs. */
function gitSource(id: string, kind: string, repo = "https://example.test/repo.git"): Source {
  return { id, kind, title: `${id} title`, location: { repo } };
}

function context(): ProviderFetchContext {
  return { signal: new AbortController().signal };
}

/** A minimal manifest for the registry freshness tests (payload shape is proven elsewhere). */
function manifest(id: string, kind: SourceKind, fileCount = 1): SourceManifest {
  return { sourceId: id, kind, title: `${id} title`, fileCount, tree: { path: "", name: "", type: "dir", children: [] } };
}

/**
 * A pure in-memory `SourceStore` that replays queued `buildManifest` outcomes (last one
 * repeats). Used by the scheduler/freshness tests so the poll is a microtask — real
 * acquisition I/O (proven by the manifest/health tests) would not settle under fake timers.
 */
function fakeStore(id: string, kind: SourceKind, outcomes: Array<SourceManifest | Error>): SourceStore {
  let index = 0;
  const unused = async (): Promise<never> => {
    throw new Error("route read path not exercised in this test");
  };
  return {
    id,
    kind,
    async buildManifest(): Promise<SourceManifest> {
      const next = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next as SourceManifest;
    },
    readFile: unused,
    readRaw: unused,
    search: unused,
  };
}

let cache: { dir: string; cleanup(): void };

beforeEach(() => {
  cache = makeCacheDir();
});

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  vi.useRealTimers();
  cache.cleanup();
});

describe("MarkdownTreeProvider.fetch — manifest payload (REQ-SRC-03)", () => {
  it("returns a SourceManifest with POSIX-relative paths and never leaks the on-disk root", async () => {
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "# A", "docs/b.md": "# B" } });
    const src = gitSource("runbooks", "markdown-tree");
    const store = createSourceStore(src, { cacheDir: cache.dir, git });
    const provider = new MarkdownTreeProvider(src.id, src, store);

    const manifest = await provider.fetch(context());

    expect(manifest.sourceId).toBe("runbooks");
    expect(manifest.kind).toBe("markdown-tree");
    expect(manifest.title).toBe("runbooks title");
    expect(manifest.fileCount).toBe(2);
    expect(manifest.tree.path).toBe("");
    expect(manifest.tree.type).toBe("dir");

    // Every path in the tree is POSIX-relative to the root — the absolute cache path (the
    // acquired on-disk generation dir) must appear nowhere in the serialized manifest.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(cache.dir);
    expect(serialized).not.toMatch(/gen-\d/);
  });
});

describe("provider.health — cached, no live I/O (REQ-SRC-03)", () => {
  it("returns a copy of latestHealth and never reads the store on health()", async () => {
    const git = createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    const src = gitSource("md", "markdown-tree");
    const store = createSourceStore(src, { cacheDir: cache.dir, git });
    const buildSpy = vi.spyOn(store, "buildManifest");
    const provider = new MarkdownTreeProvider(src.id, src, store);

    // Before any fetch: the awaiting-first-poll seed, and health() does no I/O.
    expect(await provider.health()).toEqual({ ok: false, detail: "Awaiting first poll" });
    expect(buildSpy).not.toHaveBeenCalled();

    // A successful fetch flips health to ok; subsequent health() calls add no store reads.
    await provider.fetch(context());
    const afterFetch = buildSpy.mock.calls.length;
    const healthy = await provider.health();
    expect(healthy.ok).toBe(true);
    expect(healthy.detail).toBe("1 files");

    const second = await provider.health();
    expect(second).not.toBe(healthy); // a copy, not the cached reference
    expect(buildSpy.mock.calls.length).toBe(afterFetch); // health() performed no I/O
  });

  it("records an unhealthy, path-safe detail after a failing fetch", async () => {
    const git = createFakeGitSpawner({ exitCode: 1, stderr: ["fatal: could not read\n"] });
    const src = gitSource("md", "markdown-tree");
    const store = createSourceStore(src, { cacheDir: cache.dir, git });
    const provider = new MarkdownTreeProvider(src.id, src, store);

    await expect(provider.fetch(context())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain(cache.dir);
  });
});

describe("freshness transitions under the real registry (REQ-FRESH-01)", () => {
  it("moves pending → fresh → stale → unreachable on POLL_DEFAULTS as the clock advances", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    // Every poll succeeds; we advance the wall clock WITHOUT firing the 30s interval, so
    // freshness ages purely from the last successful observedAt.
    const src = gitSource("md", "markdown-tree");
    const store = fakeStore("md", "markdown-tree", [manifest("md", "markdown-tree")]);

    register(new MarkdownTreeProvider(src.id, src, store)); // no timing ⇒ POLL_DEFAULTS
    expect(read("md")?.freshness.state).toBe("pending");

    startScheduler();
    await vi.advanceTimersByTimeAsync(0); // initial poll completes
    expect(read("md")?.freshness.state).toBe("fresh");

    vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z")); // age 31s > ttl 30s
    expect(read("md")?.freshness.state).toBe("stale");

    vi.setSystemTime(new Date("2026-01-01T00:01:31.000Z")); // age 91s > unreachable 90s
    expect(read("md")?.freshness.state).toBe("unreachable");
  });
});

describe("retain-last-good and first-ever failure (REQ-FRESH-02/03)", () => {
  it("keeps the last-good manifest and sets error when a later poll fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const src = gitSource("md", "markdown-tree");
    const store = fakeStore("md", "markdown-tree", [
      manifest("md", "markdown-tree"), // poll 1 succeeds
      new SourceFailure("SOURCE_UNAVAILABLE"), // poll 2 fails
    ]);

    register(new MarkdownTreeProvider(src.id, src, store));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    const good = read("md");
    expect(good?.data).toMatchObject({ sourceId: "md", fileCount: 1 });
    expect(good?.error).toBeNull();
    expect(good?.freshness.state).toBe("fresh");

    await vi.advanceTimersByTimeAsync(30_000); // the 30s interval fires poll 2, which fails

    const after = read("md");
    expect(after?.data).toMatchObject({ sourceId: "md", fileCount: 1 }); // last-good retained
    expect(after?.error).not.toBeNull();
    expect(after?.freshness.state).toBe("unreachable");
  });

  it("leaves data null and sets error when the very first poll fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const src = gitSource("md", "markdown-tree");
    const store = fakeStore("md", "markdown-tree", [new SourceFailure("SOURCE_UNAVAILABLE")]);

    register(new MarkdownTreeProvider(src.id, src, store));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    const env = read("md");
    expect(env?.data).toBeNull();
    expect(env?.error).not.toBeNull();
  });
});

describe("registerAllProviders — the source data-source modules (REQ-SRC-05, SC-12)", () => {
  /** The kind handlers of the markdown-tree, file-tree and sources modules (fake git). */
  function sourceKinds() {
    const git = () => createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    const modules = sourceModules(git);
    const env = { DECK_SOURCES_CACHE_DIR: cache.dir };
    const { plan, usable } = planModules({ modules, sectionOf: () => undefined, env });
    return kindRuntimes(plan.filter((entry) => entry.enabled).map((entry) => usable.get(entry.id)!), env);
  }

  it("registers the two supported siblings; an unknown kind registers nothing", () => {
    const md = gitSource("md", "markdown-tree");
    const cfg = gitSource("cfg", "file-tree");
    const future = gitSource("future", "totally-unknown");
    const config: DeckConfigDocument = {
      schemaVersion: 2,
      estate: { name: "e", freshness: { snapshotStaleAfter: "PT6H" } },
      sources: [md, cfg, future],
    };

    expect(providerCount()).toBe(0);
    expect(() => registerAllProviders(config, sourceKinds())).not.toThrow();

    expect(providerCount()).toBe(2); // exactly the two supported kinds
    expect(read("md")).toBeDefined();
    expect(read("cfg")).toBeDefined();
    expect(read("future")).toBeUndefined(); // no module handles the kind
    expect(read("md")?.kind).toBe("markdown-tree");
    expect(read("cfg")?.kind).toBe("file-tree");
  });

  it("fails with PROVIDER_DUPLICATE_ID when two sources share an id (source ids are estate ids)", () => {
    const a = gitSource("dup", "markdown-tree");
    const b = gitSource("dup", "file-tree");
    const config: DeckConfigDocument = {
      schemaVersion: 2,
      estate: { name: "e", freshness: { snapshotStaleAfter: "PT6H" } },
      sources: [a, b],
    };

    expect(() => registerAllProviders(config, sourceKinds())).toThrow(
      expect.objectContaining({ code: "PROVIDER_DUPLICATE_ID" }),
    );
  });

  it("registers no source provider when no source module is running", () => {
    const md = gitSource("md", "markdown-tree");
    const config: DeckConfigDocument = {
      schemaVersion: 2,
      estate: { name: "e", freshness: { snapshotStaleAfter: "PT6H" } },
      sources: [md],
    };

    registerAllProviders(config, new Map());
    expect(providerCount()).toBe(0);
    expect(read("md")).toBeUndefined();
  });
});

// A file-tree provider is byte-identical to the markdown-tree one bar its kind; a focused
// smoke keeps the sibling honest without re-testing every freshness path.
describe("FileTreeProvider (REQ-SRC-02)", () => {
  it("reports kind 'file-tree' and registers as that kind", async () => {
    const git = createFakeGitSpawner({ writeFiles: { "app.yaml": "a: 1" } });
    const src = gitSource("cfg", "file-tree");
    const store = createSourceStore(src, { cacheDir: cache.dir, git });

    const provider = new FileTreeProvider(src.id, src, store);
    expect(provider.kind).toBe("file-tree");
    const manifest = await provider.fetch(context());
    expect(manifest.kind).toBe("file-tree");
    expect(manifest.fileCount).toBe(1);

    register(new FileTreeProvider("cfg2", gitSource("cfg2", "file-tree"), store));
    expect(read("cfg2")?.kind).toBe("file-tree");
  });
});
