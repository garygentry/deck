/**
 * Shared wire types and bounds for the sources capability.
 *
 * This module owns the browsing wire types that cross the server→web boundary via the
 * `contract` barrel (`SourceTreeNode`, `SourceManifest`, `FileReadResult`,
 * `SourceSearchMatch`, `SourceSearchResult`) and the memory-bounding constants
 * (`MAX_FILE_BYTES`, `BINARY_SNIFF_BYTES`, `READ_CHUNK_BYTES`, `MAX_SEARCH_MATCHES`,
 * `MAX_SNIPPET_CHARS`). Declarations + constants only — the confined tree walk, bounded
 * file read, and server-side search land in later items.
 */

import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import * as path from "node:path";

import picomatch from "picomatch";

import type { FILE_TREE_KIND } from "../../file-tree/server/index.js";
import type { MARKDOWN_TREE_KIND } from "../../markdown-tree/server/index.js";
import { confinePath } from "./confine.js";
import { SourceFailure, normalizeSourceFailure } from "./errors.js";

/**
 * One node in a source's file tree. A `dir` node carries `children`; a `file` node
 * carries `size` and `binary`. The root node has `path === ""` and `type === "dir"`.
 * Rendered read-only by the web tree view.
 */
export interface SourceTreeNode {
  /** POSIX path relative to the source root ("" for the root node). Never absolute. */
  path: string;
  /** Base name (final path segment); "" for the root node. */
  name: string;
  /** Node kind — discriminates the optional fields below. */
  type: "dir" | "file";
  /** Files only: byte size on disk. Undefined for directories. */
  size?: number;
  /** Files only: true when a NUL byte was found in the leading 8 KiB. */
  binary?: boolean;
  /** Directories only: child nodes, sorted dirs-first then by name. Undefined for files. */
  children?: SourceTreeNode[];
}

/**
 * The lightweight manifest a source publishes on each successful acquisition: the tree
 * plus enough metadata for the web to render, switch, and stamp freshness. Content,
 * images, and search hit separate on-demand routes. `data` of the envelope is this
 * manifest, or `null` before the first successful acquisition.
 */
export interface SourceManifest {
  /** The declaring `Source.id`. Also the provider id and the route path segment. */
  sourceId: string;
  /** Which provider produced it — selects the web surface (Docs vs Configs). */
  kind: SourceKind;
  /** `Source.title`, echoed so the web can label the source without a config round-trip. */
  title: string;
  /** Resolved git ref/commit for repo sources; undefined for local-path sources. */
  ref?: string;
  /** Count of renderable files after include/exclude. 0 ⇒ acquired-but-empty. */
  fileCount: number;
  /** Root tree node; its `children` describe the whole confined tree. */
  tree: SourceTreeNode;
}

/**
 * The source kinds, one per data-source module (`markdown-tree`, `file-tree`). A source's
 * `kind` selects its module, and with it the web surface.
 */
export type SourceKind = typeof MARKDOWN_TREE_KIND | typeof FILE_TREE_KIND;

/**
 * The read-only view of one file. `content` is present ONLY when the file is neither
 * over the size cap nor binary — the two suppression flags are mutually independent and
 * either one omits `content`.
 */
export interface FileReadResult {
  /** POSIX path relative to the source root, echoing the confined request path. */
  path: string;
  /** highlight.js language hint chosen by extension/name; undefined ⇒ plaintext. */
  language?: string;
  /** Byte size on disk (reported even when content is suppressed). */
  size: number;
  /** True ⇒ file exceeds MAX_FILE_BYTES; `content` omitted, web shows the notice. */
  truncated: boolean;
  /** True ⇒ NUL-sniffed binary; `content` omitted, web shows the placeholder. */
  binary: boolean;
  /** UTF-8 file body — present only when `!truncated && !binary`. */
  content?: string;
}

/** One search hit — either a name/path match or a content-line match. */
export interface SourceSearchMatch {
  /** POSIX path relative to the source root; the web links this to the file. */
  path: string;
  /** What matched: the file name/path, or a line of its content. */
  kind: "name" | "content";
  /** Content matches only: 1-based line number of the hit. */
  line?: number;
  /** Content matches only: a bounded snippet of the matching line. */
  snippet?: string;
}

/**
 * The full result set for one query against one source. `truncated` is true when the
 * match cap was hit — the search-path analogue of the file size cap.
 */
