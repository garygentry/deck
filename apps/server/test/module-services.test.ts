/**
 * Services modules share through the host (`ctx.services`), and the source modules built on
 * them: a host-scoped registry whose offers appear once their module starts and are released
 * when the host stops or fails to start. Also the source-module rulings that ride on it:
 * estate source ids, the built-ins' shared env, the disabled `sources` routes and the cache
 * prune keep-set.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineServerModule, type ModuleServices, type ServerModule } from "@deck/module-sdk";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { DeckConfig } from "../src/contract/index.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { createApp } from "../src/server/app.js";
import { fileTreeModule } from "../src/providers/file-tree/module.js";
import { registerAllProviders } from "../src/providers/index.js";
import { markdownTreeModule } from "../src/providers/markdown-tree/module.js";
import { stopScheduler } from "../src/providers/registry.js";
import { SOURCES_MANIFEST, sourcesModule } from "../src/sources/module.js";
import { SOURCE_READER, type SourceReader } from "../src/sources/store.js";
import { notesSourceModule, type NotesReader } from "./fixtures/modules/notes-source/module.js";
import { makeCacheDir } from "./util/make-cache-dir.js";
import { testHost, testModule } from "./util/modules.js";
import { sourceModules, sourcesApp } from "./util/sources-module.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  stopScheduler();
});

function scratch(): string {
  const { dir, cleanup } = makeCacheDir();
  cleanups.push(cleanup);
  return dir;
}

const FEED = { name: "feeds/reader" } as const;

/** A module that captures its service handle at init, for reading offers later. */
function probe(id = "probe", uses: string[] = [FEED.name]) {
  const seen: { services?: ModuleServices; atInit?: readonly unknown[] } = {};
  const module = testModule({ id, services: { uses } }, (ctx) => {
    seen.services = ctx.services;
    seen.atInit = ctx.services.get({ name: uses[0]! });
  });
  return { module, seen };
}

const provider = (id: string, impl: unknown) =>
  testModule({ id, services: { provides: [FEED.name] } }, (ctx) => ctx.services.provide(FEED, impl));

describe("ctx.services", () => {
  it("orders a module that uses a service after every module providing it, and returns offers in init order", async () => {
    const { module: user, seen } = probe("a-user");
    const { host } = testHost([user, provider("z-two", "two"), provider("m-one", "one")]);
    expect(host.plan.map(({ id }) => id)).toEqual(["m-one", "z-two", "a-user"]);
    await host.start();
    expect(seen.atInit).toEqual(["one", "two"]);
  });

  it("needs no provider: a use with none running reads an empty list", async () => {
    const { module: user, seen } = probe();
    const { host } = testHost([user]);
    await host.start();
    expect(host.plan).toEqual([{ id: "probe", enabled: true }]);
    expect(seen.atInit).toEqual([]);
  });

  it("refuses an undeclared name on either side", async () => {
    const offering = testModule({ id: "offering" }, (ctx) => ctx.services.provide(FEED, 1));
    await expect(testHost([offering]).host.start()).rejects.toThrow(/offered service "feeds\/reader" without declaring it in services.provides/);
    const reading = testModule({ id: "reading" }, (ctx) => void ctx.services.get(FEED));
    await expect(testHost([reading]).host.start()).rejects.toThrow(/read service "feeds\/reader" without declaring it in services.uses/);
  });

  it.each([
    [{ provides: ["reader"] }, 'services.provides name "reader" must match'],
    [{ uses: ["Feeds/Reader"] }, 'services.uses name "Feeds/Reader" must match'],
    [{ provides: [FEED.name], uses: [FEED.name] }, 'service "feeds/reader" is both provided and used'],
  ])("refuses a malformed services declaration %#", (services, message) => {
    const { host } = testHost([testModule({ id: "bad", services })]);
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining(message) })]);
  });

  it("publishes a kind handler's offer once its module starts, and never when the handler fails", async () => {
    const feeds = (id: string, fail: boolean): ServerModule =>
      defineServerModule({ id, version: "1.0.0", deckApi: "^0.1", providerKinds: [{ kind: id }], services: { provides: [FEED.name] } }, () => {}, {
        kinds: {
          [id]: {
            instances: (_instances, { services }) => {
              services.provide(FEED, id);
              if (fail) throw new Error("handler broke");
              return [];
            },
          },
        },
      });
    const { module: user, seen } = probe();
    const { host } = testHost([feeds("good-feed", false), feeds("bad-feed", true), user]);
    registerAllProviders({ schemaVersion: 2, estate: { name: "e" } } as DeckConfig, host.kindHandlers());
    expect(host.findings).toEqual([expect.objectContaining({ code: "MODULE_KIND_HANDLER_FAILED", path: "/modules/bad-feed" })]);
    await host.start();
    expect(seen.atInit).toEqual(["good-feed"]);
  });

  it("releases every offer when the host stops, or when its start fails", async () => {
    const { module: user, seen } = probe();
    const { host } = testHost([provider("feed", "one"), user]);
    await host.start();
    expect(seen.services!.get(FEED)).toEqual(["one"]);
    await host.stop();
    expect(seen.services!.get(FEED)).toEqual([]);

    const { module: early, seen: earlySeen } = probe("early");
    const boom = testModule({ id: "zz-boom", dependsOn: ["early"] }, () => {
      throw new Error("boom");
    });
    const failing = testHost([provider("feed", "one"), early, boom]).host;
    await expect(failing.start()).rejects.toMatchObject({ code: "MODULE_INIT_FAILED", moduleId: "zz-boom" });
    expect(earlySeen.atInit).toEqual(["one"]);
    expect(earlySeen.services!.get(FEED)).toEqual([]);
  });
});

