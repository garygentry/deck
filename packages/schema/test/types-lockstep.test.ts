import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generateTypes } from "../scripts/build-types.js";

describe("generated document types", () => {
  it("are byte-identical to generation from both schemas", async () => {
    const generated = await generateTypes();
    const [committedConfig, committedSnapshot] = await Promise.all([
      readFile(resolve("src/types.config.generated.ts"), "utf8"),
      readFile(resolve("src/types.snapshot.generated.ts"), "utf8"),
    ]);

    expect(generated.config).toBe(committedConfig);
    expect(generated.snapshot).toBe(committedSnapshot);
  });
});
