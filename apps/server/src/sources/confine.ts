/**
 * Path confinement — the single security choke point for the sources capability.
 *
 * Every file access in this feature (tree walk, file read, raw image serve, content
 * search) resolves its on-disk target through {@link confine}. It rejects `..`,
 * absolute paths, NUL bytes, and symlink-escape, returning a resolved, symlink-collapsed
 * absolute path proven to live inside the resolved source root (REQ-SEC-02; SC-07, SC-17).
 *
 * Two invariants make this a real-filesystem guarantee, not a string game:
 *   - `realpath` collapses symlinks, so a symlink escaping the root resolves to an
 *     out-of-root absolute path that then fails containment — the same check that
 *     rejects `..`.
 *   - Containment is a path-SEGMENT relation (`path.relative`), never a raw `startsWith`,
 *     which has the classic `/srv/root` vs `/srv/root-evil` false-accept bug.
 */

import { realpath } from "node:fs/promises";
import * as path from "node:path";

import { SourceFailure } from "./errors.js";

/**
 * Resolve `relPath` against `root` and prove the result lives inside `root`, following and
 * collapsing symlinks. Returns the confined, symlink-resolved ABSOLUTE path of the target —
 * the only value any caller may then open/stat/read.
 *
 * Algorithm (each step MUST precede the next):
 *   1. Syntactic rejection BEFORE any filesystem access — a NUL byte, an absolute path, or
 *      any `..` segment throws `PATH_NOT_CONFINED` without touching the disk.
 *   2. `realRoot = realpath(root)` — collapse the root's own symlinks once.
 *   3. `realTarget = realpath(join(realRoot, relPath))` — collapse the target's symlinks.
 *      A symlink pointing outside the root resolves to an out-of-root path and fails step 4.
 *   4. Require `realTarget` to be contained in `realRoot` (segment relation, not string
 *      prefix); otherwise throw `PATH_NOT_CONFINED`.
 *
 * A non-existent leaf yields `PATH_NOT_FOUND` — but only AFTER the longest existing ancestor
 * is realpath-resolved and proven contained, so an intermediate symlink can never smuggle
 * the (non-existent) tail outside the root.
 *
 * @param root    Absolute path to the source's confined on-disk root. Trusted (deck-owned),
 *                but still realpath-resolved so a symlinked root is normalized first.
 * @param relPath POSIX-style path relative to the source root, from a request query
 *                (`?path=…`) or produced during the walk. Untrusted.
 * @returns The confined, symlink-resolved absolute path of an existing target.
 * @throws {SourceFailure} `PATH_NOT_CONFINED` — absolute / `..` / NUL / symlink-escape /
 *         resolves outside root (REQ-SEC-02). `details.attemptedPath = relPath` (log-only).
 * @throws {SourceFailure} `PATH_NOT_FOUND` — syntactically safe and contained, but no such
 *         file exists (its existing-ancestor prefix was confirmed contained first).
 */
export async function confine(root: string, relPath: string): Promise<string> {
  // (1) Syntactic rejection — no filesystem access yet.
  assertSyntacticallySafe(relPath);

  // (2) Collapse the root's own symlinks once. The root is deck-owned and always exists;
  //     if it does not, that is an acquisition/config fault surfaced as PATH_NOT_FOUND.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (cause) {
    throw new SourceFailure("PATH_NOT_FOUND", undefined, { attemptedPath: relPath }, { cause });
  }

  // The lexical join is guaranteed to stay under realRoot because step (1) removed every
  // `..` and rejected absolutes; only a symlink could still escape, which step (4) catches.
  const lexical = path.resolve(realRoot, toNativeRel(relPath));

  // (3) Collapse the target's symlinks. ENOENT is expected for a missing leaf.
  let realTarget: string;
  try {
    realTarget = await realpath(lexical);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return confineMissing(realRoot, lexical, relPath, cause);
    }
    throw new SourceFailure("PATH_NOT_FOUND", undefined, { attemptedPath: relPath }, { cause });
  }

  // (4) Containment on the symlink-collapsed path.
  if (!isContained(realRoot, realTarget)) {
    throw new SourceFailure("PATH_NOT_CONFINED", undefined, { attemptedPath: relPath });
  }
  return realTarget;
}

/**
 * The confinement choke point, named per `03-path-confinement-and-tree.md`. Alias of
 * {@link confine}; `tree.ts` (item 003) imports this name.
 */
export const confinePath = confine;

