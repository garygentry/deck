import { describe, expect, it } from "vitest";

import {
  aliasProblem,
  isCatchAllMiddleware,
  patternMatchesPath,
  patternReachesPrefix,
  prefixesOverlap,
  rootPathProblem,
} from "../src/modules/routes.js";

describe("module path rules", () => {
  it.each([
    ["/api/llm-usage", null],
    ["/api/a.b_c~d/e-f", null],
    ["/api", "must be under /api/"],
    ["/usage", "must be under /api/"],
    ["/api/m", "outside /api/m"],
    ["/api/m/x", "outside /api/m"],
    ["/api/:id", "literal path"],
    ["/api/*", "literal path"],
    ["/api/{x}", "literal path"],
    ["/api/u/", "literal path"],
    ["/api//u", "literal path"],
    ["/api/./u", "literal path"],
    ["/api/../u", "literal path"],
    ["api/u", "literal path"],
  ])("alias %s → %s", (alias, problem) => {
    const result = aliasProblem(alias);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });

  it.each([
    ["/metrics", null],
    ["/feeds/usage.txt", null],
    ["/", "literal path"],
    ["/api", "outside /api"],
    ["/api/x", "outside /api"],
    ["/:prefix/*", "literal path"],
    ["/x?y", "literal path"],
  ])("root path %s → %s", (path, problem) => {
    const result = rootPathProblem(path);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });

  it.each([
    ["/api/shared", "/api/shared/child", true],
    ["/api/shared/child", "/api/shared", true],
    ["/api/a", "/api/a", true],
    ["/api/shared", "/api/shared-v2", false],
    ["/api/a/b", "/api/a/c", false],
  ])("prefixes %s and %s overlap: %s", (a, b, expected) => {
    expect(prefixesOverlap(a, b)).toBe(expected);
  });

  it.each([
    ["/api/providers/:id", "/api/providers/custom", true],
    ["/api/providers/:id", "/api/providers", true],
    ["/api/providers/:id", "/api/providers/custom/deep", false],
    ["/api/providers", "/api/providers/custom", false],
    ["/api/sources/:id/*", "/api/sources/docs/x/y", true],
    ["/api/sources/:id/tree", "/api/sources", true],
    ["/api/config", "/api/configs", false],
    ["/api/*", "/api/anything", true],
  ])("pattern %s reaches prefix %s: %s", (pattern, prefix, expected) => {
    expect(patternReachesPrefix(pattern, prefix)).toBe(expected);
  });

  it.each([
    ["/metrics", "/metrics", true],
    ["/:any", "/metrics", true],
    ["/x/*", "/x/feed.txt", true],
    ["/metrics", "/metrics/extra", false],
    ["/a/:b", "/a", false],
  ])("pattern %s matches path %s: %s", (pattern, path, expected) => {
    expect(patternMatchesPath(pattern, path)).toBe(expected);
  });

  it("treats only the global catch-alls as middleware", () => {
    expect(isCatchAllMiddleware("*")).toBe(true);
    expect(isCatchAllMiddleware("/*")).toBe(true);
    expect(isCatchAllMiddleware("/api/*")).toBe(false);
  });
});
