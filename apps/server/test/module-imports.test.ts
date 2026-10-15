import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isPublicEntry, moduleImportViolations, moduleSpecifiers } from "../../../scripts/module-imports.js";

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