/**
 * Reject a relative path syntactically. Runs before any fs access. Rejections:
 *   - a NUL byte (`\0`) anywhere — poison-null truncation of the eventual syscall arg;
 *   - an absolute path — POSIX (`/etc/passwd`) or Windows-shaped (`C:\`, `\\unc`) — the
 *     target must be relative to the source root;
 *   - any `..` (parent) segment, evaluated on the POSIX-normalized path so `a/../../b`,
 *     `./../x`, a leading `../`, and the backslash form are all caught.
 *
 * Percent-encoded traversal (`%2e%2e`, `%252e%252e`) is rejected outright as
 * `PATH_NOT_CONFINED` — WITHOUT decoding it into `..` (the HTTP layer already decodes
 * legitimate query params before `confine` is called, so a still-encoded `%2e`/`%25`
 * reaching here is an evasion attempt, never a real filename we must serve).
 *
 * A `.` (current-dir) segment and redundant slashes are harmless and normalized away.
 */
function assertSyntacticallySafe(relPath: string): void {
  if (relPath.includes("\0")) {
    throw new SourceFailure("PATH_NOT_CONFINED", undefined, { attemptedPath: relPath });
  }
  // Percent-encoded traversal: an encoded dot (`%2e`) or the double-encoding marker (`%25`,
  // an encoded `%`). Neither is decoded — their mere presence is rejected. This catches
  // `%2e%2e/…` and `%252e%252e/…` without ever turning them into `..`.
  if (/%2e/i.test(relPath) || /%25/i.test(relPath)) {
    throw new SourceFailure("PATH_NOT_CONFINED", undefined, { attemptedPath: relPath });
  }
  // Reject any absolute form. `path.isAbsolute` is platform-specific, so check both the
  // POSIX and Windows notions plus a bare leading slash/backslash — deck runs on POSIX but
  // the guard is defence-in-depth against a Windows-shaped input.
  if (
    path.posix.isAbsolute(relPath) ||
    path.win32.isAbsolute(relPath) ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\")
  ) {
    throw new SourceFailure("PATH_NOT_CONFINED", undefined, { attemptedPath: relPath });
  }
  // Inspect segments for `..` on BOTH separator conventions — a backslash `..\secret` must
  // be caught even though POSIX normalize treats `\` as an ordinary filename character.
  const posixNormalized = path.posix.normalize(relPath);
  const segments = relPath.split(/[/\\]/);
  if (
    posixNormalized === ".." ||
    posixNormalized.startsWith("../") ||
    posixNormalized.split("/").includes("..") ||
    segments.includes("..")
  ) {
    throw new SourceFailure("PATH_NOT_CONFINED", undefined, { attemptedPath: relPath });
  }
}

/** Convert a validated POSIX-style rel path to the host separator for `path.resolve`. */
function toNativeRel(relPath: string): string {
  return relPath.split("/").join(path.sep);
}

/**
 * True iff `realTarget` is `realRoot` itself or a descendant of it, decided by the path
 * SEGMENT relation — never a raw string `startsWith`, which would falsely accept a sibling
 * like `/srv/root-evil` for root `/srv/root`. Both inputs are already realpath-resolved
 * (symlinks collapsed), so this is the definitive containment decision.
 */
function isContained(realRoot: string, realTarget: string): boolean {
  if (realTarget === realRoot) return true; // the root itself is in-root
  const rel = path.relative(realRoot, realTarget);
  // `rel` escapes iff it is empty, starts with a `..` segment, or is absolute
  // (absolute happens when the two live on different Windows drives — treat as escape).
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Handle a target whose leaf does not exist. Walk up to the longest existing ancestor,
 * realpath-resolve it (collapsing any symlink along the way), and require it to be contained.
 * If the existing ancestor escapes → PATH_NOT_CONFINED (a symlinked intermediate); otherwise
 * the path is safe but absent → PATH_NOT_FOUND.
 */
async function confineMissing(
  realRoot: string,
  lexical: string,
  relPath: string,
  enoent: unknown,
): Promise<never> {
  let ancestor = path.dirname(lexical);
  // Ascend until an existing directory is found (or we reach the filesystem root). The loop
  // is bounded by path depth; each step realpath-resolves one existing candidate.
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor);
      if (realAncestor !== realRoot && !isContained(realRoot, realAncestor)) {
        throw new SourceFailure("PATH_NOT_CONFINED", undefined, { attemptedPath: relPath });
      }
      // Existing ancestor is contained; the missing tail is genuinely absent.
      throw new SourceFailure(
        "PATH_NOT_FOUND",
        undefined,
        { attemptedPath: relPath },
        { cause: enoent },
      );
    } catch (cause) {
      if (cause instanceof SourceFailure) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SourceFailure(
          "PATH_NOT_FOUND",
          undefined,
          { attemptedPath: relPath },
          { cause },
        );
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        // Reached the filesystem root without finding an existing ancestor — treat as absent.
        throw new SourceFailure(
          "PATH_NOT_FOUND",
          undefined,
          { attemptedPath: relPath },
          { cause: enoent },
        );
      }
      ancestor = parent;
    }
  }
}
