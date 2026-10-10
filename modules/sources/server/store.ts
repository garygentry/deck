/**
 * The read seam for the sources capability: `SourceStore` (per-source read handle),
 * `SourceReader` (registry over all stores), and `RawReadResult` (image bytes).
 *
 * The concrete `createSourceStore` composes acquisition with the confined tree walk /
 * bounded read / search behind the interfaces below. Each source's data-source module
 * (`markdown-tree`, `file-tree`) builds its stores and offers a `SourceReader` over them as
 * the `sources/reader` service, which the `sources` module's routes read.
 */

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";

import type { ServiceRef } from "@deck/module-sdk";
import type { Source } from "@deck/schema";

import { acquireSource, type AcquireDeps, type GitSpawner } from "./acquire.js";
import { confinePath } from "./confine.js";
import { SourceFailure, normalizeSourceFailure } from "./errors.js";
import {
  buildManifest,
  compileReadMatchers,
  imageTypeForPath,
  readFile as readConfinedFile,
  realRelative,
  searchTree,
  MAX_FILE_BYTES,
  READ_CHUNK_BYTES,
  type BuildManifestOptions,
  type FileReadResult,
  type SourceKind,
  type SourceManifest,
  type SourceSearchResult,
} from "./tree.js";

/**
 * A per-source read handle over its confined on-disk last-good tree. Every method routes
 * through `confine.ts` — a store can never read outside its resolved root. One store is
 * built per declared source by its kind's module and shared by the provider (which builds
 * the manifest) and the browsing routes (which read files/search).
 */
export interface SourceStore {
  /** The declaring source id. */
  readonly id: string;
  /** The provider kind (selects web surface). */
  readonly kind: SourceKind;
  /** Build the manifest from the current last-good tree; used by the provider's fetch(). */
  buildManifest(signal?: AbortSignal): Promise<SourceManifest>;
  /** Read one confined file; enforces the size cap and binary flag server-side. */
  readFile(relPath: string, signal?: AbortSignal): Promise<FileReadResult>;
  /** Read raw bytes of one confined file for image serving; bounded. */
  readRaw(relPath: string, signal?: AbortSignal): Promise<RawReadResult>;
  /** Server-side name+content search over the confined tree; capped. */
  search(query: string, signal?: AbortSignal): Promise<SourceSearchResult>;
}

