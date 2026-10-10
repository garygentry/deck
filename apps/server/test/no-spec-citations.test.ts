import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./util/source-roots.js";

/**
 * Shipped code describes behaviour, never the planning documents it was built from: those are
 * local and get archived, so a citation of one is a dead reference. Every tracked text file under
 * apps/, modules/ and packages/ (code, tests, scripts, configs, extensionless files such as a
 * Dockerfile, and their READMEs) is held to it.
 *
 * docs/ is outside its reach on purpose: docs/docplan.json is the plan of the documentation
 * itself, and naming the planning documents each page was grounded in is its provenance record.
 */

/** The shapes a planning-document citation takes, each with what to write instead. */
const CITATIONS: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bspecs\//, what: "a path into specs/" },
  { pattern: /§/, what: "a section citation (§)" },
  { pattern: /\b\d{2}-[a-z][a-z0-9-]*\.md\b/, what: "a numbered spec document" },
  { pattern: /\btech[- ]spec\b/i, what: "the tech spec" },
  { pattern: /\bREQ-[A-Z]+(?:-[A-Z]+)*-\d+/, what: "a requirement id" },
  { pattern: /\b(?:SC|OQ)-\d+\b/, what: "a success-criterion or open-question id" },
  { pattern: /\bV-\d{3}\b/, what: "a verification-item id" },
  { pattern: /\bitems? \d{3}\b/i, what: "a backlog item number" },
  { pattern: /\((?:item )?0\d{2}\)/, what: "a backlog item number in parentheses" },
  { pattern: /\b(?:per|spec|see) 0\d\b/i, what: "a numbered spec document" },
  { pattern: /\bspec \d{2}\b/i, what: "a numbered spec document" },
];

/** Extensions read as text, with "" for an extensionless file; anything else (images, fonts, archives) is skipped. */
const TEXT = new Set(["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sh", ".css", ".md", ".yaml", ".yml", ".html", ".txt"]);

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
    text.split("\n").flatMap((line, index) => {
      // One citation per line: the first shape it matches.
      const hit = CITATIONS.find(({ pattern }) => pattern.test(line));
      return hit === undefined ? [] : [{ file: rel, line: index + 1, what: hit.what }];
    }),
  );
}

function shippedFiles(): Array<{ rel: string; text: string }> {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "apps", "modules", "packages"], { cwd: REPO_ROOT, encoding: "utf8" });
  return tracked
    .split("\0")
    .filter((rel) => rel !== "" && rel !== SELF && TEXT.has(extname(rel)))
    // An extensionless file may be binary: one with a NUL byte is skipped.
    .map((rel) => ({ rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") }))
    .filter(({ text }) => !text.includes("\0"));
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
          "// selection and arming (V-020)",
          "// the e2e/smoke item 016",
          "// the route tests (008)",
          "// per 06 (Warnings)",
          "# smoke path (spec 08)",
          "// a plain comment about section 5, a 404, item 3 of the list and 2026-10-10",
          "// retries (up to 3), port 8080 (or 08), a semver 0.3.2, `per 6 hours`, see 10 items",
        ].join("\n"),
      },
    ]);
    expect(found.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("holds for every tracked file under apps/, modules/ and packages/", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(({ rel }) => rel.endsWith("/Dockerfile"))).toBe(true);
    expect(specCitations(files).map(({ file, line, what }) => `${file}:${line}: ${what}`)).toEqual([]);
  });
});
