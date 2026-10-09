import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { REPO_ROOT, serverSourceRoots } from "./util/source-roots.js";

const PROVIDERS = resolve(__dirname, "../src/providers");

/** Every `providers/<dir>` holding an `index.ts`: a provider implementation. */
const providerDirs = readdirSync(PROVIDERS)
  .filter((name) => statSync(join(PROVIDERS, name)).isDirectory() && existsSync(join(PROVIDERS, name, "index.ts")))
  .sort();

/** Every co-located module's server half (`modules/<id>/server`), repo-relative. */
const moduleServerDirs = serverSourceRoots()
  .map((root) => relative(REPO_ROOT, root))
  .filter((dir) => dir.startsWith("modules/"));

/** The `module.ts` at `file` exports exactly one value that BUILTIN_MODULES lists. */
async function expectOneBuiltinExport(file: string): Promise<void> {
  const exported = Object.values(await import(file) as Record<string, unknown>);
  expect(exported.filter((value) => (BUILTIN_MODULES as readonly unknown[]).includes(value))).toHaveLength(1);
}

/**
 * With the generated barrel gone, a provider reaches deck only through its data-source module:
 * a provider folder without a `module.ts` that BUILTIN_MODULES lists would be dead code. The
 * same holds for a co-located module's server half.
 */
describe("every provider folder is a registered data-source module", () => {
  it("finds the provider folders", () => {
    expect(providerDirs.length).toBeGreaterThan(0);
  });

  it.each(providerDirs)("providers/%s has a module.ts whose module is built in", async (dir) => {
    expect(existsSync(join(PROVIDERS, dir, "module.ts")), `providers/${dir}/module.ts`).toBe(true);
    await expectOneBuiltinExport(join(PROVIDERS, dir, "module.ts"));
  });
});

describe("every co-located module server half is a registered built-in", () => {
  it("finds the module server halves", () => {
    expect(moduleServerDirs).toContain("modules/link/server");
  });

  it.each(moduleServerDirs)("%s has a module.ts whose module is built in", async (dir) => {
    expect(existsSync(join(REPO_ROOT, dir, "module.ts")), `${dir}/module.ts`).toBe(true);
    await expectOneBuiltinExport(join(REPO_ROOT, dir, "module.ts"));
  });
});