describe("a third-party source through the public contract", () => {
  it("is typed by the sources module's exported reader interface", () => {
    expectTypeOf<NotesReader>().toMatchTypeOf<SourceReader>();
    expectTypeOf(SOURCE_READER.name).toEqualTypeOf<string>();
  });

  it("is served by the sources module's routes beside the built-in data sources", async () => {
    const config = { schemaVersion: 2, estate: { name: "e" }, sources: [] } as unknown as DeckConfig;
    const { app } = await sourcesApp(config, {
      env: { DECK_SOURCES_CACHE_DIR: scratch() },
      modules: [...sourceModules(), notesSourceModule],
    });
    const tree = await app.request("/api/sources/notes/tree");
    expect(tree.status).toBe(200);
    expect(await tree.json()).toMatchObject({ sourceId: "notes", kind: "markdown-tree", fileCount: 1 });
    const file = await app.request("/api/m/sources/notes/file?path=index.md");
    expect(await file.json()).toMatchObject({ path: "index.md", content: expect.stringContaining("third-party") });
    expect((await app.request("/api/sources/other/tree")).status).toBe(404);
  });
});

describe("the source modules hold no state beyond their host", () => {
  function localSource(id: string, kind: string) {
    const root = scratch();
    mkdirSync(join(root, "a"), { recursive: true });
    return { id, kind, title: id, location: { path: root } };
  }

  it("a second host (markdown-tree off, no sources) serves nothing the first host had", async () => {
    const cache = scratch();
    const first = { schemaVersion: 2, estate: { name: "e" }, sources: [localSource("docs", "markdown-tree")] } as unknown as DeckConfig;
    const one = await sourcesApp(first, { env: { DECK_SOURCES_CACHE_DIR: cache }, modules: [markdownTreeModule, fileTreeModule, sourcesModule] });
    expect((await one.app.request("/api/sources/docs/tree")).status).toBe(200);
    await one.host.stop();
    stopScheduler();

    const second = { schemaVersion: 2, estate: { name: "e" }, sources: [] } as unknown as DeckConfig;
    const two = await sourcesApp(second, { env: { DECK_SOURCES_CACHE_DIR: cache }, modules: [fileTreeModule, sourcesModule] });
    const res = await two.app.request("/api/sources/docs/tree");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  it("a start that fails releases the readers its data sources offered", async () => {
    const config = { schemaVersion: 2, estate: { name: "e" }, sources: [localSource("docs", "markdown-tree")] } as unknown as DeckConfig;
    const { module: reader, seen } = probe("reader", [SOURCE_READER.name]);
    const boom = testModule({ id: "zz-boom", dependsOn: ["reader"] }, () => {
      throw new Error("boom");
    });
    const { host } = testHost([markdownTreeModule, sourcesModule, reader, boom], {
      env: { DECK_SOURCES_CACHE_DIR: scratch() },
      instancesOf: (list) => config[list] ?? [],
    });
    registerAllProviders(config, host.kindHandlers());
    await expect(host.start()).rejects.toMatchObject({ code: "MODULE_INIT_FAILED" });
    expect(seen.atInit).toHaveLength(1);
    expect(seen.services!.get(SOURCE_READER)).toEqual([]);
  });
});

describe("source ids are estate ids", () => {
  const estate = (extra: Record<string, unknown>) =>
    ({ schemaVersion: 2, estate: { name: "e" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }], ...extra }) as unknown as DeckConfig;

  it.each([
    ["an integration's provider id", { integrations: [{ id: "status", kind: "gatus", title: "Gatus", baseUrl: "http://gatus" }], sources: [{ id: "gatus", kind: "markdown-tree", title: "G", location: { path: "/srv/g" } }] }],
    ["a binding's id", { hosts: [{ name: "alpha", kind: "vm", purpose: "p", bindings: { link: { id: "docs", href: "https://a.invalid/" } } }], sources: [{ id: "docs", kind: "file-tree", title: "D", location: { path: "/srv/d" } }] }],
  ])("a source id equal to %s fails boot with PROVIDER_DUPLICATE_ID, disabling no module", (_label, extra) => {
    const { host } = testHost([...BUILTIN_MODULES], { env: { DECK_SOURCES_CACHE_DIR: scratch() } });
    expect(() => registerAllProviders(estate(extra), host.kindHandlers())).toThrow(
      expect.objectContaining({ code: "PROVIDER_DUPLICATE_ID" }),
    );
    expect(host.findings).toEqual([]);
    // Only the env-gated built-ins are off.
    expect(host.plan.filter((entry) => !entry.enabled).map((entry) => entry.id)).toEqual(["actions", "metrics"]);
  });
});

describe("the built-ins' shared cache setting", () => {
  it("cannot be claimed by another module: it is refused and the built-ins keep running", () => {
    const squatter = testModule({ id: "squatter", env: ["DECK_SOURCES_CACHE_DIR"] });
    const { host } = testHost([...BUILTIN_MODULES, squatter]);
    expect(host.findings).toEqual([
      expect.objectContaining({
        code: "MODULE_MANIFEST_INVALID",
        path: "/modules/squatter",
        message: expect.stringContaining('env name "DECK_SOURCES_CACHE_DIR" is a setting built-in modules share'),
      }),
    ]);
    for (const id of ["markdown-tree", "file-tree", "sources"]) {
      expect(host.plan).toContainEqual({ id, enabled: true });
    }
  });
});

describe("the sources routes while the module is not running", () => {
  it("answer 404 SOURCE_NOT_FOUND at the module prefix and the legacy alias", async () => {
    const config = { schemaVersion: 2, estate: { name: "e" } } as unknown as DeckConfig;
    // The real manifest, switched off: its declared fixed answers are what the host serves.
    const switchedOff = { ...sourcesModule, manifest: { ...SOURCES_MANIFEST, enabledBy: { env: "DECK_TEST_SOURCES_ON" } } };
    const off = testHost([...sourceModules().filter((module) => module !== sourcesModule), switchedOff]).host;
    await off.start();
    expect(off.plan).toContainEqual(expect.objectContaining({ id: "sources", enabled: false }));
    const offApp = createApp({
      config,
      providers: { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] },
      logger: { info() {}, warn() {}, error() {} } as never,
      modules: off,
    });
    for (const path of ["/api/sources/docs/tree", "/api/m/sources/docs/file?path=a", "/api/sources/docs/raw?path=a", "/api/sources/docs/search?q=a"]) {
      const res = await offApp.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: expect.any(String), code: "SOURCE_NOT_FOUND" });
    }
  });
});