export interface SourceSearchResult {
  sourceId: string;
  matches: SourceSearchMatch[];
  /** True ⇒ the cap was reached; the web invites a narrower query. */
  truncated?: boolean;
}

/** Max renderable file size: 1 MiB. Over ⇒ FileReadResult.truncated. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Binary-sniff window: a NUL in the leading 8 KiB ⇒ binary. */
export const BINARY_SNIFF_BYTES = 8 * 1024;
/** Bounded read chunk size for streamed file/raw reads (mirrors snapshot CHUNK_BYTES). */
export const READ_CHUNK_BYTES = 64 * 1024;
/** Max search matches returned per query: 200. Over ⇒ truncated. */
export const MAX_SEARCH_MATCHES = 200;
/** Max content-match snippet length in characters (bounds the search payload). */
export const MAX_SNIPPET_CHARS = 200;

// ---------------------------------------------------------------------------
// Confined tree walk, bounded reads, and language hint.
//
// Every filesystem access below routes through `confinePath` (the choke point in
// `confine.ts`) or descends into a directory a parent already proved in-root, and each
// read is bounded — never the whole tree's content, never more than `MAX_FILE_BYTES` of a
// single file. Read-only: only realpath/stat/opendir/
// createReadStream syscalls appear here.
// ---------------------------------------------------------------------------

/** Inputs for one manifest build; supplied by the `SourceStore` that owns the root. */
export interface BuildManifestOptions {
  /** The declaring `Source.id`; echoed into the manifest and used in log/error details. */
  readonly sourceId: string;
  /** The provider kind (selects the web surface). */
  readonly kind: SourceKind;
  /** `Source.title`, echoed so the web can label without a config round-trip. */
  readonly title: string;
  /** Resolved git ref/commit for repo sources; omitted for local-path sources. */
  readonly ref?: string;
  /** `Source.include` globs; empty/absent ⇒ include-all. */
  readonly include?: readonly string[];
  /** `Source.exclude` globs; empty/absent ⇒ exclude-none. */
  readonly exclude?: readonly string[];
}

// --- Glob matchers -------------------------------------------------------

interface Matchers {
  /** True ⇒ the POSIX rel path passes the include set (always true when no includes). */
  readonly included: (posixRel: string) => boolean;
  /** True ⇒ the POSIX rel path is excluded (always false when no excludes). */
  readonly excluded: (posixRel: string) => boolean;
}

/**
 * Compile include/exclude into matchers. Patterns are matched against the POSIX path
 * RELATIVE to the source root (e.g. `docs/setup.md`), matching operator intuition and the
 * paths stored on every `SourceTreeNode`. `dot: true` so patterns can address dotfiles —
 * deck matches verbatim and does not hide dotfiles by default (curation is the operator's
 * job).
 */
function compileMatchers(include?: readonly string[], exclude?: readonly string[]): Matchers {
  const inc = include && include.length > 0 ? picomatch([...include], { dot: true }) : null;
  const exc = exclude && exclude.length > 0 ? picomatch([...exclude], { dot: true }) : null;
  return {
    included: (rel) => (inc ? inc(rel) : true),
    excluded: (rel) => (exc ? exc(rel) : false),
  };
}

/** A file is renderable iff it passes include AND is not excluded. */
function isRenderable(m: Matchers, posixRel: string): boolean {
  return m.included(posixRel) && !m.excluded(posixRel);
}

/** What a direct read of one path may return, by the source's include/exclude globs. */
export interface ReadMatchers {
  /** True ⇒ the file is in the tree: it passes include and is not excluded. */
  readonly inTree: (relPath: string) => boolean;
  /** True ⇒ the path matches an exclude glob. */
  readonly excluded: (relPath: string) => boolean;
}

/**
 * The include/exclude matchers the tree walk applies, for a read by path: a request names a
 * path as it likes (`./a.md`, `docs//a.md`), so it is first reduced to the walk's own spelling
 * (no empty or `.` segments) and only then matched, and a respelling cannot slip past a glob.
 * `..` is left in place: confinement rejects it.
 */
export function compileReadMatchers(include?: readonly string[], exclude?: readonly string[]): ReadMatchers {
  const m = compileMatchers(include, exclude);
  const walkSpelling = (relPath: string): string =>
    relPath.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
  return {
    inTree: (relPath) => isRenderable(m, walkSpelling(relPath)),
    excluded: (relPath) => m.excluded(walkSpelling(relPath)),
  };
}

// --- The confined walk --------------------------------------

