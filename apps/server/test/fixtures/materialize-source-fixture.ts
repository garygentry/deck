/**
 * Materialize a committed source fixture (`markdown-tree/` or `file-tree/`) into a fresh working
 * copy and add the artifacts that must NOT be committed to the repo:
 *
 *  - an **oversized** file (> `MAX_FILE_BYTES`) so the reader returns `{ truncated:true }` with no
 *    body (a >1 MiB blob is never checked in);
 *  - an **escape symlink** (`escape-link → ../outside`) that resolves outside the source root, plus
 *    an out-of-root `secret.txt` sentinel — a repo-relative dangling symlink is never committed,
 *    and the confined walk/read must never surface either.
 *
 * The committed small files (GFM/link/image/XSS docs, highlightable configs, the binary + image
 * assets) are copied verbatim. Local-path sources acquire in place, so a store/provider built over
 * `root` reads these files on disk with no git and no network — the property the e2e and the
 * extended smoke path rely on.
 *
 * This is the `apps/server/test` sibling of `sources-estate/materialize.ts`: that helper builds a
 * whole DeckConfig estate in memory; this one lifts one on-disk fixture tree into a mutable copy
 * plus the setup-only oversized/symlink artifacts.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_FILE_BYTES } from "../../../../modules/sources/server/tree.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** The committed source fixtures this helper can materialize. */
export type SourceFixtureName = "markdown-tree" | "file-tree";

/** A materialized fixture: the confined source root plus a cleanup that removes the whole copy. */
export interface MaterializedSourceFixture {
  /** The source tree root — pass as `location.path`; a confined walk starts here. */
  readonly root: string;
  /** Remove the entire working copy (the tree, the out-of-root sentinel, and the symlink). */
  cleanup(): void;
}

/**
 * Copy `fixtures/<fixture>/` into a fresh working directory and, for `file-tree`, add the
 * setup-only oversized file and the root-escaping symlink + out-of-root sentinel.
 *
 * @param fixture the committed fixture folder name.
 * @param destParent optional parent dir the working copy is created under (e.g. an e2e ephemeral
 *   root so its owner cleans it up); defaults to a self-cleaning OS temp dir.
 */
export function materializeSourceFixture(
  fixture: SourceFixtureName,
  destParent?: string,
): MaterializedSourceFixture {
  const parent =
    destParent === undefined
      ? mkdtempSync(join(tmpdir(), "deck-src-fixture-"))
      : mkdtempSync(join(destParent, `${fixture}-`));

  // Lay the source tree under `parent/tree` and keep the out-of-root sentinel a sibling so the
  // escape symlink genuinely resolves outside the root.
  const root = join(parent, "tree");
  cpSync(join(FIXTURES_DIR, fixture), root, { recursive: true });

  if (fixture === "file-tree") {
    // Oversized file (> MAX_FILE_BYTES) — materialized here so no >1 MiB blob is committed.
    writeFileSync(join(root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));

    // An out-of-root secret + a symlink escaping the root. The confined walk must exclude the
    // symlink and never serve the secret; created at setup so no dangling link is committed.
    const outside = join(parent, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-DO-NOT-SERVE\n");
    symlinkSync(outside, join(root, "escape-link"));
  }

  return {
    root,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}
