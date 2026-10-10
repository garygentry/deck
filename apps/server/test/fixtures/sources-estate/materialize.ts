/**
 * Materialize a full local-path sources estate into a fresh temp tree and return the merged
 * DeckConfig that declares it. Local-path sources acquire in place (no git, no network), so a
 * store built over this config reads real files on disk.
 *
 * The estate declares one of each shape the route tests exercise:
 *  - `docs`    — a local-path markdown-tree source (docs + a relative image)
 *  - `configs` — a local-path file-tree source (highlightable .yaml/.json/Dockerfile)
 *  - `owned`   — an owner-bearing file-tree source (owner.host)
 *  - `empty`   — a matches-nothing source (include matches no file ⇒ fileCount 0)
 *  - `curated` — a markdown-tree source whose include/exclude leave files out of its tree, with
 *                symlinks that alias its excluded files
 *  - `scoped`  — a markdown-tree source whose include reaches only under `docs/`
 *  - `future`  — an unsupported-kind source (dropped by resolveSourcesRuntime ⇒ no store)
 *
 * `cleanup()` removes the whole temp tree; call it in an afterEach.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Source } from "@deck/schema";

import type { DeckConfig } from "../../../src/contract/index.js";

/** The materialized estate: the config, its cache root, the tree root, and a cleanup. */
export interface MaterializedFixture {
  /** The merged DeckConfig declaring the seven sources over the temp tree. */
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

/** An SVG that runs script when opened as a document: the raw route must serve it inert. */
export const ACTIVE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>document.documentElement.setAttribute("data-ran", "1")</script><rect width="8" height="8"/></svg>';

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
  const curatedDir = join(root, "curated");
  const scopedDir = join(root, "scoped");

  // markdown-tree docs source: an index linking a sibling doc, a guide, and a relative image.
  mkdirSync(join(docsDir, "img"), { recursive: true });
  writeFileSync(join(docsDir, "index.md"), "# Index\n\nSee [guide](guide.md).\n\n![logo](img/logo.png)\n");
  writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nSteps to restart nginx here.\n");
  writeFileSync(join(docsDir, "img", "logo.png"), PNG_BYTES);
  writeFileSync(join(docsDir, "img", "active.svg"), ACTIVE_SVG);
  // Files that are not images but whose bytes look like SVG, and an image name aliasing an SVG.
  writeFileSync(join(docsDir, "img", "widget.tsx"), ACTIVE_SVG);
  writeFileSync(join(docsDir, "img", "page.html"), `<!doctype html><html><body>${ACTIVE_SVG}</body></html>`);
  writeFileSync(join(docsDir, "img", "data.json"), JSON.stringify({ icon: ACTIVE_SVG }));
  symlinkSync("active.svg", join(docsDir, "img", "alias.png"));
  // An .svg whose root is HTML, and a real SVG behind a full prolog.
  writeFileSync(join(docsDir, "img", "not-svg.svg"), `<html><body>${ACTIVE_SVG}</body></html>`);
  writeFileSync(
    join(docsDir, "img", "prolog.svg"),
    `\ufeff<?xml version="1.0"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n${ACTIVE_SVG}`,
  );

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

  // curated source: include keeps markdown, exclude drops private/ (its documents and images).
  mkdirSync(join(curatedDir, "img"), { recursive: true });
  mkdirSync(join(curatedDir, "private"), { recursive: true });
  writeFileSync(join(curatedDir, "index.md"), "# Curated\n\n![logo](img/logo.png)\n");
  writeFileSync(join(curatedDir, "notes.txt"), "not markdown, so outside the include\n");
  writeFileSync(join(curatedDir, "img", "logo.png"), PNG_BYTES);
  writeFileSync(join(curatedDir, "private", "secret.md"), "# Secret\n");
  writeFileSync(join(curatedDir, "private", "photo.png"), PNG_BYTES);
  mkdirSync(join(curatedDir, "deep", "art"), { recursive: true });
  writeFileSync(join(curatedDir, "deep", "art", "pic.png"), PNG_BYTES);
  mkdirSync(join(curatedDir, "Private"), { recursive: true });
  writeFileSync(join(curatedDir, "Private", "upper.md"), "# Excluded whatever its case\n");
  // Aliases of the excluded files: a file symlink, and a directory symlink.
  symlinkSync(join("private", "secret.md"), join(curatedDir, "alias.md"));
  symlinkSync("private", join(curatedDir, "pub"));

  // scoped source: include reaches only markdown under docs/, so only docs/ images are served.
  mkdirSync(join(scopedDir, "docs", "img"), { recursive: true });
  mkdirSync(join(scopedDir, "other"), { recursive: true });
  writeFileSync(join(scopedDir, "docs", "index.md"), "# Scoped\n\n![x](img/x.png)\n");
  writeFileSync(join(scopedDir, "docs", "img", "x.png"), PNG_BYTES);
  writeFileSync(join(scopedDir, "other", "y.png"), PNG_BYTES);

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
    {
      id: "curated",
      kind: "markdown-tree",
      title: "Curated",
      location: { path: curatedDir },
      include: ["**/*.md"],
      exclude: ["private/**"],
    },
    {
      id: "scoped",
      kind: "markdown-tree",
      title: "Scoped",
      location: { path: scopedDir },
      include: ["docs/**/*.md"],
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
