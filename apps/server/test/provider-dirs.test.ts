import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { REPO_ROOT, serverSourceRoots } from "./util/source-roots.js";

const PROVIDERS = resolve(__dirname, "../src/providers");

/** Every `providers/<dir>` holding an `index.ts`: a provider implementation outside a module. */
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
 * A provider kind lives in its data-source module (`modules/<id>/server`), which BUILTIN_MODULES
 * lists: `providers/` holds only the kernel (the registry and the provider wiring). A provider
 * folder there would bypass the module contract.
 */
describe("providers/ holds no provider folders", () => {
  it("has none", () => {
    expect(providerDirs, "move each providers/<kind> into modules/<id>/server").toEqual([]);
  });
});

/**
 * With the generated barrel gone, a provider reaches deck only through its data-source module:
 * a module server half without a `module.ts` that BUILTIN_MODULES lists would be dead code.
 */
describe("every co-located module server half is a registered built-in", () => {
  it("finds the module server halves", () => {
    expect(moduleServerDirs).toContain("modules/link/server");
  });

  it.each(moduleServerDirs)("%s has a module.ts whose module is built in", async (dir) => {
    expect(existsSync(join(REPO_ROOT, dir, "module.ts")), `${dir}/module.ts`).toBe(true);
    await expectOneBuiltinExport(join(REPO_ROOT, dir, "module.ts"));
  });
});
