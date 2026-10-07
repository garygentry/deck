import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";

const PROVIDERS = resolve(__dirname, "../src/providers");

/** Every `providers/<dir>` holding an `index.ts`: a provider implementation. */
const providerDirs = readdirSync(PROVIDERS)
  .filter((name) => statSync(join(PROVIDERS, name)).isDirectory() && existsSync(join(PROVIDERS, name, "index.ts")))
  .sort();

/**
 * With the generated barrel gone, a provider reaches deck only through its data-source module:
 * a provider folder without a `module.ts` that BUILTIN_MODULES lists would be dead code.
 */
describe("every provider folder is a registered data-source module", () => {
  it("finds the provider folders", () => {
    expect(providerDirs.length).toBeGreaterThan(0);
  });

  it.each(providerDirs)("providers/%s has a module.ts whose module is built in", async (dir) => {
    expect(existsSync(join(PROVIDERS, dir, "module.ts")), `providers/${dir}/module.ts`).toBe(true);
    const exported = Object.values(await import(join(PROVIDERS, dir, "module.ts")) as Record<string, unknown>);
    expect(exported.filter((value) => (BUILTIN_MODULES as readonly unknown[]).includes(value))).toHaveLength(1);
  });
});
