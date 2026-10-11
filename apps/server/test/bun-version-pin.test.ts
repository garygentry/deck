import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// CI must test the Bun that ships: `.bun-version` is the one value, the runtime image's tag must
// match it, and every workflow installs Bun from it rather than naming a version of its own.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const pinned = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
const workflowDir = join(ROOT, ".github/workflows");
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(workflowDir, name), "utf8") }));

describe("the Bun version pin", () => {
  it("is an exact version", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the runtime image's oven/bun tag", () => {
    const tags = [...readFileSync(join(ROOT, "Dockerfile"), "utf8").matchAll(/^FROM\s+oven\/bun:(\S+)/gm)].map((match) => match[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag, "Dockerfile oven/bun tag").toBe(`${pinned}-alpine`);
  });

  it("is what every workflow installs", () => {
    let setups = 0;
    for (const { name, text } of workflows) {
      expect(text, `${name} names a Bun version instead of reading .bun-version`).not.toMatch(/^\s*bun-version:/m);
      const uses = text.match(/uses:\s*oven-sh\/setup-bun@/g)?.length ?? 0;
      const fromFile = text.match(/^\s*bun-version-file:\s*\.bun-version\s*$/gm)?.length ?? 0;
      expect(fromFile, `${name}: every setup-bun step reads .bun-version`).toBe(uses);
      setups += uses;
    }
    expect(setups).toBeGreaterThan(0);
  });
});
