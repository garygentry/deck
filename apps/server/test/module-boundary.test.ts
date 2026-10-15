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
    expect(unverifiable).toEqual(["createRequire", "import()", "require()", ".require", "createRequire"]);
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
      "modules/bad/server/module-require.cjs .require",
      "modules/bad/server/template.ts import()",
      "modules/bad/server/variable.ts require()",
    ]);
    // An unverifiable load can never be allowlisted.
    const entry = { file: "modules/bad/server/variable.ts", specifier: UNVERIFIABLE, uses: ["require()"], reason: "x" };
    expect(checkModuleBoundary(repo, [entry]).violations).toHaveLength(5);
  });

  const K = "../../../apps/server/src/log/logger.js";
  // One fixture per loader form the guard cannot follow; each must be reported, unverifiable.
  const LOADER_FORMS: [string, string, string][] = [
    ["require as a value", "form.ts", `const r = require;\nexport const x = r("${K}");\n`],
    ["comma-call require", "form.ts", `export const x = (0, require)("${K}");\n`],
    ["require.call", "form.ts", `export const x = require.call(null, "${K}");\n`],
    ["require.resolve", "form.ts", `export const x = require.resolve("${K}");\n`],
    ["globalThis.require", "form.ts", `export const x = globalThis.require("${K}");\n`],
    ["import.meta.require", "form.ts", `export const x = import.meta.require("${K}");\n`],
    ["import.meta.resolve", "form.ts", `export const x = import.meta.resolve("${K}");\n`],
    ["import.meta.resolveSync", "form.ts", `export const x = import.meta.resolveSync("${K}");\n`],
    ["module.require", "form.cjs", `module.exports = module.require("${K}");\n`],
    ['module["require"]', "form.cjs", `module.exports = module["require"]("${K}");\n`],
    ["computed module access", "form.cjs", `const k = "req" + "uire";\nmodule.exports = module[k]("${K}");\n`],
    ["computed import.meta access", "form.ts", `const k = "require";\nexport const x = (import.meta as any)[k]("${K}");\n`],
    ["Module.createRequire", "form.ts", `import Module from "node:module";\nexport const r = Module.createRequire(import.meta.url);\n`],
    ['Module["createRequire"]', "form.ts", `import Module from "node:module";\nexport const r = Module["createRequire"](import.meta.url);\n`],
    ["computed node:module access", "form.ts", `import * as M from "module";\nconst k = "create" + "Require";\nexport const r = (M as any)[k](import.meta.url);\n`],
    ["destructured createRequire", "form.ts", `import Module from "node:module";\nconst { createRequire: mk } = Module;\nexport const r = mk(import.meta.url);\n`],
    ["createRequire imported under an alias", "form.ts", `import { createRequire as mk } from "node:module";\nexport const r = mk(import.meta.url);\n`],
    ["createRequire re-exported under an alias", "form.ts", `export { createRequire as mk } from "node:module";\n`],
    ["node:module re-exported wholesale", "form.ts", `export * from "node:module";\n`],
    ["createRequire re-exported locally", "form.ts", `import Module from "node:module";\nconst createRequire = Module.createRequire;\nexport { createRequire };\n`],
  ];

  it.each(LOADER_FORMS)("reports %s as unverifiable", (_, name, text) => {
    const repo = fixtureRepo({ [`modules/bad/server/${name}`]: text });
    const found = moduleBoundaryViolations(repo);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((v) => v.specifier === UNVERIFIABLE)).toBe(true);
    expect(checkModuleBoundary(repo, []).violations.length).toBe(found.length);
  });

  it("leaves ordinary members named like loaders' neighbours alone", () => {
    const source = [
      "export const meta = import.meta.url;",
      'export const exp = module["exports"];',
      "export const cfg = { require: true, resolve: 1 };",
      "export class C { require() {} }",
      "type R = typeof require;",
      'export const ok = require("./local.js");',
    ].join("\n");
    expect(runtimeImports(source).filter((i) => i.specifier === null)).toEqual([]);
  });

  it("reports a file symlinked into the kernel, whatever specifier names it", () => {
    const repo = fixtureRepo({
      "modules/bad/server/index.ts": 'import { logger } from "./k.js";\nexport { logger };\n',
    });
    symlinkSync(join(repo, "apps/server/src/log/logger.ts"), join(repo, "modules/bad/server/k.ts"));
    expect(moduleBoundaryViolations(repo)).toEqual([
      { file: "modules/bad/server/k.ts", specifier: "apps/server/src/log/logger.ts", use: "symlink" },
    ]);
  });

  it("reports a directory symlinked into the kernel and does not scan through it", () => {
    const repo = fixtureRepo({ "modules/bad/server/index.ts": 'export { logger } from "./kernel/logger.js";\n' });
    symlinkSync(join(repo, "apps/server/src/log"), join(repo, "modules/bad/server/kernel"), "dir");
    expect(moduleBoundaryViolations(repo)).toEqual([
      { file: "modules/bad/server/kernel", specifier: "apps/server/src/log", use: "symlink" },
      { file: "modules/bad/server/index.ts", specifier: "./kernel/logger.js", use: "export { logger }" },
    ]);
  });

  it("ignores a symlink that points elsewhere", () => {
    const repo = fixtureRepo({
      "modules/good/shared/util.ts": "export const u = 1;\n",
      "modules/good/server/index.ts": 'export { u } from "./util.js";\n',
    });
    symlinkSync(join(repo, "modules/good/shared/util.ts"), join(repo, "modules/good/server/util.ts"));
    expect(moduleBoundaryViolations(repo)).toEqual([]);
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
