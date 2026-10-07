import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { primary } from "@deck/schema/fixtures";
import { describe, expect, it } from "vitest";
import { renderConfig } from "../src/cli/render.js";

describe("golden render", () => {
  it("matches the committed primary fixture render byte-for-byte", () => {
    const rendered = renderConfig(dirname(primary.paths.base));
    const golden = readFileSync(join(__dirname, "golden/deck.config.json"), "utf8");

    expect(rendered).toBe(golden);
  });
});