describe("the cache prune", () => {
  it("keeps the cache of every declared source, even of a kind whose module is not running", async () => {
    const cache = scratch();
    for (const dir of ["docs", "configs", "orphan"]) mkdirSync(join(cache, dir));
    const config = {
      schemaVersion: 2,
      estate: { name: "e" },
      sources: [
        { id: "docs", kind: "markdown-tree", title: "D", location: { path: scratch() } },
        { id: "configs", kind: "file-tree", title: "C", location: { path: scratch() } },
      ],
    } as unknown as DeckConfig;
    await sourcesApp(config, { env: { DECK_SOURCES_CACHE_DIR: cache }, modules: [fileTreeModule, sourcesModule] });
    expect(readdirSync(cache).sort()).toEqual(["configs", "docs"]);
  });
});

/** A non-built-in module offering a reader that claims `sourceId` with impostor content. */
function claimant(id: string, sourceId: string, dependsOn?: string[]): ServerModule {
  const store = {
    id: sourceId,
    kind: "markdown-tree" as const,
    buildManifest: async () => ({ sourceId, kind: "markdown-tree" as const, title: `IMPOSTOR ${id}`, fileCount: 0, tree: { path: "", name: "", type: "dir" as const, children: [] } }),
    readFile: async (path: string) => ({ path, size: 8, truncated: false, binary: false, content: "IMPOSTOR" }),
    readRaw: async () => {
      throw new Error("none");
    },
    search: async () => ({ sourceId, matches: [] }),
  };
  return testModule(
    { id, services: { provides: [SOURCE_READER.name] }, ...(dependsOn === undefined ? {} : { dependsOn }) },
    (ctx) => ctx.services.provide(SOURCE_READER, { get: (requested: string) => (requested === sourceId ? store : undefined) }),
  );
}