/** Raw bytes + content type for the image route; confined, image-only. */
export interface RawReadResult {
  path: string;
  /** Sniffed content type; the route rejects anything not image/*. */
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A reader over source stores: the `sources/reader` service ({@link SOURCE_READER}) that a
 * source data-source module offers and the `sources` module's routes read. An id it does not
 * know answers undefined, and the routes 404.
 */
export interface SourceReader {
  /** The store for a source id, or undefined for an id this reader does not serve. */
  get(id: string): SourceStore | undefined;
}

/** The `sources/reader` service: every running source data source offers one. */
export const SOURCE_READER: ServiceRef<SourceReader> = { name: "sources/reader" };

// ---------------------------------------------------------------------------
// Concrete store — composes acquire + confine/tree/read/search.
// ---------------------------------------------------------------------------

/** Injected settings for one store, supplied by its data-source module's kind handler. */
export interface SourceStoreDeps {
  /**
   * The on-disk cache ROOT (`DECK_SOURCES_CACHE_DIR`); `acquireSource` appends the
   * per-source `<id>` subdir itself. NOT the per-source dir.
   */
  readonly cacheDir: string;
  /** Git spawn seam; Bun-backed in prod, a fake in tests. */
  readonly git: GitSpawner;
  /** Wall clock for generation-dir naming; injectable for deterministic tests. */
  readonly now?: () => number;
  /** Reads this source's `credentialEnv` (see `AcquireDeps.env`). */
  readonly env?: AcquireDeps["env"];
}

/**
 * Build the per-source read handle. Composes acquisition with the confined
 * tree walk / read / search. Holds the CURRENT confined root — advanced only when an
 * acquisition's atomic swap publishes a new complete tree —
 * so the provider (buildManifest) and the routes (readFile/readRaw/search) always observe a
 * complete tree, never a half-updated one. The SAME store instance is shared by the provider
 * and the routes (one object, two consumers). Every read routes through `confinePath`,
 * so a store can never read outside its resolved root.
 */
export function createSourceStore(src: Source, deps: SourceStoreDeps): SourceStore {
  /** null until the first successful acquisition; a browse before then → SOURCE_UNAVAILABLE. */
  let currentRoot: string | null = null;

  function requireRoot(): string {
    if (currentRoot === null) {
      throw new SourceFailure("SOURCE_UNAVAILABLE", undefined, { sourceId: src.id });
    }
    return currentRoot;
  }

  /** Identity + include/exclude shared by buildManifest and search. */
  const baseOpts: BuildManifestOptions = {
    sourceId: src.id,
    kind: src.kind as SourceKind, // built only by the module of this kind
    title: src.title,
    ...(src.include !== undefined ? { include: src.include } : {}),
    ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
  };

  /**
   * A read by path answers only for what the source exposes: a file outside the tree reads as
   * not found, never by a direct URL. The raw read also serves an image the tree leaves out
   * when it lies under an include glob's base (see `ReadMatchers.rawAllowed`).
   */
  const { inTree, rawAllowed } = compileReadMatchers(src.include, src.exclude);

  return {
    id: src.id,
    kind: src.kind as SourceKind,

    /** Provider fetch path: acquire then walk the freshly-published root. */
    async buildManifest(signal?: AbortSignal): Promise<SourceManifest> {
      const acquired = await acquireSource(src, {
        deps: {
          cacheDir: deps.cacheDir,
          git: deps.git,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
          ...(deps.env !== undefined ? { env: deps.env } : {}),
        },
        signal: signal ?? new AbortController().signal,
      });
      currentRoot = acquired.root; // adopt the atomically-published confined root
      const opts =
        acquired.ref !== undefined ? { ...baseOpts, ref: acquired.ref } : baseOpts;
      return buildManifest(acquired.root, opts, signal);
    },

    // The read methods are `async` so a pre-acquisition `requireRoot()` throw surfaces as a
    // rejected promise (never a synchronous throw) — the interface contract is promise-only.

    /** Route path: one confined file with the 1 MiB cap + binary flag enforced. */
    async readFile(relPath: string, signal?: AbortSignal): Promise<FileReadResult> {
      const root = requireRoot();
      await requireExposed(root, relPath, inTree);
      return readConfinedFile(root, relPath, signal);
    },

    /** Route path: raw image bytes, confined + bounded; image-only enforced at the route. */
    async readRaw(relPath: string, signal?: AbortSignal): Promise<RawReadResult> {
      const root = requireRoot();
      const realRel = await requireExposed(root, relPath, rawAllowed);
      const raw = await readRawConfined(root, relPath, signal);
      // The bytes must be the image both names promise: a `.tsx` or `.json` holding SVG text,
      // or a `logo.png` linked to an `.svg`, is not served as an image.
      const named = imageTypeForPath(relPath);
      return named !== undefined && named === imageTypeForPath(realRel) && named === raw.contentType
        ? raw
        : { ...raw, contentType: "application/octet-stream" };
    },

    /** Route path: server-side name+content search over the confined tree, capped. */
    async search(query: string, signal?: AbortSignal): Promise<SourceSearchResult> {
      return searchTree(requireRoot(), baseOpts, query, signal);
    },
  };
}

/**
 * Confine `relPath` and throw `PATH_NOT_FOUND` unless the source exposes it by both the path
 * requested and the real path it opens (so a symlink cannot alias an excluded file in). That is
 * the answer a missing file gets, so a read cannot tell an excluded file from an absent one. A
 * path that escapes the root still answers `PATH_NOT_CONFINED`. Returns the real path, relative
 * to the root.
 */
async function requireExposed(root: string, relPath: string, exposed: (relPath: string) => boolean): Promise<string> {
  const target = await confinePath(root, relPath);
  const realRel = realRelative(await realpath(root), target);
  if (!exposed(relPath) || !exposed(realRel)) {
    throw new SourceFailure("PATH_NOT_FOUND", undefined, { attemptedPath: relPath });
  }
  return realRel;
}

// --- Raw (image) read — confined + bounded -----------------

/**
 * Read one confined file's raw bytes for image serving. Routes through `confinePath`,
 * enforces the 1 MiB cap server-side (over ⇒ READ_TOO_LARGE, never buffered), and sniffs the
 * content type from the leading magic bytes. Non-image content sniffs to
 * `application/octet-stream`; the route refuses anything not `image/*`. The
 * bytes are held once, bounded by the cap — never the whole tree.
 */
async function readRawConfined(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<RawReadResult> {
  const abs = await confinePath(root, relPath); // PATH_NOT_CONFINED / PATH_NOT_FOUND
  let st;
  try {
    st = await stat(abs);
  } catch (cause) {
    throw normalizeSourceFailure(cause, { attemptedPath: relPath }); // ENOENT ⇒ PATH_NOT_FOUND
  }
  if (!st.isFile()) {
    throw new SourceFailure("PATH_NOT_FOUND", undefined, { attemptedPath: relPath });
  }
  // Cap FIRST — never read the body of an oversize file.
  if (st.size > MAX_FILE_BYTES) {
    throw new SourceFailure("READ_TOO_LARGE", undefined, { attemptedPath: relPath });
  }
  const bytes = await readBoundedBytes(abs, signal);
  return { path: relPath, contentType: sniffImageType(bytes) ?? "application/octet-stream", bytes };
}

/**
 * Stream `absPath` in READ_CHUNK_BYTES chunks up to MAX_FILE_BYTES, honoring `signal`, and
 * return the accumulated bytes. Never holds more than the cap; a file that grew
 * past the cap since `stat` surfaces as READ_TOO_LARGE rather than over-buffering.
 */
function readBoundedBytes(absPath: string, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absPath, { highWaterMark: READ_CHUNK_BYTES });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const onAbort = (): void => finish(new SourceFailure("ACQUIRE_TIMEOUT"));
    const finish = (err: SourceFailure | null, value?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      stream.destroy();
      if (err) rejectPromise(err);
      else resolvePromise(value as Uint8Array);
    };

    if (signal?.aborted) return finish(new SourceFailure("ACQUIRE_TIMEOUT"));
    signal?.addEventListener("abort", onAbort);

    stream.on("data", (chunk: string | Buffer) => {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > MAX_FILE_BYTES) return finish(new SourceFailure("READ_TOO_LARGE"));
      chunks.push(buf);
    });
    stream.on("end", () => finish(null, new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", (cause) => finish(normalizeSourceFailure(cause)));
  });
}