/**
 * Secondary depth backstop for the tree walk. The visited-realpath set (threaded through
 * `walkDir`) is the primary guard against in-root symlink cycles; this cap is a cheap
 * defense against accidental very-deep nesting and is set well above any realistic tree.
 */
const MAX_TREE_DEPTH = 128;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SourceFailure("ACQUIRE_TIMEOUT");
}

/**
 * The classification of one directory entry. `realDir` is set ONLY for a symlinked
 * directory — it carries the confined realpath the link resolves to, so the walk can
 * detect an in-root symlink cycle (a link whose target is an already-visited directory).
 * A non-symlink directory's realpath is derived from its parent's during the walk.
 */
interface EntryClass {
  readonly kind: "file" | "dir" | "skip";
  /** Symlinked directory only: the confined realpath the link resolves to. */
  readonly realDir?: string;
}

/**
 * Classify one directory entry as `"file"`, `"dir"`, or `"skip"`. Non-symlink entries are
 * classified from the dirent directly. A symlink is re-confined through `confinePath`; on
 * `PATH_NOT_CONFINED` (or a dangling link) it is `"skip"` (excluded),
 * otherwise its realpath target is `stat`-ed to decide file vs dir. A symlinked directory
 * additionally carries its resolved realpath (`realDir`) so the walk can guard cycles.
 * Special files (socket/fifo/device) are `"skip"`.
 */
async function classifyEntry(
  root: string,
  dirent: Dirent,
  childPosix: string,
): Promise<EntryClass> {
  if (dirent.isDirectory()) return { kind: "dir" };
  if (dirent.isFile()) return { kind: "file" };
  if (dirent.isSymbolicLink()) {
    let target: string;
    try {
      target = await confinePath(root, childPosix); // escape ⇒ throws PATH_NOT_CONFINED
    } catch {
      return { kind: "skip" }; // escape (PATH_NOT_CONFINED) or dangling (PATH_NOT_FOUND) ⇒ skip
    }
    try {
      const st = await stat(target); // follows to the (in-root) real target
      if (st.isDirectory()) return { kind: "dir", realDir: target };
      return { kind: st.isFile() ? "file" : "skip" };
    } catch {
      return { kind: "skip" };
    }
  }
  return { kind: "skip" }; // socket / fifo / block / char device — not renderable
}

async function walkDir(
  root: string,
  dirAbs: string,
  dirPosixRel: string,
  dirReal: string,
  m: Matchers,
  visited: Set<string>,
  depth: number,
  signal: AbortSignal | undefined,
): Promise<SourceTreeNode[]> {
  throwIfAborted(signal);
  const nodes: SourceTreeNode[] = [];
  // Secondary guard: a pathological tree can never descend past MAX_TREE_DEPTH (the visited
  // set below is the primary cycle guard; this is a cheap backstop for accidental deep nesting).
  if (depth >= MAX_TREE_DEPTH) return nodes;
  let dir;
  try {
    dir = await opendir(dirAbs); // streamed iterator — not a whole-array read
  } catch (cause) {
    // A directory that vanished mid-walk (e.g. atomic swap raced) surfaces to the caller
    // in 3.5; a root-level failure is what buildManifest normalizes.
    throw normalizeSourceFailure(cause, { failureKind: "walk" });
  }
  for await (const dirent of dir) {
    throwIfAborted(signal);
    const name = dirent.name;
    const childPosix = dirPosixRel === "" ? name : `${dirPosixRel}/${name}`;
    const childAbs = path.join(dirAbs, name);

    // Resolve the entry's real kind, re-confining any symlink (escape ⇒ skip).
    const entry = await classifyEntry(root, dirent, childPosix);
    if (entry.kind === "skip") continue;

    if (entry.kind === "dir") {
      // The child directory's realpath: a symlinked dir carries its resolved target; a real
      // subdirectory's realpath derives from its parent's (dirReal is always canonical).
      const childReal = entry.realDir ?? path.join(dirReal, name);
      // Cycle guard: never descend into a directory realpath already on/along the
      // walk. An in-root symlink cycle (self→., latest→., sub/back→..) resolves to an
      // ancestor/already-visited realpath and is skipped rather than re-descended (no phantoms).
      if (visited.has(childReal)) continue;
      visited.add(childReal);
      const children = await walkDir(
        root,
        childAbs,
        childPosix,
        childReal,
        m,
        visited,
        depth + 1,
        signal,
      );
      // Prune: a directory survives only if it holds ≥1 renderable descendant.
      if (children.length > 0) {
        nodes.push({ path: childPosix, name, type: "dir", children });
      }
    } else {
      // kind === "file": include only when renderable after include/exclude.
      if (!isRenderable(m, childPosix)) continue;
      const meta = await fileMeta(childAbs); // bounded: stat + ≤8 KiB sniff
      nodes.push({ path: childPosix, name, type: "file", size: meta.size, binary: meta.binary });
    }
  }
  sortNodes(nodes); // deterministic dirs-first then name
  return nodes;
}

