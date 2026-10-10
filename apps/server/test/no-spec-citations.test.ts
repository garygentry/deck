import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./util/source-roots.js";

/**
 * Shipped code describes behaviour, never the planning documents it was built from: those are
 * local and get archived, so a citation of one is a dead reference. Every tracked text file under
 * apps/, modules/ and packages/ (code, tests, scripts, configs and their READMEs) is held to it.
 */

/** The shapes a planning-document citation takes, each with what to write instead. */
const CITATIONS: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bspecs\//, what: "a path into specs/" },
  { pattern: /§/, what: "a section citation (§)" },
  { pattern: /\b\d{2}-[a-z][a-z0-9-]*\.md\b/, what: "a numbered spec document" },
  { pattern: /\btech[- ]spec\b/i, what: "the tech spec" },
  { pattern: /\bREQ-[A-Z]+(?:-[A-Z]+)*-\d+/, what: "a requirement id" },
  { pattern: /\b(?:SC|OQ)-\d+\b/, what: "a success-criterion or open-question id" },
];

/** Extensions read as text; anything else (images, fonts, archives) is skipped. */
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sh", ".css", ".md", ".yaml", ".yml", ".html", ".txt"]);

/** This file names the shapes it forbids. */
const SELF = "apps/server/test/no-spec-citations.test.ts";

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/** Every citation in `files` (repo-relative path and text). */
export function specCitations(files: ReadonlyArray<{ readonly rel: string; readonly text: string }>): Citation[] {
  return files.flatMap(({ rel, text }) =>
    text.split("\n").flatMap((line, index) =>
      CITATIONS.filter(({ pattern }) => pattern.test(line)).map(({ what }) => ({ file: rel, line: index + 1, what })),
    ),
  );
}

function shippedFiles(): Array<{ rel: string; text: string }> {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "apps", "modules", "packages"], { cwd: REPO_ROOT, encoding: "utf8" });
  return tracked
    .split("\0")
    .filter((rel) => rel !== "" && rel !== SELF && TEXT.has(extname(rel)))
    .map((rel) => ({ rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") }));
}

describe("shipped code cites no planning document", () => {
  it("finds each citation shape, and nothing in plain prose", () => {
    const found = specCitations([
      {
        rel: "planted.ts",
        text: [
          "// see specs/deck/plan.md",
          "// the routes (05-http-routes.md)",
          "// confined (00 §8)",
          "// per the tech-spec",
          "// bounded (REQ-PERF-02)",
          "// covers SC-13 and OQ-2",
          "// a plain comment about section 5 and a 404",
        ].join("\n"),
      },
    ]);
    expect(found.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("holds for every tracked file under apps/, modules/ and packages/", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(specCitations(files).map(({ file, line, what }) => `${file}:${line}: ${what}`)).toEqual([]);
  });
});
