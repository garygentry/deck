import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isPublicEntry, moduleImportViolations, moduleReferences, moduleSpecifiers, UNVERIFIABLE } from "../../../scripts/module-imports.js";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("moduleSpecifiers", () => {
  it("collects every form that names a module, type-only ones included", () => {
    const source = [
      'import a from "./default.js";',
      'import type { T } from "./type-import.js";',
      'export { thing } from "./reexport.js";',
      'export type { U } from "./type-reexport.js";',
      'import eq = require("./import-equals.js");',
      'const lazy = () => import("./dynamic.js");',
      'const cjs = require("./require.js");',
      'type Q = typeof import("./type-query.js");',
      'declare module "./augmented.js" { interface R { r: 1 } }',
      'vi.mock("./mocked.js");',
      'const real = await vi.importActual("./actual.js");',
      'const ignored = other.mock("./not-vi.js");',
    ].join("\n");
    expect(moduleSpecifiers(source)).toEqual([
      "./default.js",
      "./type-import.js",
      "./reexport.js",
      "./type-reexport.js",
      "./import-equals.js",
      "./dynamic.js",
      "./require.js",
      "./type-query.js",
      "./augmented.js",
      "./mocked.js",
      "./actual.js",
    ]);
  });
});

describe("moduleReferences", () => {
  it("walks globs, createRequire, triple-slash references and vitest under any name", () => {
    const source = [
      '/// <reference path="../../owner/web/model.ts" />',
      '/// <reference types="@deck/module-owner" />',
      'import { vi as v, vitest } from "vitest";',
      'import { createRequire } from "node:module";',
      'const one = import.meta.glob("../../owner/web/*.ts", { eager: true });',
      'const many = import.meta.glob(["../../owner/web/a.ts", "!../../owner/web/b.ts"]);',
      'const direct = createRequire(import.meta.url)("../../owner/direct.js");',
      "const req = createRequire(import.meta.url);",
      'const bound = req("../../owner/bound.js");',
      'const where = req.resolve("../../owner/resolved.js");',
      'v.mock("../../owner/aliased-vi.js");',
      'vitest.doMock("../../owner/vitest.js");',
    ].join("\n");
    expect(moduleReferences(source).map(({ specifier, form }) => `${form} ${specifier}`)).toEqual([
      "reference path ../../owner/web/model.ts",
      "reference types @deck/module-owner",
      "import vitest",
      "import node:module",
      "import.meta.glob ../../owner/web/*.ts",
      "import.meta.glob ../../owner/web/a.ts",
      "import.meta.glob !../../owner/web/b.ts",
      "createRequire ../../owner/direct.js",
      "createRequire ../../owner/bound.js",
      "require.resolve ../../owner/resolved.js",
      "vi.mock ../../owner/aliased-vi.js",
      "vi.doMock ../../owner/vitest.js",
    ]);
  });

  it("reports loads it cannot read statically as null", () => {
    const source = [
      'const a = import("../../owner/web/" + "model.js");',
      "const b = import(`../../owner/web/${name}.js`);",
      "const c = require(name);",
      "const d = import.meta.glob(patterns);",
      'const e = import.meta.glob(["../../owner/web/a.ts", pattern]);',
      "vi.mock(name);",
    ].join("\n");
    expect(moduleReferences(source).map(({ specifier, form }) => `${form} ${specifier}`)).toEqual([
      "import() null",
      "import() null",
      "require() null",
      "import.meta.glob null",
      "import.meta.glob ../../owner/web/a.ts",
      "import.meta.glob null",
      "vi.mock null",
    ]);
  });

  it("reads vitest loaders by bracket, and import.meta.resolve", () => {
    const source = [
      'vi["doMock"]("../../owner/bracket.js");',
      "vitest['unmock']('../../owner/quoted.js');",
      'vi["fn"]("../../owner/not-a-loader.js");',
      'vi[key]("../../owner/unknown-key.js");',
      'const where = import.meta.resolve("../../owner/resolved.js");',
    ].join("\n");
    expect(moduleReferences(source).map(({ specifier, form }) => `${form} ${specifier}`)).toEqual([
      "vi.doMock ../../owner/bracket.js",
      "vi.unmock ../../owner/quoted.js",
      "vi[…] null",
      "import.meta.resolve ../../owner/resolved.js",
    ]);
  });
});

