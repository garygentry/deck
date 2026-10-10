/**
 * The read seam for the sources capability: `SourceStore` (per-source read handle),
 * `SourceReader` (registry over all stores), and `RawReadResult` (image bytes).
 *
 * The concrete `createSourceStore` composes acquisition (02) with the confined tree walk /
 * bounded read / search (03) behind the interfaces below. Each source's data-source module
 * (`markdown-tree`, `file-tree`) builds its stores and offers a `SourceReader` over them as
 * the `sources/reader` service, which the `sources` module's routes read.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { ServiceRef } from "@deck/module-sdk";
import type { Source } from "@deck/schema";

import { acquireSource, type AcquireDeps, type GitSpawner } from "./acquire.js";
import { confinePath } from "./confine.js";
import { SourceFailure, normalizeSourceFailure } from "./errors.js";
import {
  buildManifest,
  compileReadMatchers,
  readFile as readConfinedFile,
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
  /** Read raw bytes of one confined file for image serving (REQ-DOCS-05); bounded. */
  readRaw(relPath: string, signal?: AbortSignal): Promise<RawReadResult>;
  /** Server-side name+content search over the confined tree; capped. */
  search(query: string, signal?: AbortSignal): Promise<SourceSearchResult>;
}

/** Raw bytes + content type for the image route (REQ-DOCS-05); confined, image-only. */
export interface RawReadResult {
  path: string;
  /** Sniffed content type; the route rejects anything not image/* (REQ-RO-01). */
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
// Concrete store — composes acquire (02) + confine/tree/read/search (03) (item 006).
// ---------------------------------------------------------------------------

/** Injected settings for one store, supplied by its data-source module's kind handler. */
export interface SourceStoreDeps {
  /**
   * The on-disk cache ROOT (`DECK_SOURCES_CACHE_DIR`); `acquireSource` appends the
   * per-source `<id>` subdir itself (REQ-FRESH-05). NOT the per-source dir.
   */
  readonly cacheDir: string;
  /** Git spawn seam (00 §6); Bun-backed in prod, a fake in tests (02). */
  readonly git: GitSpawner;
  /** Wall clock for generation-dir naming; injectable for deterministic tests. */
  readonly now?: () => number;
  /** Reads this source's `credentialEnv` (see `AcquireDeps.env`). */
  readonly env?: AcquireDeps["env"];
}

/**
 * Build the per-source read handle (00 §5). Composes acquisition (02) with the confined
 * tree walk / read / search (03). Holds the CURRENT confined root — advanced only when an
 * acquisition's atomic swap publishes a new complete tree (REQ-FRESH-04, enforced in 02) —
 * so the provider (buildManifest) and the routes (readFile/readRaw/search) always observe a
 * complete tree, never a half-updated one. The SAME store instance is shared by the provider
 * and the routes (one object, two consumers). Every read routes through `confinePath` (03),
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

  /** Identity + include/exclude shared by buildManifest and search (§3.1/§5, 03). */
  const baseOpts: BuildManifestOptions = {
    sourceId: src.id,
    kind: src.kind as SourceKind, // built only by the module of this kind
    title: src.title,
    ...(src.include !== undefined ? { include: src.include } : {}),
    ...(src.exclude !== undefined ? { exclude: src.exclude } : {}),
  };

  /**
   * A read by path answers only for what the source exposes: a file outside the tree reads as
   * not found, never by a direct URL. An image is read for the documents that embed it, and an
   * `include` that lists only documents (markdown files, say) leaves it out of the tree, so the
   * raw read honours `exclude` alone.
   */
  const readMatchers = compileReadMatchers(src.include, src.exclude);
  const inTree = readMatchers.inTree;
  const notExcluded = (relPath: string): boolean => !readMatchers.excluded(relPath);

  return {
    id: src.id,
    kind: src.kind as SourceKind,

    /** Provider fetch path (§3): acquire (02) then walk the freshly-published root (03). */
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

    /** Route path (05): one confined file with the 1 MiB cap + binary flag enforced in 03. */
    async readFile(relPath: string, signal?: AbortSignal): Promise<FileReadResult> {
      const root = requireRoot();
      await requireExposed(root, relPath, inTree);
      return readConfinedFile(root, relPath, signal);
    },

    /** Route path (05): raw image bytes, confined + bounded; image-only enforced at the route. */
    async readRaw(relPath: string, signal?: AbortSignal): Promise<RawReadResult> {
      const root = requireRoot();
      await requireExposed(root, relPath, notExcluded);
      return readRawConfined(root, relPath, signal);
    },

    /** Route path (05): server-side name+content search over the confined tree, capped (03). */
    async search(query: string, signal?: AbortSignal): Promise<SourceSearchResult> {
      return searchTree(requireRoot(), baseOpts, query, signal);
    },
  };
}

/**
 * Throw `PATH_NOT_FOUND` for a path the source does not expose, the answer a missing file gets,
 * so a read cannot tell an excluded file from an absent one. A path that escapes the root is
 * confined first and still answers `PATH_NOT_CONFINED`.
 */
async function requireExposed(root: string, relPath: string, exposed: (relPath: string) => boolean): Promise<void> {
  if (exposed(relPath)) return;
  await confinePath(root, relPath);
  throw new SourceFailure("PATH_NOT_FOUND", undefined, { attemptedPath: relPath });
}

// --- Raw (image) read — confined + bounded (REQ-DOCS-05, REQ-PERF-02) -----------------

/**
 * Read one confined file's raw bytes for image serving. Routes through `confinePath` (03),
 * enforces the 1 MiB cap server-side (over ⇒ READ_TOO_LARGE, never buffered), and sniffs the
 * content type from the leading magic bytes. Non-image content sniffs to
 * `application/octet-stream`; the route (05) refuses anything not `image/*` (REQ-RO-01). The
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
  // Cap FIRST — never read the body of an oversize file (REQ-PERF-02).
  if (st.size > MAX_FILE_BYTES) {
    throw new SourceFailure("READ_TOO_LARGE", undefined, { attemptedPath: relPath });
  }
  const bytes = await readBoundedBytes(abs, signal);
  return { path: relPath, contentType: sniffImageType(bytes) ?? "application/octet-stream", bytes };
}

/**
 * Stream `absPath` in READ_CHUNK_BYTES chunks up to MAX_FILE_BYTES, honoring `signal`, and
 * return the accumulated bytes. Never holds more than the cap (REQ-PERF-02); a file that grew
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

/** Decode a byte window as ASCII for magic-string comparison (no allocation of the whole file). */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Sniff a raster/vector image content type from the leading magic bytes, or `undefined` for
 * non-image content (the route then refuses it — REQ-RO-01). Covers the common in-repo image
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
  // SVG is text — look for an <svg root in the leading window (tolerating an XML prolog).
  const head = ascii(b, 0, Math.min(b.length, 256)).toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  return undefined;
}
