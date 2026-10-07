import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { routablePathProblem } from "@deck/module-sdk";
import { describe, expect, it } from "vitest";

/**
 * The shared `routablePathProblem` mirrors the router's own pattern parser (regexparam, which
 * wouter uses): a path is refused exactly when the router could not compile it.
 */
async function routerParse(): Promise<(pattern: string) => unknown> {
  const fromWeb = createRequire(import.meta.url);
  const fromWouter = createRequire(fromWeb.resolve("wouter"));
  const module = (await import(pathToFileURL(fromWouter.resolve("regexparam")).href)) as { parse: (pattern: string) => unknown };
  return module.parse;
}

describe("routablePathProblem agrees with the router's parser", () => {
  it.each([
    "/", "/hosts", "/hosts/:name", "/services/:host/:name", "/tools/", "/a//b", "/%20x", "/files/*", "/files/*?",
    "/files/:rest*", "/a/:b?", "/a/:b.json", "/a/:b?.json", "/v1.2/x~y", "/tools/[", "/x(y", "/a/:b.(", "/a)", "/a{2", "/a/+",
  ])("%s", async (path) => {
    const parse = await routerParse();
    let throws = false;
    try {
      parse(path);
    } catch {
      throws = true;
    }
    expect(routablePathProblem(path, "p") !== null).toBe(throws);
  });

  it("refuses /tools/[ and accepts /tools/ and /files/:rest*", () => {
    expect(routablePathProblem("/tools/[", "p")).not.toBeNull();
    expect(routablePathProblem("/tools/", "p")).toBeNull();
    expect(routablePathProblem("/files/:rest*", "p")).toBeNull();
  });
});