/** Sort in place: directories before files, then case-sensitive name (localeless). */
function sortNodes(nodes: SourceTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// --- Per-file metadata: size + bounded binary sniff ---------

interface FileMeta {
  size: number;
  binary: boolean;
}

/** Stat for size, then sniff ≤ BINARY_SNIFF_BYTES for a NUL byte (bounded). */
async function fileMeta(absPath: string): Promise<FileMeta> {
  const st = await stat(absPath);
  const binary = await sniffBinary(absPath);
  return { size: st.size, binary };
}

/**
 * True iff a NUL (0x00) byte appears within the leading BINARY_SNIFF_BYTES of the file.
 * Reads exactly one bounded slice and stops — never the whole file. A read error is treated
 * as "not binary" (the file's own read path surfaces any real fault); the sniff never throws.
 */
export async function sniffBinary(absPath: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const stream = createReadStream(absPath, { start: 0, end: BINARY_SNIFF_BYTES - 1 });
    let done = false;
    const settle = (v: boolean): void => {
      if (done) return;
      done = true;
      stream.destroy();
      resolvePromise(v);
    };
    stream.on("data", (chunk: string | Buffer) => {
      if ((chunk as Buffer).includes(0)) settle(true); // NUL found — stop immediately
    });
    stream.on("end", () => settle(false));
    stream.on("error", () => settle(false));
  });
}

// --- buildManifest ---------------------------------------

/**
 * Walk the confined source `root`, apply `include`/`exclude`, and build a `SourceManifest`
 * (paths + per-file `size`/`binary` metadata — NEVER file content, so a manifest is bounded
 * regardless of tree size). Directories that contain no renderable file after
 * filtering are pruned, so an empty result surfaces as `fileCount: 0`, never a
 * throw. Symlinked entries that escape the root are excluded during the walk.
 *
 * @param root Absolute path to the confined on-disk tree root (from acquisition, 02).
 * @param opts Source identity + include/exclude.
 * @param signal Optional abort signal, honored between directory reads.
 * @returns The manifest; `fileCount === 0` for an acquired-but-empty tree.
 * @throws {SourceFailure} `SOURCE_UNAVAILABLE`/`INTERNAL` if the root itself is unreadable.
 */
export async function buildManifest(
  root: string,
  opts: BuildManifestOptions,
  signal?: AbortSignal,
): Promise<SourceManifest> {
  const matchers = compileMatchers(opts.include, opts.exclude);
  let children: SourceTreeNode[];
  try {
    // Confine the root once (collapses a symlinked root; "" ⇒ the root itself). Seed the
    // visited-realpath set with the root so a self-link (self→.) is caught on the first hop.
    const rootAbs = await confinePath(root, "");
    const visited = new Set<string>([rootAbs]);
    children = await walkDir(root, rootAbs, "", rootAbs, matchers, visited, 0, signal);
  } catch (cause) {
    if (cause instanceof SourceFailure) throw cause;
    throw normalizeSourceFailure(cause, { sourceId: opts.sourceId, failureKind: "walk" });
  }
  const tree: SourceTreeNode = { path: "", name: "", type: "dir", children };
  const fileCount = countFiles(tree); // 0 ⇒ acquired-but-empty
  return {
    sourceId: opts.sourceId,
    kind: opts.kind,
    title: opts.title,
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    fileCount,
    tree,
  };
}

/** Count `file` nodes across the tree. `0` is the acquired-but-empty signal. */
function countFiles(node: SourceTreeNode): number {
  if (node.type === "file") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countFiles(c), 0);
}

// --- Confined bounded file read --------------------------

/**
 * Read one confined file as the read-only `FileReadResult`. Enforces, server-side:
 *   - confinement (via `confinePath`) — throws PATH_NOT_CONFINED / PATH_NOT_FOUND;
 *   - the 1 MiB cap — a file over `MAX_FILE_BYTES` returns `{ truncated: true }` with NO
 *     content read (bounded);
 *   - the binary flag — a NUL in the leading `BINARY_SNIFF_BYTES` returns `{ binary: true }`
 *     with NO content;
 *   - otherwise `content` is the UTF-8 body and `language` is the highlight.js hint.
 * `truncated` and `binary` are independent; either one omits `content`.
 */
