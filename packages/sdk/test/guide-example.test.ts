import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The runtime-modules guide's "Draw charts" example is guide-charts.tsx byte for byte, and
 * `pnpm typecheck` compiles that file against index.d.ts: the example compiles as written.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the guide's chart example", () => {
  it("is guide-charts.tsx, which typecheck compiles", () => {
    const guide = read("../../../docs/guides/runtime-modules.md");
    const section = guide.indexOf("### Draw charts");
    expect(section).toBeGreaterThan(-1);
    const fence = /```tsx\n([\s\S]*?)```\n/.exec(guide.slice(section));
    expect(fence).not.toBeNull();
    expect(fence![1]).toBe(read("./guide-charts.tsx"));
  });
});
