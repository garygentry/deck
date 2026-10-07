import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `../src/index.js` and `../src/actions.js` are the package's `.` and `./actions` exports.
import { validateActionParams } from "../src/actions.js";
import { POLL_DEFAULTS } from "../src/index.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

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
    for (const file of readdirSync(SRC)) {
      const source = readFileSync(join(SRC, file), "utf8");
      // Every import is type-only, and a re-export names a sibling file.
      for (const [, clause, specifier] of source.matchAll(/^(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)) {
        if (/^type\b/.test(clause!)) continue;
        expect(specifier, `${file}: ${clause}`).toMatch(/^\.\/[a-z]+\.js$/);
      }
      expect(source, file).not.toMatch(/\bprocess\b|\bBun\b|["']node:/);
    }
  });
});
