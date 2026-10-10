import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `node:fs/promises`.realpath is a non-configurable export, so it cannot be spied with
// `vi.spyOn`. Replace the module with a call-through vi.fn (mirrors snapshot-source.test.ts)
// so the syntactic-reject tests can assert the filesystem was never touched.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

import * as fsPromises from "node:fs/promises";

import { SourceFailure } from "../src/sources/errors.js";
import { confine } from "../src/sources/confine.js";

/**
 * Every vector resolves outside the source root and MUST be rejected as PATH_NOT_CONFINED.
 * This table is the executable form of the identical table in
 * `03-path-confinement-and-tree.md` §2.5 (SC-07 / SC-17; REQ-SEC-02) — the two must stay in
 * sync.
 */
const REJECTED_VECTORS: ReadonlyArray<{ name: string; rel: string }> = [
  { name: "parent traversal", rel: "../secret.txt" },
  { name: "nested traversal", rel: "docs/../../secret.txt" },
  { name: "absolute posix path", rel: "/etc/passwd" },
  { name: "absolute with drive", rel: "C:\\Windows\\win.ini" },
  { name: "symlink escaping root", rel: "escape-link/secret.txt" },
  { name: "encoded traversal", rel: "%2e%2e/secret.txt" }, // must NOT be decoded into ".."
  { name: "double-encoded traversal", rel: "%252e%252e/secret.txt" },
  { name: "NUL byte injection", rel: "docs/readme.md\u0000.png" },
  { name: "backslash traversal", rel: "..\\secret.txt" },
  { name: "bare parent", rel: ".." },
];

/** Legitimate in-root paths; each resolves to the confined root or a descendant of it. */
const ACCEPTED_PATHS: readonly string[] = [
  "readme.md",
  "docs/guide.md",
  "docs/img/logo.png",
  "", // the root itself resolves to the confined root
];

/** Syntactic rejects: rejected before any fs.realpath call (asserted via the realpath spy). */
const SYNTACTIC_REJECTS: ReadonlyArray<{ name: string; rel: string }> = [
  { name: "bare parent", rel: ".." },
  { name: "absolute posix path", rel: "/etc/passwd" },
  { name: "NUL byte injection", rel: "docs/readme.md\u0000.png" },
];

describe("confine — the path-confinement choke point (SC-07/SC-17; REQ-SEC-02)", () => {
  let base: string; // tmp base holding both root/ and the out-of-root sentinel
  let root: string; // the confined source root
  let realRoot: string; // realpath(root) — symlinks collapsed

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "deck-confine-"));
    root = join(base, "root");
    const outside = join(base, "outside");

    // In-root tree: the ACCEPTED_PATHS targets.
    mkdirSync(join(root, "docs", "img"), { recursive: true });
    writeFileSync(join(root, "readme.md"), "# readme\n");
    writeFileSync(join(root, "docs", "guide.md"), "# guide\n");
    writeFileSync(join(root, "docs", "img", "logo.png"), "\x89PNG\r\n");

    // Out-of-root secrets the confinement must never surface.
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "top secret passwd contents\n");
    writeFileSync(join(base, "secret.txt"), "sibling secret passwd\n");

    // A real symlink escaping the root: escape-link → ../outside (so escape-link/secret.txt
    // resolves, via realpath, to the out-of-root file and fails containment).
    symlinkSync(outside, join(root, "escape-link"), "dir");

    realRoot = await fsPromises.realpath(root);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe("REJECTED_VECTORS all throw PATH_NOT_CONFINED with no leaked path", () => {
    it.each(REJECTED_VECTORS)("$name ($rel) → PATH_NOT_CONFINED", async ({ rel }) => {
      const err = await confine(root, rel).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceFailure);
      expect((err as SourceFailure).code).toBe("PATH_NOT_CONFINED");

      // The public body carries only { error, code } — never the root path or a secret word.
      const pub = (err as SourceFailure).toPublic();
      expect(pub.code).toBe("PATH_NOT_CONFINED");
      expect(pub.error).not.toContain(realRoot);
      expect(pub.error).not.toContain(root);
      expect(pub.error).not.toContain(base);
      expect(pub.error).not.toMatch(/passwd|secret/i);
      // The attempted path is retained internally for logs only, never on the wire.
      expect(JSON.stringify(pub)).not.toContain("attemptedPath");
    });
  });

  describe("syntactic rejects never touch the filesystem", () => {
    it.each(SYNTACTIC_REJECTS)(
      "$name ($rel) is rejected before any fs.realpath call",
      async ({ rel }) => {
        const realpathSpy = vi.mocked(fsPromises.realpath);
        realpathSpy.mockClear();

        const err = await confine(root, rel).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SourceFailure);
        expect((err as SourceFailure).code).toBe("PATH_NOT_CONFINED");

        // The security property: not a single realpath was issued for a syntactic reject.
        expect(realpathSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe("ACCEPTED_PATHS resolve to the confined root or a descendant", () => {
    it.each(ACCEPTED_PATHS)("%j resolves in-root", async (rel) => {
      const resolved = await confine(root, rel);
      expect(nodePath.isAbsolute(resolved)).toBe(true);

      if (rel === "") {
        expect(resolved).toBe(realRoot);
      } else {
        // A descendant: realpath(root) is a proper path prefix by SEGMENT relation.
        const relToRoot = nodePath.relative(realRoot, resolved);
        expect(relToRoot.length).toBeGreaterThan(0);
        expect(relToRoot.startsWith("..")).toBe(false);
        expect(nodePath.isAbsolute(relToRoot)).toBe(false);
      }
    });
  });

  it("a safe-but-absent confined path throws PATH_NOT_FOUND, not PATH_NOT_CONFINED", async () => {
    const err = await confine(root, "does/not/exist.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceFailure);
    expect((err as SourceFailure).code).toBe("PATH_NOT_FOUND");
  });

  it("containment is a segment relation — a sibling root like root-evil is rejected", async () => {
    // /base/root-evil is a string-prefix sibling of /base/root; a raw startsWith would
    // falsely accept it. Confining root-evil's own file against `root` must reject.
    const evil = join(base, "root-evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "x.txt"), "sibling\n");
    // Reach it via a symlink inside root so confinement (not syntactic) is what rejects.
    symlinkSync(evil, join(root, "evil-link"), "dir");

    const err = await confine(root, "evil-link/x.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceFailure);
    expect((err as SourceFailure).code).toBe("PATH_NOT_CONFINED");
  });
});
