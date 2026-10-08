import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `../src/index.js` and `../src/actions.js` are the package's `.` and `./actions` exports.
import { validateActionParams } from "../src/actions.js";
import { POLL_DEFAULTS } from "../src/index.js";
import { DRIFT_UI } from "../src/modules/drift.js";
import { INVENTORY_UI } from "../src/modules/inventory.js";
import { LLM_USAGE_UI } from "../src/modules/llm-usage.js";
import { MONITORING_UI } from "../src/modules/monitoring.js";
import { PORTAL_UI } from "../src/modules/portal.js";
import { SOURCES_UI } from "../src/modules/sources.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const MODULE_SDK = resolve(dirname(fileURLToPath(import.meta.url)), "../../module-sdk");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `[clause, specifier]` of every import and re-export with a `from` in a source. */
function imports(source: string): [string, string][] {
  return [...source.matchAll(/^(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)].map(([, clause, specifier]) => [clause!, specifier!]);
}

describe("@deck/contract", () => {
  it("serves the default provider timing", () => {
    expect(POLL_DEFAULTS).toEqual({ pollIntervalMs: 30_000, ttlMs: 30_000, unreachableAfterMs: 90_000, timeoutMs: 5_000 });
  });

  it("serves the actions parameter validator from its subpath", () => {
    const action = { params: [{ name: "n", type: "number" as const, required: true }] };
    expect(validateActionParams(action, { n: "3" })).toEqual({ ok: true, values: { n: 3 } });
    expect(validateActionParams(action, {})).toEqual({ ok: false, errors: [{ name: "n", message: '"n" is required.' }] });
  });

  it("loads no other module at runtime, so it is safe in the browser bundle", () => {
    for (const path of walk(SRC)) {
      const file = relative(SRC, path);
      const source = readFileSync(path, "utf8");
      // Every import is type-only, and a re-export names a sibling file.
      for (const [clause, specifier] of imports(source)) {
        if (/^type\b/.test(clause)) continue;
        expect(specifier, `${file}: ${clause}`).toMatch(/^\.\/[a-z]+\.js$/);
      }
      expect(source, file).not.toMatch(/\bprocess\b|\bBun\b|["']node:/);
    }
  });

  it("serves built-in modules' UI contributions from its modules subpath, as plain JSON", () => {
    expect(LLM_USAGE_UI.id).toBe("llm-usage");
    expect(JSON.parse(JSON.stringify(LLM_USAGE_UI))).toEqual(LLM_USAGE_UI);
    expect(MONITORING_UI.id).toBe("monitoring");
    expect(JSON.parse(JSON.stringify(MONITORING_UI))).toEqual(MONITORING_UI);
    expect(PORTAL_UI.id).toBe("portal");
    expect(JSON.parse(JSON.stringify(PORTAL_UI))).toEqual(PORTAL_UI);
    expect(SOURCES_UI.id).toBe("sources");
    expect(JSON.parse(JSON.stringify(SOURCES_UI))).toEqual(SOURCES_UI);
  });

  it("serves the drift module's UI contributions as plain JSON", () => {
    expect(DRIFT_UI.id).toBe("drift");
    expect(JSON.parse(JSON.stringify(DRIFT_UI))).toEqual(DRIFT_UI);
  });

  it("serves the inventory module's UI contributions as plain JSON", () => {
    expect(INVENTORY_UI.id).toBe("inventory");
    expect(JSON.parse(JSON.stringify(INVENTORY_UI))).toEqual(INVENTORY_UI);
  });

  it("depends on the module SDK for types only, and the SDK depends on no deck package, so there is no cycle", () => {
    const sdk = JSON.parse(readFileSync(join(MODULE_SDK, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
      expect(Object.keys(sdk[field] ?? {}).filter((name) => name.startsWith("@deck/")), field).toEqual([]);
    }
    for (const path of walk(join(MODULE_SDK, "src"))) {
      for (const [, specifier] of imports(readFileSync(path, "utf8"))) expect(specifier, relative(MODULE_SDK, path)).not.toMatch(/^@deck\//);
    }
    for (const path of walk(SRC)) {
      for (const [clause, specifier] of imports(readFileSync(path, "utf8"))) {
        if (specifier.startsWith("@deck/module-sdk")) expect(clause, relative(SRC, path)).toMatch(/^type\b/);
      }
    }
  });
});
