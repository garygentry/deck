import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `node:fs`.createReadStream is used by the bounded reader and the binary sniff. Replace the
// module with a call-through vi.fn (mirrors sources-confine.test.ts's realpath mock) so the
// size-cap test can assert an oversize file never opens a body read stream — the memory
// bound (REQ-PERF-02): a 5 MiB file must never be buffered.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

import * as nodeFs from "node:fs";

import {
  buildManifest,
  readFile,
  languageForPath,
  MAX_FILE_BYTES,
  BINARY_SNIFF_BYTES,
  type BuildManifestOptions,
  type SourceTreeNode,
} from "../../server/tree.js";

const OPTS: BuildManifestOptions = { sourceId: "docs", kind: "markdown-tree", title: "Docs" };

/** Names of a node's children, in walk order. */
function childNames(node: SourceTreeNode): string[] {
  return (node.children ?? []).map((c) => c.name);
}

/** Find a node by its POSIX path within a tree (depth-first). */
function findNode(node: SourceTreeNode, path: string): SourceTreeNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return undefined;
}

describe("tree — confined walk, include/exclude, size cap, binary sniff (SC-02)", () => {
  let base: string;
  let treeRoot: string; // ordering / include-exclude / symlink-escape
  let readRoot: string; // size cap / binary sniff / language hint

  const FIVE_MIB = 5 * 1024 * 1024;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "deck-tree-"));

    // --- treeRoot: exercises ordering, symlink-escape, and include/exclude. -----------
    treeRoot = join(base, "tree");
    mkdirSync(join(treeRoot, "Zdir"), { recursive: true });
    mkdirSync(join(treeRoot, "apple"), { recursive: true });
    mkdirSync(join(treeRoot, "docs", "secret"), { recursive: true });
    writeFileSync(join(treeRoot, "Zdir", "z.md"), "# z\n");
    writeFileSync(join(treeRoot, "apple", "a.md"), "# a\n");
    writeFileSync(join(treeRoot, "Bfile.md"), "# B\n"); // capital B sorts before lowercase
    writeFileSync(join(treeRoot, "afile.md"), "# a\n");
    writeFileSync(join(treeRoot, "data.json"), "{}\n"); // non-md, for include filtering
    writeFileSync(join(treeRoot, "docs", "intro.md"), "# intro\n");
    writeFileSync(join(treeRoot, "docs", "secret", "hidden.md"), "# hidden\n");

    // A symlink escaping the root must be excluded from the walk (REQ-SEC-02).
    const outsideSecret = join(base, "outside-secret.txt");
    writeFileSync(outsideSecret, "TOP SECRET\n");
    symlinkSync(outsideSecret, join(treeRoot, "escape.md"));

    // --- readRoot: size cap, binary sniff, language hint. -----------------------------
    readRoot = join(base, "read");
    mkdirSync(readRoot, { recursive: true });
    // Size boundary files.
    writeFileSync(join(readRoot, "atcap.txt"), Buffer.alloc(MAX_FILE_BYTES, 0x61)); // 'a'
    writeFileSync(join(readRoot, "over.txt"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    writeFileSync(join(readRoot, "huge.bin"), Buffer.alloc(FIVE_MIB, 0x61));
    // Binary sniff boundary: a NUL inside the window ⇒ binary; only after it ⇒ text.
    const earlyNul = Buffer.alloc(64, 0x61);
    earlyNul[10] = 0x00;
    writeFileSync(join(readRoot, "early-nul.bin"), earlyNul);
    const lateNul = Buffer.alloc(BINARY_SNIFF_BYTES + 1, 0x61); // 8 KiB of 'a' then one more
    lateNul[BINARY_SNIFF_BYTES] = 0x00; // the NUL sits just past the sniff window
    writeFileSync(join(readRoot, "late-nul.txt"), lateNul);
    writeFileSync(join(readRoot, "plain.txt"), "just text\n");
    // Language hint files.
    writeFileSync(join(readRoot, "config.yaml"), "a: 1\n");
    writeFileSync(join(readRoot, "settings.json"), "{}\n");
    writeFileSync(join(readRoot, "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(readRoot, "notes.xyz"), "unknown extension\n");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe("ordering & shape", () => {
    it("produces a POSIX-relative root node, dirs-first then case-sensitive name order", async () => {
      const manifest = await buildManifest(treeRoot, OPTS);
      const root = manifest.tree;
      expect(root.path).toBe("");
      expect(root.name).toBe("");
      expect(root.type).toBe("dir");
      // Dirs first (Zdir before apple — capital Z=90 < lowercase a=97), then files
      // (Bfile.md before afile.md, data.json). escape.md (symlink out) is absent.
      expect(childNames(root)).toEqual(["Zdir", "apple", "docs", "Bfile.md", "afile.md", "data.json"]);
    });

    it("file nodes carry size and binary; dir nodes carry children; every path is POSIX-relative", async () => {
      const manifest = await buildManifest(treeRoot, OPTS);
      const file = findNode(manifest.tree, "Bfile.md")!;
      expect(file.type).toBe("file");
      expect(typeof file.size).toBe("number");
      expect(file.binary).toBe(false);
      expect(file.children).toBeUndefined();

      const dir = findNode(manifest.tree, "Zdir")!;
      expect(dir.type).toBe("dir");
      expect(Array.isArray(dir.children)).toBe(true);
      // Nested path is POSIX-relative (never absolute), joined with "/".
      expect(findNode(manifest.tree, "Zdir/z.md")).toBeDefined();
      expect(findNode(manifest.tree, "docs/intro.md")!.path).toBe("docs/intro.md");
    });

    it("excludes a symlink that escapes the root", async () => {
      const manifest = await buildManifest(treeRoot, OPTS);
      expect(findNode(manifest.tree, "escape.md")).toBeUndefined();
    });
  });

  describe("include / exclude (REQ-SRC-04)", () => {
    it("include only-md renders solely markdown files", async () => {
      const manifest = await buildManifest(treeRoot, { ...OPTS, include: ["**/*.md"] });
      expect(findNode(manifest.tree, "data.json")).toBeUndefined();
      expect(findNode(manifest.tree, "Bfile.md")).toBeDefined();
      expect(findNode(manifest.tree, "docs/secret/hidden.md")).toBeDefined();
    });

    it("exclude drops a matching subtree (and prunes the now-empty dir)", async () => {
      const manifest = await buildManifest(treeRoot, { ...OPTS, exclude: ["**/secret/**"] });
      expect(findNode(manifest.tree, "docs/secret/hidden.md")).toBeUndefined();
      expect(findNode(manifest.tree, "docs/secret")).toBeUndefined(); // pruned: no renderable child
      expect(findNode(manifest.tree, "docs/intro.md")).toBeDefined();
    });

    it("include minus exclude honors both", async () => {
      const manifest = await buildManifest(treeRoot, {
        ...OPTS,
        include: ["**/*.md"],
        exclude: ["**/secret/**"],
      });
      expect(findNode(manifest.tree, "data.json")).toBeUndefined(); // not md
      expect(findNode(manifest.tree, "docs/secret/hidden.md")).toBeUndefined(); // excluded
      expect(findNode(manifest.tree, "docs/intro.md")).toBeDefined();
      expect(findNode(manifest.tree, "Bfile.md")).toBeDefined();
    });

    it("absent patterns yield the whole tree minus nothing", async () => {
      const manifest = await buildManifest(treeRoot, OPTS);
      expect(findNode(manifest.tree, "data.json")).toBeDefined();
      expect(findNode(manifest.tree, "docs/secret/hidden.md")).toBeDefined();
    });

    it("an include/exclude combo matching nothing yields fileCount === 0 (acquired-but-empty)", async () => {
      const manifest = await buildManifest(treeRoot, { ...OPTS, include: ["**/*.rs"] });
      expect(manifest.fileCount).toBe(0);
      expect(manifest.tree.children).toEqual([]); // empty dirs all pruned
    });
  });

  describe("size cap → truncated (REQ-CFG-03, REQ-PERF-02)", () => {
    it("a file of MAX_FILE_BYTES + 1 returns truncated with no content, size still reported", async () => {
      const res = await readFile(readRoot, "over.txt");
      expect(res.truncated).toBe(true);
      expect(res.binary).toBe(false);
      expect(res.content).toBeUndefined();
      expect(res.size).toBe(MAX_FILE_BYTES + 1);
    });

    it("a file at exactly MAX_FILE_BYTES returns content", async () => {
      const res = await readFile(readRoot, "atcap.txt");
      expect(res.truncated).toBe(false);
      expect(res.binary).toBe(false);
      expect(res.content).toBeDefined();
      expect(res.content!.length).toBe(MAX_FILE_BYTES);
      expect(res.size).toBe(MAX_FILE_BYTES);
    });

    it("a 5 MiB file never opens a body read stream — never buffers more than the cap", async () => {
      vi.mocked(nodeFs.createReadStream).mockClear();
      const res = await readFile(readRoot, "huge.bin");
      expect(res.truncated).toBe(true);
      expect(res.content).toBeUndefined();
      expect(res.size).toBe(FIVE_MIB);
      // Cap is enforced from `stat` BEFORE any read — the body stream is never opened.
      expect(nodeFs.createReadStream).not.toHaveBeenCalled();
    });
  });

  describe("binary sniff → binary flag (REQ-CFG-04)", () => {
    it("a NUL within the first 8 KiB marks the node and read binary, with no content", async () => {
      const manifest = await buildManifest(readRoot, OPTS);
      expect(findNode(manifest.tree, "early-nul.bin")!.binary).toBe(true);

      const res = await readFile(readRoot, "early-nul.bin");
      expect(res.binary).toBe(true);
      expect(res.content).toBeUndefined();
    });

    it("a NUL only AFTER the 8 KiB window is treated as text (window boundary)", async () => {
      const manifest = await buildManifest(readRoot, OPTS);
      expect(findNode(manifest.tree, "late-nul.txt")!.binary).toBe(false);

      const res = await readFile(readRoot, "late-nul.txt");
      expect(res.binary).toBe(false);
      expect(res.content).toBeDefined();
    });

    it("a pure-text file is binary:false", async () => {
      const manifest = await buildManifest(readRoot, OPTS);
      expect(findNode(manifest.tree, "plain.txt")!.binary).toBe(false);
      const res = await readFile(readRoot, "plain.txt");
      expect(res.binary).toBe(false);
      expect(res.content).toBe("just text\n");
    });
  });

  describe("language hint (REQ-CFG-02)", () => {
    it("maps by extension / basename, undefined for unknown", async () => {
      expect((await readFile(readRoot, "config.yaml")).language).toBe("yaml");
      expect((await readFile(readRoot, "settings.json")).language).toBe("json");
      expect((await readFile(readRoot, "Dockerfile")).language).toBe("dockerfile");
      expect((await readFile(readRoot, "notes.xyz")).language).toBeUndefined();
    });

    it("languageForPath is a pure hint independent of the read", () => {
      expect(languageForPath("a/b/config.yaml")).toBe("yaml");
      expect(languageForPath("Dockerfile")).toBe("dockerfile");
      expect(languageForPath("weird.zzz")).toBeUndefined();
    });
  });

  describe("confinement on read", () => {
    it("rejects a traversal path with PATH_NOT_CONFINED", async () => {
      await expect(readFile(treeRoot, "../outside-secret.txt")).rejects.toMatchObject({
        code: "PATH_NOT_CONFINED",
      });
    });

    it("a missing but safe path is PATH_NOT_FOUND", async () => {
      await expect(readFile(treeRoot, "does/not/exist.md")).rejects.toMatchObject({
        code: "PATH_NOT_FOUND",
      });
    });
  });
});

