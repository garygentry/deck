/**
 * The sources capability as modules: the `markdown-tree` and `file-tree` data sources and the
 * `sources` feature. Covers what moved out of the kernel (no kernel file names a source kind,
 * the cache env, the routes or the store wiring any more), the manifests, the derived
 * `SourceKind`, the per-source credential scope, and how config sees the kinds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCES_UI } from "@deck/contract/modules/sources";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { load } from "../src/config/load.js";
import type { DeckConfig } from "../src/contract/index.js";
import { builtinComposition } from "../src/modules/config.js";
import { KERNEL_ENV_NAMES } from "../src/modules/context.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { FILE_TREE_KIND } from "../src/providers/file-tree/index.js";
import { MARKDOWN_TREE_KIND } from "../src/providers/markdown-tree/index.js";
import { stopScheduler } from "../src/providers/registry.js";
import { SOURCES_MANIFEST } from "../src/sources/module.js";
import { SOURCES_ENV } from "../src/sources/runtime.js";
import type { SourceKind } from "../src/sources/tree.js";
import { createFakeGitSpawner, type FakeGitSpawner } from "./util/fake-git-spawner.js";
import { makeCacheDir } from "./util/make-cache-dir.js";
import { sourcesApp } from "./util/sources-module.js";
import { makeConfigDir } from "./util/tmp-config.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  stopScheduler();
});

describe("the kernel no longer wires sources", () => {
  // The kernel files that named the sources capability before it was a module.
  it.each([
    "apps/server/src/server/boot.ts",
    "apps/server/src/server/app.ts",
    "apps/server/src/providers/index.ts",
    "apps/server/src/modules/context.ts",
    "apps/server/src/ui/kernel-features.ts",
    "packages/schema/src/compose/builtin.ts",
  ])("%s", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    for (const name of ["markdown-tree", "file-tree", "DECK_SOURCES_CACHE_DIR", "/api/sources", "SourceKind", "sourceStores", "SourceReader"]) {
      expect(source, `${file} names ${name}`).not.toContain(name);
    }
    expect(source, `${file} imports the sources feature`).not.toMatch(/from "\.\.\/sources\//);
  });

  it("does not reserve the cache env: the source modules share it", () => {
    expect(KERNEL_ENV_NAMES.has(SOURCES_ENV.CACHE_DIR)).toBe(false);
    const sharing = BUILTIN_MODULES.filter(({ manifest }) => manifest.sharedEnv?.includes(SOURCES_ENV.CACHE_DIR)).map(({ manifest }) => manifest.id);
    expect(sharing.sort()).toEqual(["file-tree", "markdown-tree", "sources"]);
  });
});

describe("the source modules' manifests", () => {
  it("derive SourceKind from the data-source modules' kinds", () => {
    expectTypeOf<SourceKind>().toEqualTypeOf<"markdown-tree" | "file-tree">();
    const sourceKinds = BUILTIN_MODULES.flatMap(({ manifest }) =>
      (manifest.providerKinds ?? []).filter((decl) => decl.instanceList === "sources").map((decl) => decl.kind),
    );
    expect(sourceKinds.sort()).toEqual([FILE_TREE_KIND, MARKDOWN_TREE_KIND].sort());
  });

  it("serve the browsing routes from the sources module, with /api/sources as its legacy alias", () => {
    expect(SOURCES_MANIFEST.contributes?.routes).toMatchObject({ legacyAliases: ["/api/sources"] });
    // Sources stay top-level instances (`sources[]`); the module owns no config section.
    expect(SOURCES_MANIFEST.config).toBeUndefined();
    expect(SOURCES_MANIFEST.enabledBy).toBeUndefined();
  });

  it("take the sources module's identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = SOURCES_MANIFEST;
    expect({ id, version, deckApi }).toEqual({ id: SOURCES_UI.id, version: SOURCES_UI.version, deckApi: SOURCES_UI.deckApi });
    // The shared copy holds the UI; the browsing routes stay server-side.
    expect(Object.keys(SOURCES_UI.contributes!).sort()).toEqual(["extensions", "nav", "pages"]);
    expect(Object.keys(contributes!).sort()).toEqual(["extensions", "nav", "pages", "routes"]);
    for (const key of ["pages", "nav", "extensions"] as const) expect(contributes![key]).toBe(SOURCES_UI.contributes![key]);
    expect(Object.keys(SOURCES_UI).sort()).toEqual(["contributes", "deckApi", "id", "version"]);
  });

  it("leave the data-source modules without UI: the sources web half serves the sources module alone", () => {
    const kinds = BUILTIN_MODULES.filter(({ manifest }) => (manifest.providerKinds ?? []).some((decl) => decl.instanceList === "sources"));
    expect(kinds.map(({ manifest }) => manifest.id).sort()).toEqual([FILE_TREE_KIND, MARKDOWN_TREE_KIND].sort());
    for (const { manifest } of kinds) expect(manifest.contributes, manifest.id).toBeUndefined();
  });
});

describe("a source's credential", () => {
  const SENTINEL = "s3cr3t-sentinel";

  async function cloneEnv(credentialEnv: string, env: Record<string, string>): Promise<NodeJS.ProcessEnv | undefined> {
    const cache = makeCacheDir();
    cleanups.push(cache.cleanup);
    const git: FakeGitSpawner = createFakeGitSpawner({ writeFiles: { "a.md": "A" } });
    const config = {
      schemaVersion: 2,
      estate: { name: "e" },
      sources: [{ id: "priv", kind: "markdown-tree", title: "Private", location: { repo: "https://example.test/r.git" }, credentialEnv }],
    } as DeckConfig;
    const { app } = await sourcesApp(config, { env: { DECK_SOURCES_CACHE_DIR: cache.dir, ...env }, createGit: () => git });
    expect((await app.request("/api/sources/priv/tree")).status).toBe(200);
    return git.calls.find((call) => call.isClone)?.env;
  }

  it("is read from the env the kernel gives its module for that source, not the process env", async () => {
    expect(process.env.PRIV_REPO_TOKEN).toBeUndefined();
    const env = await cloneEnv("PRIV_REPO_TOKEN", { PRIV_REPO_TOKEN: SENTINEL });
    const basic = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
  });

  it("cannot name a deployment setting the kernel reads", async () => {
    // DECK_DATA_DIR is the kernel's: no source may read it as a credential.
    const env = await cloneEnv("DECK_DATA_DIR", { DECK_DATA_DIR: SENTINEL });
    expect(env?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(Buffer.from(`x-access-token:${SENTINEL}`).toString("base64"));
  });
});

describe("config and the source kinds", () => {
  function loadLayers(overlay: Record<string, unknown>) {
    const dir = makeConfigDir({
      "00-base.yaml": {
        schemaVersion: 2,
        estate: { name: "s" },
        hosts: [{ name: "alpha", kind: "vm", purpose: "p" }],
        services: [{ name: "wiki", host: "alpha", kind: "container", purpose: "p" }],
      },
      "10-overlay.yaml": { schemaVersion: 2, ...overlay },
    });
    cleanups.push(dir.cleanup);
    return load({ arg: dir.dir, env: {} });
  }

  it("reports a binding of a source kind (formerly ignored silently), and still loads", () => {
    const result = loadLayers({ services: [{ name: "wiki", host: "alpha", bindings: { "markdown-tree": { source: "docs" } } }] });
    expect(result.exitClass).toBe(0);
    const unsupported = expect.objectContaining({ code: "PROVIDER_BINDING_UNSUPPORTED", severity: "info", path: "/services/0/bindings/markdown-tree" });
    expect(result.findings).toEqual([unsupported, unsupported]);
  });

  it("composes each kind's instance schema into sources[]", () => {
    const { composed } = builtinComposition({ sectionOf: () => undefined, env: {} });
    const defs = composed.schema.$defs as Record<string, unknown>;
    expect(defs["kind__markdown-tree"]).toBeDefined();
    expect(defs["kind__file-tree"]).toBeDefined();
    expect(JSON.stringify((composed.schema.properties as Record<string, unknown>).sources)).toContain("kind__file-tree");
    const valid = loadLayers({ sources: [{ id: "docs", kind: "file-tree", title: "Docs", location: { path: "/srv/docs" } }] });
    expect(valid.findings).toEqual([]);
    const invalid = loadLayers({ sources: [{ id: "docs", kind: "file-tree", title: "Docs", location: { path: "/srv/docs" }, depth: 3 }] });
    expect(invalid.exitClass).toBe(1);
    expect(invalid.findings).toContainEqual(expect.objectContaining({ severity: "error", path: expect.stringMatching(/^\/sources\/0/) }));
  });
});