export async function readFile(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<FileReadResult> {
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
  const language = languageForPath(relPath);
  const size = st.size;

  // Cap FIRST — never read the body of an oversize file.
  if (size > MAX_FILE_BYTES) {
    return { path: relPath, language, size, truncated: true, binary: false };
  }
  // Binary FIRST-CHUNK sniff, then bounded whole-body read (size ≤ cap).
  const read = await readBoundedText(abs, signal);
  if (read.binary) {
    return { path: relPath, language, size, truncated: false, binary: true };
  }
  return { path: relPath, language, size, truncated: false, binary: false, content: read.text };
}

interface BoundedRead {
  binary: boolean;
  text: string;
}

/**
 * Stream `absPath` in READ_CHUNK_BYTES chunks up to MAX_FILE_BYTES, honoring `signal`.
 * On the first chunk, scan the leading BINARY_SNIFF_BYTES for a NUL — if present, stop and
 * return `{ binary: true }` without accumulating the body. Otherwise accumulate and return
 * the UTF-8 text. Never holds more than MAX_FILE_BYTES of buffers; a file that
 * grew past the cap since `stat` is surfaced as READ_TOO_LARGE rather than over-buffered.
 */
function readBoundedText(absPath: string, signal?: AbortSignal): Promise<BoundedRead> {
  return new Promise<BoundedRead>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absPath, { highWaterMark: READ_CHUNK_BYTES });
    const chunks: Buffer[] = [];
    let total = 0;
    let sniffed = false;
    let settled = false;

    const onAbort = (): void => finish(new SourceFailure("ACQUIRE_TIMEOUT"));
    const finish = (err: SourceFailure | null, value?: BoundedRead): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      stream.destroy();
      if (err) rejectPromise(err);
      else resolvePromise(value as BoundedRead);
    };

    if (signal?.aborted) return finish(new SourceFailure("ACQUIRE_TIMEOUT"));
    signal?.addEventListener("abort", onAbort);

    stream.on("data", (chunk: string | Buffer) => {
      const buf = chunk as Buffer;
      if (!sniffed) {
        sniffed = true;
        const window = buf.subarray(0, BINARY_SNIFF_BYTES);
        if (window.includes(0)) return finish(null, { binary: true, text: "" });
      }
      total += buf.byteLength;
      if (total > MAX_FILE_BYTES) {
        // Defensive: file grew past the cap since `stat`. Surface as too-large, not a crash.
        return finish(new SourceFailure("READ_TOO_LARGE"));
      }
      chunks.push(buf);
    });
    stream.on("end", () =>
      finish(null, { binary: false, text: Buffer.concat(chunks).toString("utf8") }),
    );
    stream.on("error", (cause) => finish(normalizeSourceFailure(cause)));
  });
}

// --- Server-side confined search -------------------------
//
// Search runs server-side over the confined tree: it reuses the confined
// walk (name/path matching + include/exclude) and the same bounded reader as `readFile`
// (content matching, text files under the cap only). Binary and over-`MAX_FILE_BYTES` files
// are name-matched ONLY — their content is never scanned (bounded). The whole
// result is capped at `MAX_SEARCH_MATCHES` so a broad query can never return an unbounded
// response (the search-path analogue of the file size cap).
// ---------------------------------------------------------------------------

/**
 * Max content-line matches recorded per file before moving on. Keeps a single dense file
 * from monopolizing the global cap ("at most a few matches per file"); the file still counts
 * once for a name/path match. The global `MAX_SEARCH_MATCHES` cap remains authoritative.
 */
const MAX_MATCHES_PER_FILE = 5;

/**
 * Search one confined source tree for `query`, returning capped name + content matches.
 * Reuses the confined walk (name/path matching + include/exclude, so a path excluded from the
 * manifest is never returned) and the bounded reader (content matching over text files under
 * the cap only — binary and over-cap files are name-matched only, their content never
 * scanned). Case-insensitive substring match (V1). A single unreadable file is swallowed —
 * one bad file never fails the whole search.
 *
 * @param root   Confined on-disk source root.
 * @param opts   Same include/exclude + identity used by `buildManifest`.
 * @param query  Raw query string (already URL-decoded by the route). Empty ⇒ no matches.
 * @param signal Optional abort signal, honored between files.
 * @returns `{ sourceId, matches, truncated }` — `truncated: true` iff the cap was hit.
 * @throws {SourceFailure} `SOURCE_UNAVAILABLE`/`INTERNAL` if the root itself is unreadable.
 */