// --- In-root symlink cycle guard (item 018) ------------------------------------------
//
// An in-root symlink whose realpath stays contained (self→., latest→., sub/back→..) is
// classified 'dir' and would, without a visited-realpath guard, be re-descended until the OS
// ELOOP limit (~40) — inflating fileCount and duplicating ~40 phantom nodes on every poll and
// search. The walk must terminate at the real file count with no phantom duplication.
describe("tree — in-root symlink cycle guard (item 018)", () => {
  let base: string;
  let cycleRoot: string;

  /** Deepest node depth in a tree (root === 0). */
  function maxDepth(node: SourceTreeNode, depth = 0): number {
    const children = node.children ?? [];
    if (children.length === 0) return depth;
    return Math.max(...children.map((c) => maxDepth(c, depth + 1)));
  }

  /** Every file path in a tree (depth-first). */
  function filePaths(node: SourceTreeNode): string[] {
    if (node.type === "file") return [node.path];
    return (node.children ?? []).flatMap(filePaths);
  }

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "deck-cycle-"));
    cycleRoot = join(base, "tree");
    // Two real files: a.md at the root and sub/b.md one level down.
    mkdirSync(join(cycleRoot, "sub"), { recursive: true });
    writeFileSync(join(cycleRoot, "a.md"), "# a\n");
    writeFileSync(join(cycleRoot, "sub", "b.md"), "# b\n");
    // In-root cycles: self → . (root points at itself); sub/back → .. (points at the root).
    symlinkSync(".", join(cycleRoot, "self"));
    symlinkSync("..", join(cycleRoot, "sub", "back"));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("terminates at the real file count with no phantom duplication", async () => {
    const manifest = await buildManifest(cycleRoot, OPTS);
    // Exactly the two real files — not the ~41 phantom copies the cycle would otherwise yield.
    expect(manifest.fileCount).toBe(2);
    expect(filePaths(manifest.tree).sort()).toEqual(["a.md", "sub/b.md"]);
  });

  it("does not descend the cycle — depth stays at the real tree depth", async () => {
    const manifest = await buildManifest(cycleRoot, OPTS);
    // sub/b.md sits one level below the root; a re-descended cycle would blow depth past ~40.
    expect(maxDepth(manifest.tree)).toBe(2);
  });

  it("skips the cycling symlinks rather than rendering them as directories", async () => {
    const manifest = await buildManifest(cycleRoot, OPTS);
    // `self` resolves to the root (already visited) and `sub/back` to the root too — both are
    // skipped, so neither appears as a child node in the manifest tree.
    expect(findNode(manifest.tree, "self")).toBeUndefined();
    expect(findNode(manifest.tree, "sub/back")).toBeUndefined();
  });
});