/** How far into a file the SVG sniff looks for its root element. */
const SVG_SNIFF_BYTES = 4096;

/**
 * Whether text is an SVG document: its root element is `<svg`, after only what may precede a
 * root (a byte-order mark, whitespace, an XML declaration or processing instruction, comments,
 * a doctype). An `<svg` anywhere else (inside HTML, a script, a JSON string) is not SVG.
 */
function isSvgDocument(head: string): boolean {
  let rest = head.replace(/^\u00ef\u00bb\u00bf/, "");
  for (;;) {
    rest = rest.trimStart();
    const prolog = /^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^[>]*(?:\[[\s\S]*?\])?\s*>)/i.exec(rest);
    if (prolog === null) break;
    rest = rest.slice(prolog[0].length);
  }
  return /^<svg[\s>/]/i.test(rest);
}

/** Decode a byte window as ASCII for magic-string comparison (no allocation of the whole file). */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Sniff a raster/vector image content type from the leading magic bytes, or `undefined` for
 * non-image content (the route then refuses it). Covers the common in-repo image
 * types: PNG, JPEG, GIF, WebP, BMP, ICO, and (text-based) SVG.
 */
function sniffImageType(b: Uint8Array): string | undefined {
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6) {
    const magic = ascii(b, 0, 6);
    if (magic === "GIF87a" || magic === "GIF89a") return "image/gif";
  }
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) {
    return "image/x-icon";
  }
  return isSvgDocument(ascii(b, 0, Math.min(b.length, SVG_SNIFF_BYTES))) ? "image/svg+xml" : undefined;
}
