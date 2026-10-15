import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWED_VIOLATIONS,
  checkModuleBoundary,
  moduleBoundaryViolations,
  runtimeImports,
  UNVERIFIABLE,
} from "../../../scripts/module-boundary.js";

const REPO_ROOT = resolve(__dirname, "../../..");

const specifiers = (source: string, fileName?: string) => runtimeImports(source, fileName).map((i) => i.specifier);

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
      { specifier: "./default.js", use: "import { default }" },
      { specifier: "./namespace.js", use: "import { * }" },
      { specifier: "./mixed.js", use: "import { value }" },
      { specifier: "./side-effect.js", use: "import" },
      { specifier: "./reexport.js", use: "export { thing }" },
      { specifier: "./star.js", use: "export *" },
      { specifier: "./import-equals.js", use: "import = require" },
      { specifier: "./dynamic.js", use: "import()" },
      { specifier: "./require.js", use: "require()" },
    ]);
  });

  it("drops the forms TypeScript erases and ambient augmentation", () => {
    // `import { type B }` is erased only while no tsconfig sets verbatimModuleSyntax; with it
    // set, TypeScript emits `import {} from "…"` and the module loads. Revisit this case (and
    // `importUse`) if that option is ever turned on.
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
      "declare global {",
      "  interface Window { deck: unknown }",
      "}",
    ].join("\n");
    expect(runtimeImports(source)).toEqual([]);
  });

  it("scans executable namespace bodies", () => {
    const source = [
      "export namespace LazyKernel {",
      '  export const load = () => import("./in-namespace.js");',
      '  export const sync = () => require("./required-in-namespace.js");',
      "  export namespace Inner {",
      '    export const deep = () => import("./nested-namespace.js");',
      "  }",
      "}",
    ].join("\n");
    expect(specifiers(source)).toEqual(["./in-namespace.js", "./required-in-namespace.js", "./nested-namespace.js"]);
  });

  it("reports loads it cannot read statically", () => {
    const source = [
      'import { createRequire } from "node:module";',
      "const dyn = (k: string) => import(`./${k}.js`);",
      "const req = (k: string) => require(k);",
      'const viaModule = () => module.require("./x.js");',
      "const made = createRequire(import.meta.url);",
    ].join("\n");
    const unverifiable = runtimeImports(source).filter((i) => i.specifier === null).map((i) => i.use);
    expect(unverifiable).toEqual(["createRequire", "import()", "require()", "module.require()", "createRequire"]);
    // An aliased import is caught at the import, since the call names only the alias.
    expect(runtimeImports('import { createRequire as cr } from "module";\nconst r = cr(import.meta.url);\n')).toContainEqual({
      specifier: null,
      use: "createRequire",
    });
    expect(runtimeImports('import type { createRequire } from "node:module";\n')).toEqual([]);
  });

  it("parses JavaScript sources", () => {
    expect(specifiers('export * from "./a.js";\nconst b = require("./b.cjs");\n', "shim.mjs")).toEqual(["./a.js", "./b.cjs"]);
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
      "apps/server/src/log/logger.ts": "export const logger = {};\n",
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
      { file: "modules/bad/server/alias.ts", specifier: "@deck/server", use: "import { X }" },
      { file: "modules/bad/server/index.ts", specifier: "../../../apps/server/src/server/settle.js", use: "import { settle }" },
      { file: "modules/bad/server/lazy.ts", specifier: "@deck/server/contract/index.js", use: "import()" },
      { file: "modules/bad/server/nested/deep.ts", specifier: "../../../../apps/server/src/contract/index.js", use: "export { X }" },
    ]);
    expect(checkModuleBoundary(repo, []).violations).toHaveLength(4);
  });

  it("catches loads inside an executable namespace", () => {
    const repo = fixtureRepo({
      "modules/bad/server/ns.ts": [
        "export namespace LazyKernel {",
        '  export const load = () => import("../../../apps/server/src/log/logger.js");',
        '  export const sync = () => require("../../../apps/server/src/contract/index.js");',
        "}",
      ].join("\n"),
    });
    expect(moduleBoundaryViolations(repo).map((v) => v.use)).toEqual(["import()", "require()"]);
  });

  it("fails closed on loads it cannot check, wherever they point", () => {
    const repo = fixtureRepo({
      "modules/bad/server/template.ts": "export const f = (k: string) => import(`../../../apps/server/src/${k}/logger.js`);\n",
      "modules/bad/server/variable.ts": "export const f = (k: string) => require(k);\n",
      "modules/bad/server/create-require.ts":
        'import { createRequire } from "node:module";\nexport const r = createRequire(import.meta.url);\n',
      "modules/bad/server/module-require.cjs": 'module.exports = module.require("./anything.cjs");\n',
    });
    const found = moduleBoundaryViolations(repo);
    expect(found.every((v) => v.specifier === UNVERIFIABLE)).toBe(true);
    expect(found.map((v) => `${v.file} ${v.use}`)).toEqual([
      "modules/bad/server/create-require.ts createRequire",
      "modules/bad/server/create-require.ts createRequire",
      "modules/bad/server/module-require.cjs module.require()",
      "modules/bad/server/template.ts import()",
      "modules/bad/server/variable.ts require()",
    ]);
    // An unverifiable load can never be allowlisted.
    const entry = { file: "modules/bad/server/variable.ts", specifier: UNVERIFIABLE, uses: ["require()"], reason: "x" };
    expect(checkModuleBoundary(repo, [entry]).violations).toHaveLength(5);
  });

  it("follows a symlinked path into the kernel", () => {
    const repo = fixtureRepo({
      "modules/bad/server/linked.ts": 'import { logger } from "../node_modules/@deck/server/src/log/logger.js";\n',
    });
    mkdirSync(join(repo, "modules/bad/node_modules/@deck"), { recursive: true });
    symlinkSync(join(repo, "apps/server"), join(repo, "modules/bad/node_modules/@deck/server"), "dir");
    expect(moduleBoundaryViolations(repo)).toEqual([
      {
        file: "modules/bad/server/linked.ts",
        specifier: "../node_modules/@deck/server/src/log/logger.js",
        use: "import { logger }",
      },
    ]);
  });

  it("scans JavaScript files in a server half", () => {
    const repo = fixtureRepo({
      "modules/bad/server/shim.mjs": 'export * from "../../../apps/server/src/log/logger.js";\n',
      "modules/bad/server/legacy.cjs": 'module.exports = require("../../../apps/server/src/contract/index.js");\n',
      "modules/bad/server/plain.js": 'import { X } from "@deck/server";\n',
    });
    expect(moduleBoundaryViolations(repo).map((v) => `${v.file} ${v.use}`)).toEqual([
      "modules/bad/server/legacy.cjs require()",
      "modules/bad/server/plain.js import { X }",
      "modules/bad/server/shim.mjs export *",
    ]);
  });

  it("allows type-only imports, augmentation, SDK imports and anything outside a server half", () => {
    const repo = fixtureRepo({
      "modules/good/server/index.ts": [
        'import type { Provider } from "../../../apps/server/src/contract/index.js";',
        // Erased only without verbatimModuleSyntax (see the runtimeImports case above).
        'import { type Logger } from "../../../apps/server/src/log/logger.js";',
        'export type { DeckConfig } from "@deck/server";',
        'import { settlesWithin } from "@deck/module-sdk";',
        'import { local } from "./local.js";',
        'declare module "../../../apps/server/src/contract/index.js" {',
        "  interface ModuleRegistry { good: true }",
        "}",
        'type Loader = typeof import("../../../apps/server/src/log/logger.js");',
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

  describe("allowlist", () => {
    const LOGGER = "../../../apps/server/src/log/logger.js";
    const entry = { file: "modules/debt/server/events.ts", specifier: LOGGER, uses: ["import { logger }"], reason: "debt" };

    it("covers a group whose uses match exactly", () => {
      const repo = fixtureRepo({ "modules/debt/server/events.ts": `import { logger } from "${LOGGER}";\n` });
      expect(checkModuleBoundary(repo, [entry])).toEqual({ violations: [], stale: [] });
    });

    it("fails when an allowlisted file adds a re-export of the same kernel file", () => {
      const repo = fixtureRepo({
        "modules/debt/server/events.ts": `import { logger } from "${LOGGER}";\nexport { logger } from "${LOGGER}";\n`,
      });
      expect(checkModuleBoundary(repo, [entry]).violations.map((v) => v.use)).toEqual([
        "import { logger }",
        "export { logger }",
      ]);
    });

    it("fails when an allowlisted import grows a name", () => {
      const repo = fixtureRepo({
        "modules/debt/server/events.ts": `import { logger, levels } from "${LOGGER}";\n`,
      });
      expect(checkModuleBoundary(repo, [entry]).violations).toHaveLength(1);
    });

    it("reports an entry that no longer matches, so a fixed debt leaves the list", () => {
      const repo = fixtureRepo({ "modules/debt/server/events.ts": "export const ok = 1;\n" });
      expect(checkModuleBoundary(repo, [entry])).toEqual({ violations: [], stale: [entry] });
    });
  });

  it("holds for the repo's module server halves (allowlist aside), with no stale allowlist entries", () => {
    const { violations, stale } = checkModuleBoundary(REPO_ROOT);
    expect(violations, "runtime import into apps/server/src from a module server half").toEqual([]);
    expect(stale, "allowlist entry that no longer matches; remove it").toEqual([]);
    for (const entry of ALLOWED_VIOLATIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.uses.length).toBeGreaterThan(0);
    }
  });
});
