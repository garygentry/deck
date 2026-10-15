import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWED_VIOLATIONS,
  checkModuleBoundary,
  moduleBoundaryViolations,
  runtimeImports,
} from "../../../scripts/module-boundary.js";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("runtimeImports", () => {
  it("keeps value imports, side-effect imports, re-exports, dynamic imports and require", () => {
    const source = [
      'import a from "./default.js";',
      'import * as ns from "./namespace.js";',
      'import { value, type T } from "./mixed.js";',
      'import "./side-effect.js";',
      'export { thing } from "./reexport.js";',
      'export * from "./star.js";',
      'import eq = require("./import-equals.js");',
      'const lazy = () => import("./dynamic.js");',
      'const cjs = require("./require.js");',
    ].join("\n");
    expect(runtimeImports(source)).toEqual([
      "./default.js",
      "./namespace.js",
      "./mixed.js",
      "./side-effect.js",
      "./reexport.js",
      "./star.js",
      "./import-equals.js",
      "./dynamic.js",
      "./require.js",
    ]);
  });

  it("drops the forms TypeScript erases and module augmentation", () => {
    const source = [
      'import type { A } from "./type-import.js";',
      'import { type B, type C } from "./inline-types.js";',
      'export type { D } from "./type-export.js";',
      'export { type E } from "./inline-type-export.js";',
      'type F = typeof import("./type-query.js");',
      'declare module "./augmented.js" {',
      '  import type { G } from "./inside-augmentation.js";',
      "  interface Registry { g: G }",
      "}",
    ].join("\n");
    expect(runtimeImports(source)).toEqual([]);
  });
});

describe("module server halves never load kernel internals at runtime", () => {
  let fixture: string | undefined;
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  /** A throwaway repo with a kernel package and one module server half per file given. */
  function fixtureRepo(files: Record<string, string>): string {
    fixture = mkdtempSync(join(tmpdir(), "module-boundary-"));
    const all: Record<string, string> = {
      "apps/server/package.json": JSON.stringify({ name: "@deck/server", exports: { ".": "./src/contract/index.ts" } }),
      "apps/server/src/contract/index.ts": "export const X = 1;\n",
      ...files,
    };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(fixture, dirname(path)), { recursive: true });
      writeFileSync(join(fixture, path), text);
    }
    return fixture;
  }

  it("catches a planted runtime import, by relative path and by package name", () => {
    const repo = fixtureRepo({
      "modules/bad/server/index.ts": 'import { settle } from "../../../apps/server/src/server/settle.js";\n',
      "modules/bad/server/nested/deep.ts": 'export { X } from "../../../../apps/server/src/contract/index.js";\n',
      "modules/bad/server/alias.ts": 'import { X } from "@deck/server";\n',
      "modules/bad/server/lazy.ts": 'export const load = () => import("@deck/server/contract/index.js");\n',
    });
    expect(moduleBoundaryViolations(repo)).toEqual([
      { file: "modules/bad/server/alias.ts", specifier: "@deck/server" },
      { file: "modules/bad/server/index.ts", specifier: "../../../apps/server/src/server/settle.js" },
      { file: "modules/bad/server/lazy.ts", specifier: "@deck/server/contract/index.js" },
      { file: "modules/bad/server/nested/deep.ts", specifier: "../../../../apps/server/src/contract/index.js" },
    ]);
    expect(checkModuleBoundary(repo, []).violations).toHaveLength(4);
  });

  it("allows type-only imports, augmentation, SDK imports and anything outside a server half", () => {
    const repo = fixtureRepo({
      "modules/good/server/index.ts": [
        'import type { Provider } from "../../../apps/server/src/contract/index.js";',
        'import { type Logger } from "../../../apps/server/src/log/logger.js";',
        'export type { DeckConfig } from "@deck/server";',
        'import { settlesWithin } from "@deck/module-sdk";',
        'import { local } from "./local.js";',
        'declare module "../../../apps/server/src/contract/index.js" {',
        "  interface ModuleRegistry { good: true }",
        "}",
      ].join("\n"),
      "modules/good/server/local.ts": "export const local = 1;\n",
      // A web half and a module's own tests are out of this guard's scope.
      "modules/good/web/index.ts": 'import { X } from "@deck/server";\n',
      "modules/good/test/server/x.test.ts": 'import { X } from "../../../../apps/server/src/contract/index.js";\n',
      // A sibling directory whose name merely starts like the kernel's is not the kernel.
      "modules/good/server/near.ts": 'import { Y } from "../../../apps/server/src-extra/y.js";\n',
    });
    expect(moduleBoundaryViolations(repo)).toEqual([]);
  });

  it("reports an allowlist entry that no longer matches, so a fixed debt leaves the list", () => {
    const repo = fixtureRepo({ "modules/clean/server/index.ts": "export const ok = 1;\n" });
    const stale = { file: "modules/clean/server/index.ts", specifier: "../../../apps/server/src/log/logger.js" };
    expect(checkModuleBoundary(repo, [stale])).toEqual({ violations: [], stale: [stale] });
  });

  it("holds for the repo's module server halves (allowlist aside), with no stale allowlist entries", () => {
    const { violations, stale } = checkModuleBoundary(REPO_ROOT);
    expect(violations, "runtime import into apps/server/src from a module server half").toEqual([]);
    expect(stale, "allowlist entry that no longer matches; remove it").toEqual([]);
    for (const entry of ALLOWED_VIOLATIONS) expect(entry.reason.length).toBeGreaterThan(0);
  });
});
