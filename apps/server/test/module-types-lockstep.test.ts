import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateModuleTypes } from "../src/scripts/gen-module-types.js";

describe("built-in module section types", () => {
  it("match a fresh generation from each module's schema (run pnpm gen:module-types)", async () => {
    const generated = await generateModuleTypes();
    expect(generated.length).toBeGreaterThan(0);
    for (const { output, source } of generated) {
      expect(readFileSync(fileURLToPath(new URL(`../src/${output}`, import.meta.url)), "utf8"), output).toBe(source);
    }
  });
});