describe("isPublicEntry", () => {
  it.each(["web/public.js", "web/public.ts", "web/public", "server/public.js"])("accepts %s", (path) => {
    expect(isPublicEntry(path)).toBe(true);
  });
  it.each(["", "web/model.js", "web/public/index.js", "public.js", "test/web/public.js", "web/components/public.js"])(
    "rejects %s",
    (path) => {
      expect(isPublicEntry(path)).toBe(false);
    },
  );
});

describe("cross-module imports go through a public entry and a declared dependency", () => {
  let fixture: string | undefined;
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  /** A throwaway repo: `owner` exposes a public web entry; `user` depends on it as `deps` says. */
  function fixtureRepo(files: Record<string, string>, deps: Record<string, string> = { "@deck/module-owner": "workspace:*" }): string {
    fixture = mkdtempSync(join(tmpdir(), "module-imports-"));
    const all: Record<string, string> = {
      "modules/owner/package.json": JSON.stringify({ name: "@deck/module-owner" }),
      "modules/owner/web/public.ts": 'export { model } from "./model.js";\n',
      "modules/owner/web/model.ts": "export const model = 1;\n",
      "modules/owner/server/public.ts": "export const serverThing = 1;\n",
      "modules/user/package.json": JSON.stringify({ name: "@deck/module-user", dependencies: deps }),
      ...files,
    };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(fixture, dirname(path)), { recursive: true });
      writeFileSync(join(fixture, path), text);
    }
    return fixture;
  }

  it("allows imports of a declared module's public entries, and a module's own files", () => {
    const repo = fixtureRepo({
      "modules/user/web/a.ts": 'import { model } from "../../owner/web/public.js";\nimport { b } from "./b.js";\n',
      "modules/user/web/b.ts": 'export const b = 1;\nexport type { X } from "../../owner/server/public.js";\n',
      "modules/user/test/web/a.test.ts": 'import { model } from "../../../owner/web/public.js";\nimport { b } from "../../web/b.js";\n',
      "modules/owner/web/consumer.ts": 'import { model } from "./model.js";\n',
    });
    expect(moduleImportViolations(repo)).toEqual([]);
  });

  it("catches a planted deep import, type-only, from a test, by package name and through vi.mock", () => {
    const repo = fixtureRepo({
      "modules/user/web/deep.ts": 'import { model } from "../../owner/web/model.js";\n',
      "modules/user/web/types.ts": 'import type { Model } from "../../owner/web/model.js";\n',
      "modules/user/web/package-path.ts": 'import { model } from "@deck/module-owner/web/model.js";\n',
      "modules/user/web/package-root.ts": 'import * as owner from "@deck/module-owner";\n',
      "modules/user/test/web/mocked.test.ts": 'vi.mock("../../../owner/web/model.js");\n',
    });
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/test/web/mocked.test.ts", specifier: "../../../owner/web/model.js", target: "owner", problem: "not-public" },
      { file: "modules/user/web/deep.ts", specifier: "../../owner/web/model.js", target: "owner", problem: "not-public" },
      { file: "modules/user/web/package-path.ts", specifier: "@deck/module-owner/web/model.js", target: "owner", problem: "not-public" },
      { file: "modules/user/web/package-root.ts", specifier: "@deck/module-owner", target: "owner", problem: "not-public" },
      { file: "modules/user/web/types.ts", specifier: "../../owner/web/model.js", target: "owner", problem: "not-public" },
    ]);
  });

  it("allows the public entry by package name", () => {
    const repo = fixtureRepo({ "modules/user/web/a.ts": 'import { model } from "@deck/module-owner/web/public.js";\n' });
    expect(moduleImportViolations(repo)).toEqual([]);
  });

  it("catches an import of a public entry the importer does not declare", () => {
    const repo = fixtureRepo({ "modules/user/web/a.ts": 'import { model } from "../../owner/web/public.js";\n' }, {});
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/web/a.ts", specifier: "../../owner/web/public.js", target: "owner", problem: "undeclared" },
    ]);
  });

  it("counts a dev or peer dependency as declared", () => {
    for (const field of ["devDependencies", "peerDependencies"]) {
      const repo = fixtureRepo({
        "modules/user/package.json": JSON.stringify({ name: "@deck/module-user", [field]: { "@deck/module-owner": "workspace:*" } }),
        "modules/user/test/a.test.ts": 'import { model } from "../../owner/web/public.js";\n',
      });
      expect(moduleImportViolations(repo)).toEqual([]);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("follows a symlink into another module", () => {
    const repo = fixtureRepo({});
    mkdirSync(join(repo, "modules/user/web"), { recursive: true });
    symlinkSync(join(repo, "modules/owner/web"), join(repo, "modules/user/web/linked"), "dir");
    writeFileSync(join(repo, "modules/user/web/a.ts"), 'import { model } from "./linked/model.js";\n');
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/web/a.ts", specifier: "./linked/model.js", target: "owner", problem: "not-public" },
    ]);
  });

  it("follows a symlinked file into another module, imported by its .js name", () => {
    const repo = fixtureRepo({}, {});
    mkdirSync(join(repo, "modules/user/web"), { recursive: true });
    symlinkSync(join(repo, "modules/owner/web/model.ts"), join(repo, "modules/user/web/linked.ts"), "file");
    writeFileSync(join(repo, "modules/user/web/a.ts"), 'import { model } from "./linked.js";\n');
    writeFileSync(join(repo, "modules/user/web/b.ts"), 'import { model } from "./linked";\n');
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/web/a.ts", specifier: "./linked.js", target: "owner", problem: "not-public" },
      { file: "modules/user/web/a.ts", specifier: "./linked.js", target: "owner", problem: "undeclared" },
      { file: "modules/user/web/b.ts", specifier: "./linked", target: "owner", problem: "not-public" },
      { file: "modules/user/web/b.ts", specifier: "./linked", target: "owner", problem: "undeclared" },
    ]);
  });

  it("catches globs, createRequire, triple-slash references and vitest.mock into another module", () => {
    const repo = fixtureRepo({
      "modules/user/web/glob.ts": 'export const all = import.meta.glob("../../owner/web/*.ts", { eager: true });\n',
      "modules/user/web/glob-array.ts": 'export const some = import.meta.glob(["../../owner/web/model.ts"]);\n',
      "modules/user/web/glob-public.ts": 'export const ok = import.meta.glob("../../owner/web/public.ts");\n',
      "modules/user/web/glob-empty.ts": 'export const none = import.meta.glob("../../owner/nothing-yet/*.ts");\n',
      "modules/user/server/req.ts": [
        'import { createRequire } from "node:module";',
        'export const direct = createRequire(import.meta.url)("../../owner/web/model.js");',
      ].join("\n"),
      "modules/user/web/ref.ts": '/// <reference path="../../owner/web/model.ts" />\nexport {};\n',
      "modules/user/test/web/vitest.test.ts": 'import { vitest } from "vitest";\nvitest.mock("../../../owner/web/model.js");\n',
      "modules/user/test/web/namespace.test.ts": 'import * as V from "vitest";\nV.vi.mock("../../../owner/web/model.js");\nV.vitest.doMock("../../../owner/web/public.js");\n',
    });
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/server/req.ts", specifier: "../../owner/web/model.js", target: "owner", problem: "not-public" },
      { file: "modules/user/test/web/namespace.test.ts", specifier: "../../../owner/web/model.js", target: "owner", problem: "not-public" },
      { file: "modules/user/test/web/vitest.test.ts", specifier: "../../../owner/web/model.js", target: "owner", problem: "not-public" },
      // The pattern's directory counts as well as each file it matches.
      { file: "modules/user/web/glob-array.ts", specifier: "../../owner/web/model.ts", target: "owner", problem: "not-public" },
      { file: "modules/user/web/glob-empty.ts", specifier: "../../owner/nothing-yet/*.ts", target: "owner", problem: "not-public" },
      { file: "modules/user/web/glob.ts", specifier: "../../owner/web/*.ts", target: "owner", problem: "not-public" },
      { file: "modules/user/web/ref.ts", specifier: "../../owner/web/model.ts", target: "owner", problem: "not-public" },
    ]);
  });

  it("reports a load it cannot read statically", () => {
    const repo = fixtureRepo({
      "modules/user/web/lazy.ts": 'export const load = (name: string) => import("../../owner/web/" + name);\n',
      "modules/user/web/glob.ts": "export const load = (p: string) => import.meta.glob(p);\n",
    });
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/web/glob.ts", specifier: UNVERIFIABLE, target: null, problem: "unverifiable" },
      { file: "modules/user/web/lazy.ts", specifier: UNVERIFIABLE, target: null, problem: "unverifiable" },
    ]);
  });

  it("resolves app path aliases, and counts a shared test helper's edges as the importer's", () => {
    const tsconfig = JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"], "@web-test/*": ["test/*"] } } });
    const repo = fixtureRepo(
      {
        "apps/web/tsconfig.json": `// comments are allowed\n${tsconfig}`,
        "apps/web/src/registry/registry.ts": 'export * from "../../../../modules/owner/web/model.js";\n',
        "apps/web/test/support/render.ts": "export const mount = 1;\n",
        "apps/web/test/harness.ts": 'import { mount } from "./support/render.js";\nexport { model } from "../../../modules/owner/web/model.js";\n',
        "apps/web/test/clean-harness.ts": 'export { model } from "../../../modules/owner/web/public.js";\n',
        "modules/user/test/web/a.test.ts": 'import { model } from "@web-test/harness.js";\nimport { mount } from "@web-test/support/render.js";\n',
        "modules/user/test/web/b.test.ts": 'import { model } from "@web-test/clean-harness.js";\n',
        // The kernel's own sources are not followed, even when one re-exports another module's
        // internals: they legitimately load modules (a known, deliberate limit).
        "modules/user/web/kernel.ts": 'import { r } from "@/registry/registry.js";\n',
        "modules/user/web/alias-deep.ts": 'import { m } from "@/../../../modules/owner/web/model.js";\n',
      },
      {},
    );
    expect(moduleImportViolations(repo)).toEqual([
      { file: "modules/user/test/web/a.test.ts", via: "apps/web/test/harness.ts", specifier: "@web-test/harness.js", target: "owner", problem: "not-public" },
      { file: "modules/user/test/web/a.test.ts", via: "apps/web/test/harness.ts", specifier: "@web-test/harness.js", target: "owner", problem: "undeclared" },
      { file: "modules/user/test/web/b.test.ts", via: "apps/web/test/clean-harness.ts", specifier: "@web-test/clean-harness.js", target: "owner", problem: "undeclared" },
      { file: "modules/user/web/alias-deep.ts", specifier: "@/../../../modules/owner/web/model.js", target: "owner", problem: "not-public" },
      { file: "modules/user/web/alias-deep.ts", specifier: "@/../../../modules/owner/web/model.js", target: "owner", problem: "undeclared" },
    ]);
  });

  it("ignores imports that land outside modules/", () => {
    const repo = fixtureRepo(
      {
        "apps/web/src/registry/registry.ts": "export const r = 1;\n",
        "modules/user/web/a.ts": 'import { r } from "../../../apps/web/src/registry/registry.js";\nimport { x } from "@deck/contract";\n',
      },
      {},
    );
    expect(moduleImportViolations(repo)).toEqual([]);
  });

  it("holds for the repo's built-in modules", () => {
    expect(moduleImportViolations(REPO_ROOT), "cross-module import past a public entry, or undeclared").toEqual([]);
  });
});
