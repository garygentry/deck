import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  searchTree,
  MAX_FILE_BYTES,
  MAX_SEARCH_MATCHES,
  MAX_SNIPPET_CHARS,
  type BuildManifestOptions,
  type SourceSearchMatch,
} from "../../server/tree.js";

const OPTS: BuildManifestOptions = { sourceId: "docs", kind: "markdown-tree", title: "Docs" };

/** All matches for `path`, of an optional `kind`. */
function matchesFor(matches: SourceSearchMatch[], path: string, kind?: "name" | "content"): SourceSearchMatch[] {
  return matches.filter((m) => m.path === path && (kind === undefined || m.kind === kind));
}

describe("searchTree — server-side confined search", () => {
  let base: string;
  let root: string; // name/content/include-exclude/binary/over-cap
  let capRoot: string; // > MAX_SEARCH_MATCHES name matches

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "deck-search-"));

    // --- root: name + content + include/exclude + binary + over-cap. ------------------
    root = join(base, "tree");
    mkdirSync(join(root, "guide"), { recursive: true });
    mkdirSync(join(root, "secret"), { recursive: true });

    // Name match on the path; content match on a body line (1-based line 2).
    writeFileSync(join(root, "guide", "setup.md"), "install the widget\nconfigure needle here\ndone\n");
    // A file whose content matches but whose name does not (isolates content matching).
    writeFileSync(join(root, "guide", "intro.md"), "welcome\nthe needle lives on line two\n");
    // An excluded subtree that DOES contain the needle — must never be returned.
    writeFileSync(join(root, "secret", "hidden.md"), "needle in the excluded subtree\n");
    // A very long matching line → snippet must be bounded at MAX_SNIPPET_CHARS.
    writeFileSync(join(root, "long.md"), `${"a".repeat(300)} needle tail\n`);

    // Binary file: name contains the needle, but content (with a NUL early) is never scanned.
    const bin = Buffer.from(`needle text before nul\n`, "utf8");
    bin[3] = 0x00; // NUL inside the first 8 KiB ⇒ binary
    writeFileSync(join(root, "needle-blob.bin"), bin);

    // Over-cap file: name contains the needle, but its > 1 MiB body is never scanned.
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61); // 'a'
    big.write("needle", 0); // put the needle in the (never-scanned) content too
    writeFileSync(join(root, "needle-big.txt"), big);

    // --- capRoot: enough name matches to exceed MAX_SEARCH_MATCHES. -------------------
    capRoot = join(base, "cap");
    mkdirSync(capRoot, { recursive: true });
    const overCap = MAX_SEARCH_MATCHES + 50; // 250 files, each name-matching "zzz"
    for (let i = 0; i < overCap; i++) {
      const n = String(i).padStart(3, "0");
      writeFileSync(join(capRoot, `zzz-${n}.txt`), "no body match here\n");
    }
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe("name + content matches", () => {
    it("a name/path match yields kind:'name'", async () => {
      const res = await searchTree(root, OPTS, "setup");
      expect(res.sourceId).toBe("docs");
      const names = matchesFor(res.matches, "guide/setup.md", "name");
      expect(names).toHaveLength(1);
      expect(names[0].kind).toBe("name");
      expect(names[0].line).toBeUndefined();
    });

    it("a content match yields kind:'content' with a 1-based line and a bounded snippet", async () => {
      const res = await searchTree(root, OPTS, "needle");
      const content = matchesFor(res.matches, "guide/intro.md", "content");
      expect(content).toHaveLength(1);
      expect(content[0].kind).toBe("content");
      expect(content[0].line).toBe(2); // 1-based
      expect(content[0].snippet).toBe("the needle lives on line two");
      expect(content[0].snippet!.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    });

    it("a very long matching line is trimmed to a snippet ≤ MAX_SNIPPET_CHARS", async () => {
      const res = await searchTree(root, OPTS, "needle");
      const content = matchesFor(res.matches, "long.md", "content");
      expect(content).toHaveLength(1);
      expect(content[0].snippet!.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    });

    it("an empty query returns no matches", async () => {
      const res = await searchTree(root, OPTS, "   ");
      expect(res.matches).toEqual([]);
      expect(res.truncated).toBeFalsy();
    });
  });

  describe("include / exclude honored", () => {
    it("never returns a path excluded from the manifest", async () => {
      const res = await searchTree(root, { ...OPTS, exclude: ["**/secret/**"] }, "needle");
      expect(matchesFor(res.matches, "secret/hidden.md")).toHaveLength(0);
      // A non-excluded content match still comes through.
      expect(matchesFor(res.matches, "guide/intro.md", "content").length).toBeGreaterThan(0);
    });

    it("include narrows the searched set", async () => {
      const res = await searchTree(root, { ...OPTS, include: ["guide/**"] }, "needle");
      expect(res.matches.every((m) => m.path.startsWith("guide/"))).toBe(true);
    });
  });

  describe("binary & over-cap files are name-matched only", () => {
    it("a binary file matches by name but its content is never scanned", async () => {
      const res = await searchTree(root, OPTS, "needle");
      expect(matchesFor(res.matches, "needle-blob.bin", "name")).toHaveLength(1);
      expect(matchesFor(res.matches, "needle-blob.bin", "content")).toHaveLength(0);
    });

    it("an over-MAX_FILE_BYTES file matches by name but its content is never scanned", async () => {
      const res = await searchTree(root, OPTS, "needle");
      expect(matchesFor(res.matches, "needle-big.txt", "name")).toHaveLength(1);
      expect(matchesFor(res.matches, "needle-big.txt", "content")).toHaveLength(0);
    });
  });

  describe("match cap → truncated", () => {
    it("a query over MAX_SEARCH_MATCHES returns exactly 200 with truncated:true", async () => {
      const res = await searchTree(capRoot, OPTS, "zzz");
      expect(res.matches).toHaveLength(MAX_SEARCH_MATCHES);
      expect(res.truncated).toBe(true);
    });

    it("an under-cap query has truncated falsy", async () => {
      const res = await searchTree(root, OPTS, "setup");
      expect(res.matches.length).toBeLessThan(MAX_SEARCH_MATCHES);
      expect(res.truncated).toBeFalsy();
    });
  });
});