export async function searchTree(
  root: string,
  opts: BuildManifestOptions,
  query: string,
  signal?: AbortSignal,
): Promise<SourceSearchResult> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { sourceId: opts.sourceId, matches: [] };

  // Reuse the manifest walk to enumerate renderable, in-root files (confinement + globs).
  const manifest = await buildManifest(root, opts, signal);
  const files = collectFiles(manifest.tree); // flat list of file nodes (metadata only)

  const matches: SourceSearchMatch[] = [];
  /** Push a match; return false once the global cap is reached (caller stops). */
  const pushCapped = (m: SourceSearchMatch): boolean => {
    matches.push(m);
    return matches.length < MAX_SEARCH_MATCHES;
  };

  for (const file of files) {
    throwIfAborted(signal);
    // Name/path match (also covers binary + over-cap files).
    if (file.path.toLowerCase().includes(needle)) {
      if (!pushCapped({ path: file.path, kind: "name" })) {
        return { sourceId: opts.sourceId, matches, truncated: true };
      }
    }
    // Content match only for text files under the cap (never scan binary/over-cap).
    if (file.binary || (file.size ?? 0) > MAX_FILE_BYTES) continue;
    const capReached = await scanContent(root, file.path, needle, pushCapped, signal);
    if (capReached) return { sourceId: opts.sourceId, matches, truncated: true };
  }
  return { sourceId: opts.sourceId, matches };
}

/** Flatten a tree to its file nodes (metadata only — no content held). */
function collectFiles(node: SourceTreeNode): SourceTreeNode[] {
  if (node.type === "file") return [node];
  return (node.children ?? []).flatMap(collectFiles);
}

/**
 * Scan one text file's content for `needle`, pushing content matches through `pushCapped`.
 * Records at most `MAX_MATCHES_PER_FILE` content hits for this file. Returns true iff the
 * GLOBAL cap was reached (caller stops entirely). A per-file read fault is swallowed — one
 * bad file never fails the whole search; a file that sniffs binary on this pass
 * is skipped (its content is never scanned).
 */
async function scanContent(
  root: string,
  relPath: string,
  needle: string,
  pushCapped: (m: SourceSearchMatch) => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  let read: BoundedRead;
  try {
    const abs = await confinePath(root, relPath);
    read = await readBoundedText(abs, signal);
  } catch {
    return false; // unreadable / vanished / (re)confinement fault ⇒ skip this file
  }
  if (read.binary) return false; // sniffed binary on this pass ⇒ no content scan
  const lines = read.text.split("\n");
  let perFile = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes(needle)) {
      const more = pushCapped({ path: relPath, kind: "content", line: i + 1, snippet: makeSnippet(line) });
      if (!more) return true; // global cap reached
      if (++perFile >= MAX_MATCHES_PER_FILE) return false; // enough from this file
    }
  }
  return false;
}

/**
 * Trim a matching line to a bounded snippet whose total length is ≤ MAX_SNIPPET_CHARS
 * (the trailing ellipsis is counted, so an over-long line yields exactly MAX_SNIPPET_CHARS).
 */
function makeSnippet(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_SNIPPET_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

// --- Language hint by extension ------------------------------------------

/**
 * Map a file path to a highlight.js language token by extension/basename, or `undefined`
 * for an unknown type (⇒ plaintext). Lowercased; matches common config/doc
 * types. This is a hint only — the web may fall back to plaintext if the language is not
 * registered in its highlight.js bundle.
 */
export function languageForPath(relPath: string): string | undefined {
  const base = path.posix.basename(relPath).toLowerCase();
  const ext = path.posix.extname(base).replace(/^\./, "");
  const byName: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    ".gitignore": "plaintext",
  };
  if (byName[base]) return byName[base];
  const byExt: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    conf: "ini",
    env: "bash",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    md: "markdown",
    markdown: "markdown",
    xml: "xml",
    html: "xml",
    sql: "sql",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    nginx: "nginx",
    service: "ini",
    properties: "properties",
    hcl: "hcl",
    tf: "hcl",
  };
  return byExt[ext];
}