describe("a service edge never puts a built-in in a cycle (r2 B1)", () => {
  it("refuses the non-built-in that provides sources/reader while depending on sources; sources still plans", () => {
    const { host } = testHost([...BUILTIN_MODULES, claimant("ext-reader", "x", ["sources"])]);
    expect(host.findings).toEqual([
      expect.objectContaining({
        code: "MODULE_MANIFEST_INVALID",
        path: "/modules/ext-reader",
        message: expect.stringContaining('service "sources/reader" would put built-in module "sources" in a dependency cycle'),
      }),
    ]);
    for (const id of ["sources", "markdown-tree", "file-tree"]) expect(host.plan).toContainEqual({ id, enabled: true });
  });
});

describe("whose reader answers for a source (r2 B2)", () => {
  function declaredDocs() {
    const root = scratch();
    writeFileSync(join(root, "index.md"), "# Real docs\n");
    return { schemaVersion: 2, estate: { name: "e" }, sources: [{ id: "docs", kind: "markdown-tree", title: "Docs", location: { path: root } }] } as unknown as DeckConfig;
  }

  it("a declared source of a built-in kind is answered by that built-in; another reader's claim is logged and ignored", async () => {
    const { app, lines } = await sourcesApp(declaredDocs(), {
      env: { DECK_SOURCES_CACHE_DIR: scratch() },
      modules: [...sourceModules(), claimant("aaa-docs", "docs")],
    });
    const tree = await (await app.request("/api/sources/docs/tree")).json();
    expect(tree).toMatchObject({ sourceId: "docs", title: "Docs", kind: "markdown-tree" });
    const file = await (await app.request("/api/sources/docs/file?path=index.md")).json();
    expect(file).toMatchObject({ content: "# Real docs\n" });
    const claims = lines.filter((line) => line.event === "sources.reader-claim");
    expect(claims).toEqual([expect.objectContaining({ sourceId: "docs", kind: "ignored", modules: ["aaa-docs"], level: 40 })]);
  });

  it("an undeclared id two non-built-ins serve answers 404, logging both", async () => {
    const config = { schemaVersion: 2, estate: { name: "e" }, sources: [] } as unknown as DeckConfig;
    const { app, lines } = await sourcesApp(config, {
      env: { DECK_SOURCES_CACHE_DIR: scratch() },
      modules: [...sourceModules(), claimant("one-notes", "notes"), claimant("two-notes", "notes"), claimant("solo", "solo")],
    });
    const res = await app.request("/api/sources/notes/tree");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SOURCE_NOT_FOUND" });
    expect(lines.filter((line) => line.event === "sources.reader-claim")).toEqual([
      expect.objectContaining({ sourceId: "notes", kind: "ambiguous", modules: ["one-notes", "two-notes"] }),
    ]);
    // A single non-built-in reader still serves an id no built-in serves.
    expect(await (await app.request("/api/sources/solo/tree")).json()).toMatchObject({ title: "IMPOSTOR solo" });
  });
});
