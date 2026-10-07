/**
 * Materialize a full local-path sources estate into a fresh temp tree and return the merged
 * DeckConfig that declares it. Local-path sources acquire in place (no git, no network), so a
 * store built over this config reads real files on disk.
 *
 * The estate declares one of each shape the route tests (008) and the e2e/smoke item (016)
 * exercise:
 *  - `docs`    — a local-path markdown-tree source (docs + a relative image)
 *  - `configs` — a local-path file-tree source (highlightable .yaml/.json/Dockerfile)
 *  - `owned`   — an owner-bearing file-tree source (owner.host)
 *  - `empty`   — a matches-nothing source (include matches no file ⇒ fileCount 0)
 *  - `future`  — an unsupported-kind source (dropped by resolveSourcesRuntime ⇒ no store)
 *
 * `cleanup()` removes the whole temp tree; call it in an afterEach.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Source } from "@deck/schema";

import type { DeckConfig } from "../../../src/contract/index.js";

/** The materialized estate: the config, its cache root, the tree root, and a cleanup. */
export interface MaterializedFixture {
  /** The merged DeckConfig declaring the five sources over the temp tree. */
  config: DeckConfig;
  /** A fresh, empty cache dir to pass as DECK_SOURCES_CACHE_DIR. */
  cacheDir: string;
  /** The temp root holding every source tree (and the cache dir). */
  root: string;
  /** Remove the whole temp tree. */
  cleanup(): void;
}

/** An 8-byte PNG signature (+ a little padding) so the raw route sniffs `image/png`. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Build the estate on disk in a fresh temp dir. Idempotent per call — each invocation gets its
 * own root, so parallel tests never collide.
 */
export function materializeFixture(): MaterializedFixture {
  const root = mkdtempSync(join(tmpdir(), "deck-sources-estate-"));
  const cacheDir = join(root, ".cache");
  mkdirSync(cacheDir, { recursive: true });

  const docsDir = join(root, "docs");
  const configsDir = join(root, "configs");
  const ownedDir = join(root, "owned");
  const emptyDir = join(root, "empty");
  const futureDir = join(root, "future");

  // markdown-tree docs source: an index linking a sibling doc, a guide, and a relative image.
  mkdirSync(join(docsDir, "img"), { recursive: true });
  writeFileSync(join(docsDir, "index.md"), "# Index\n\nSee [guide](guide.md).\n\n![logo](img/logo.png)\n");
  writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nSteps to restart nginx here.\n");
  writeFileSync(join(docsDir, "img", "logo.png"), PNG_BYTES);

  // file-tree configs source: highlightable configs of a few languages.
  mkdirSync(configsDir, { recursive: true });
  writeFileSync(join(configsDir, "app.yaml"), "server:\n  port: 8080\n");
  writeFileSync(join(configsDir, "settings.json"), '{ "debug": true }\n');
  writeFileSync(join(configsDir, "Dockerfile"), "FROM alpine\nCMD [\"true\"]\n");

  // owner-bearing file-tree source (owned by host web01).
  mkdirSync(ownedDir, { recursive: true });
  writeFileSync(join(ownedDir, "web01.conf"), "listen 80;\n");

  // matches-nothing source: a real file exists, but the include matches no path ⇒ fileCount 0.
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "present.txt"), "present but excluded by the include glob\n");

  // unsupported-kind source: resolveSourcesRuntime drops it (no store, id 404s).
  mkdirSync(futureDir, { recursive: true });
  writeFileSync(join(futureDir, "diagram.drawio"), "<mxfile/>\n");

  const sources: Source[] = [
    { id: "docs", kind: "markdown-tree", title: "Docs", location: { path: docsDir } },
    { id: "configs", kind: "file-tree", title: "Configs", location: { path: configsDir } },
    {
      id: "owned",
      kind: "file-tree",
      title: "Owned Configs",
      location: { path: ownedDir },
      owner: { host: "web01" },
    },
    {
      id: "empty",
      kind: "markdown-tree",
      title: "Empty",
      location: { path: emptyDir },
      include: ["**/*.md"], // present.txt does not match ⇒ acquired-but-empty
    },
    { id: "future", kind: "diagram-tree", title: "Future", location: { path: futureDir } },
  ];

  const config = {
    schemaVersion: 2,
    estate: { name: "Sources test estate" },
    sources,
  } as DeckConfig;

  return { config, cacheDir, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
