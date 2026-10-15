import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./util/source-roots.js";

/**
 * The files at a built-in module's root (`modules/<id>/*.ts`, beside `server/` and `web/`): the
 * module's `contract.ts` and whatever else both halves share. The web bundle loads them, so they
 * must stay data and plain functions, with no server code behind them.
 */
const SHARED = readdirSync(join(REPO_ROOT, "modules"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    readdirSync(join(REPO_ROOT, "modules", entry.name), { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".ts"))
      .map((file) => `modules/${entry.name}/${file.name}`),
  )
  .sort();
const CONTRACTS = SHARED.filter((path) => path.endsWith("/contract.ts"));

/** `[clause, specifier]` of every import and re-export with a `from` in a source. */
function imports(source: string): [string, string][] {
  return [...source.matchAll(/^(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)].map(([, clause, specifier]) => [clause!, specifier!]);
}

describe("built-in modules' shared files", () => {
  it("are found", () => {
    expect(CONTRACTS).toEqual(expect.arrayContaining(["modules/llm-usage/contract.ts", "modules/portal/contract.ts", "modules/docker/contract.ts"]));
    expect(SHARED).toContain("modules/actions/params.ts");
  });

  it.each(SHARED)("%s loads only types, its own module's shared files and other modules' contracts at runtime", (path) => {
    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    for (const [clause, specifier] of imports(source)) {
      if (/^type\b/.test(clause)) continue;
      expect(specifier, `${path}: ${clause}`).toMatch(/^(?:\.\/[a-z-]+|\.\.\/[a-z-]+\/contract)\.js$/);
    }
    expect(source, path).not.toMatch(/\bprocess\b|\bBun\b|["']node:|\bimport\s*\(|\brequire\s*\(/);
  });

  it.each(CONTRACTS)("%s exports plain JSON", async (path) => {
    const exports = (await import(pathToFileURL(join(REPO_ROOT, path)).href)) as Record<string, unknown>;
    expect(Object.keys(exports).length, path).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(exports)) {
      expect(JSON.parse(JSON.stringify(value)), `${path}: ${name}`).toEqual(value);
    }
  });

  it.each(CONTRACTS)("%s names its own module in any UI manifest it exports", async (path) => {
    const id = path.split("/")[1]!;
    const exports = (await import(pathToFileURL(join(REPO_ROOT, path)).href)) as Record<string, unknown>;
    for (const value of Object.values(exports)) {
      if (typeof value === "object" && value !== null && "contributes" in value) expect((value as { id?: unknown }).id, path).toBe(id);
    }
  });
});
