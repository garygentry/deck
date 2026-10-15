import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `../src/index.js` is the package's `.` export.
import { POLL_DEFAULTS } from "../src/index.js";

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

  it("serves the kernel's UI contract (core slots and widget types) as plain JSON", async () => {
    const { CORE_WIDGET_TYPES, SHELL_SLOTS } = await import("../src/core.js");
    expect(JSON.parse(JSON.stringify(SHELL_SLOTS))).toEqual(SHELL_SLOTS);
    expect(JSON.parse(JSON.stringify(CORE_WIDGET_TYPES))).toEqual(CORE_WIDGET_TYPES);
  });

  it("holds no built-in module's contract (each lives in its module) and exports only kernel entries", () => {
    const manifest = JSON.parse(readFileSync(resolve(SRC, "../package.json"), "utf8")) as { exports: Record<string, string> };
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./core", "./widgets"]);
    expect(walk(SRC).map((path) => relative(SRC, path)).filter((file) => file.includes("/"))).toEqual([]);
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

describe("core/embed's url check", () => {
  const ACCEPTED = [
    "https://grafana.lab/d/ups?kiosk", "https://grafana.lab./", "http://my_grafana:3000/", "https://bücher.lab/",
    "http://[::1]:3000/", "http://10.0.0.5/", "https://h.lab:65535/#a", "https://wiki.lab/a@b",
  ];
  // Refused by the loose pattern (shape) or by the URL parser behind it.
  const REFUSED = [
    "https://999.1.1.1/", "http://x.123/", "https://[:::]/", "https://[1]/", "https://x:99999/", "https://%/", "https://?q",
    "http://:80/", "http://#a", "https://user:pw@h.lab/", "https://user@h.lab/", "https://\\evil.lab/", "//h.lab/x", "/hosts",
    "javascript:alert(1)", "data:text/html,x", "https://h.lab/a b", 42,
  ];

  it("is the schema library's one rule (the contract's options pattern equals it), then the URL parser", async () => {
    const { CORE_WIDGET_TYPE_SCHEMAS } = await import("../src/widgets.js");
    const { EMBED_URL_PATTERN, embedUrlProblem } = await import("@deck/schema/embed");
    const embedType = CORE_WIDGET_TYPE_SCHEMAS.find(({ type }) => type === "core/embed");
    expect((embedType?.optionsSchema as { properties: { url: { pattern: string } } }).properties.url.pattern).toBe(EMBED_URL_PATTERN);
    const pattern = new RegExp(EMBED_URL_PATTERN, "u");
    for (const url of ACCEPTED) {
      expect(embedUrlProblem(url), url).toBeNull();
      expect(pattern.test(url), url).toBe(true);
    }
    for (const url of REFUSED) expect(embedUrlProblem(url), String(url)).not.toBeNull();
  });
});
