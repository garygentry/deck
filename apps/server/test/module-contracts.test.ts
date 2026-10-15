import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import type { ProviderKindDecl } from "@deck/module-sdk";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_STATUS_KINDS } from "../../../modules/portal/status-kinds.js";
import { isPublicEntry, moduleReferenceNodes } from "../../../scripts/module-imports.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { REPO_ROOT } from "./util/source-roots.js";

/**
 * The files at a built-in module's root (`modules/<id>/<file>`, beside `server/` and `web/`): its
 * `contract.ts` and whatever else both halves share. The web bundle loads them, and a module's
 * server half loads them through `../contract.js` outside the module-boundary scan, so they must
 * stay data and plain functions with no server, kernel or other module code behind them.
 *
 * Every source extension counts (a declaration file excepted), so a `contract.tsx` or a
 * `helper.js` beside it is held to the same rules: the module-imports guard accepts `contract`
 * with any source extension as a public entry.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const isSource = (name: string): boolean => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !/\.d\.[cm]?ts$/.test(name);
const CONTRACT = /^contract\.[cm]?[jt]sx?$/;

/** Every module-root source file under `repo`, repo-relative and `/`-separated. */
function moduleRootFiles(repo: string): string[] {
  const modules = join(repo, "modules");
  if (!existsSync(modules)) return [];
  return readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(modules, entry.name), { withFileTypes: true })
        .filter((file) => file.isFile() && isSource(file.name))
        .map((file) => `modules/${entry.name}/${file.name}`),
    )
    .sort();
}

/** Packages a module-root file may load at runtime: the kernel's own contract entries. */
const RUNTIME_PACKAGES = new Set(["@deck/contract", "@deck/contract/core", "@deck/contract/widgets"]);
/** Packages it may name in types only (erased before the code runs). */
const TYPE_PACKAGES = /^@deck\/(?:module-sdk|schema)(?:\/[a-z0-9-]+)*$/;

/** The repo-relative file a relative specifier loads from `from`, if any. */
function resolveRelative(repo: string, from: string, specifier: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const swapped = base.endsWith(".mjs") ? [`${stem}.mts`] : base.endsWith(".cjs") ? [`${stem}.cts`] : /\.jsx?$/.test(base) ? [`${stem}.ts`, `${stem}.tsx`] : [];
  const candidates = [base, ...swapped, ...SOURCE_EXTENSIONS.map((ext) => base + ext), ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => existsSync(join(repo, candidate)) && statSync(join(repo, candidate)).isFile());
}

/** Whether the import or export declaration naming `node` is erased at runtime. */
function typeOnly(node: ts.Node | undefined, form: string): boolean {
  if (form === "import type()") return true;
  const declaration = node?.parent;
  if (declaration !== undefined && ts.isImportDeclaration(declaration)) {
    const clause = declaration.importClause;
    if (clause === undefined) return false; // a side-effect import runs the file
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  }
  if (declaration !== undefined && ts.isExportDeclaration(declaration)) {
    if (declaration.isTypeOnly) return true;
    const clause = declaration.exportClause;
    return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/** Names a module-root file may not reference, by why. */
const FORBIDDEN_NAMES = new Map([
  ["process", "a server-only global"],
  ["Bun", "a server-only global"],
  ["require", "a CommonJS loader"],
  ["module", "a CommonJS loader"],
  ["exports", "a CommonJS loader"],
]);

/** Whether `node` only names a property (`x.module`, `{ module: … }`), not a binding in scope. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) return (ts.isPropertyAccessExpression(parent) ? parent.name : parent.right) === node;
  if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return parent.propertyName === node;
  return (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)) &&
    parent.name === node
  );
}

/** Every edge from a module-root file that leaves the allowed set, as `<file>: <specifier> (<why>)`. */
function moduleRootProblems(repo: string): string[] {
  const roots = moduleRootFiles(repo);
  const rootSet = new Set(roots);
  const problems: string[] = [];
  for (const file of roots) {
    const source = readFileSync(join(repo, file), "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : file.endsWith("js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const owner = file.split("/")[1]!;
    for (const { specifier, form, node } of moduleReferenceNodes(parsed)) {
      const report = (why: string): void => void problems.push(`${file}: ${specifier ?? "<unverifiable>"} (${why})`);
      if (specifier === null) report(`a ${form} that cannot be read statically`);
      else if (form !== "import" && form !== "export" && form !== "import type()") report(`a ${form}`);
      else if (specifier.startsWith(".")) {
        const target = resolveRelative(repo, file, specifier);
        if (target === undefined || !rootSet.has(target)) report("not a module-root source file");
        else if (target.split("/")[1] !== owner && !CONTRACT.test(posix.basename(target))) report("another module's file other than its contract");
      } else if (RUNTIME_PACKAGES.has(specifier)) continue;
      else if (!TYPE_PACKAGES.test(specifier)) report("a package outside the kernel contract");
      else if (!typeOnly(node, form)) report("loaded at runtime; import its types only");
    }
    // Server-only globals and CommonJS loaders, by name or by a string key (`globalThis["process"]`),
    // anywhere in the code (comments are not code). A data-only file needs none of them, so any
    // reference counts, aliased loaders (`const r = module.require`) included.
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text) && !isPropertyName(node)) {
        problems.push(`${file}: ${node.text} (${FORBIDDEN_NAMES.get(node.text)})`);
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && FORBIDDEN_NAMES.has(node.argumentExpression.text)) {
        problems.push(`${file}: ["${node.argumentExpression.text}"] (${FORBIDDEN_NAMES.get(node.argumentExpression.text)})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return problems;
}

const ROOTS = moduleRootFiles(REPO_ROOT);
const CONTRACTS = ROOTS.filter((path) => CONTRACT.test(posix.basename(path)));

describe("built-in modules' shared files", () => {
  it("are found", () => {
    expect(CONTRACTS).toEqual(expect.arrayContaining(["modules/llm-usage/contract.ts", "modules/portal/contract.ts", "modules/docker/contract.ts", "modules/snapshot/contract.ts"]));
    expect(ROOTS).toEqual(expect.arrayContaining(["modules/actions/params.ts", "modules/portal/status-kinds.ts"]));
  });

  it("load only types, their own module's shared files, other modules' contracts and the kernel contract", () => {
    expect(moduleRootProblems(REPO_ROOT)).toEqual([]);
  });

  it.each(CONTRACTS)("%s exports plain JSON", async (path) => {
    const exports = (await import(pathToFileURL(join(REPO_ROOT, path)).href)) as Record<string, unknown>;
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

describe("the built-in status kinds", () => {
  it.each(BUILTIN_STATUS_KINDS.map((kind) => [kind.kind, kind] as const))("%s matches its module's providerKinds entry", (_, statusKind) => {
    const module = BUILTIN_MODULES.find(({ manifest }) => manifest.id === statusKind.module);
    expect(module, statusKind.module).toBeDefined();
    const decl = module!.manifest.providerKinds?.find(({ kind }) => kind === statusKind.kind) as ProviderKindDecl | undefined;
    expect(decl).toMatchObject({ bindable: true, statusCapable: true });
    expect({ kind: decl!.kind, module: module!.manifest.id, ...(decl!.fixedId === undefined ? {} : { fixedId: decl!.fixedId }), status: decl!.status }).toEqual(statusKind);
  });
});

describe("the module-root scan (planted files)", () => {
  let fixture: string | undefined;
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  function repoWith(files: Record<string, string>): string {
    fixture = mkdtempSync(join(tmpdir(), "module-roots-"));
    const all: Record<string, string> = {
      "modules/owner/contract.ts": "export const SHARED = 1;\n",
      "modules/owner/server/index.ts": "export const server = 1;\n",
      "apps/server/src/log/logger.ts": "export const logger = 1;\n",
      ...files,
    };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(fixture, dirname(path)), { recursive: true });
      writeFileSync(join(fixture, path), text);
    }
    return fixture;
  }

  it("accepts types, siblings, other modules' contracts and the kernel contract", () => {
    const repo = repoWith({
      "modules/user/contract.ts": [
        'import type { WebModuleManifest } from "@deck/module-sdk";',
        'import { type Finding } from "@deck/schema";',
        'import { POLL_DEFAULTS } from "@deck/contract";',
        'import { SHELL_SLOTS } from "@deck/contract/core";',
        'import { SHARED } from "../owner/contract.js";',
        'export { helper } from "./helper.js";',
        'export type { Thing } from "./things.js";',
        "export const ui: WebModuleManifest | Finding | undefined = undefined;",
        "",
      ].join("\n"),
      "modules/user/helper.ts": "export const helper = 1;\n",
      "modules/user/things.ts": "export type Thing = 1;\n",
    });
    expect(moduleRootProblems(repo)).toEqual([]);
  });

  it("catches a side-effect import", () => {
    const repo = repoWith({ "modules/user/contract.ts": 'import "../../apps/server/src/log/logger.js";\nexport const A = 1;\n' });
    expect(moduleRootProblems(repo)).toEqual(["modules/user/contract.ts: ../../apps/server/src/log/logger.js (not a module-root source file)"]);
  });

  it("catches an indented import", () => {
    const repo = repoWith({ "modules/user/contract.ts": '   import { server } from "./server/index.js";\nexport const A = server;\n', "modules/user/server/index.ts": "export const server = 1;\n" });
    expect(moduleRootProblems(repo)).toEqual(["modules/user/contract.ts: ./server/index.js (not a module-root source file)"]);
  });

  it("catches a side-effect import followed by a normal one, without folding them together", () => {
    const repo = repoWith({
      "modules/user/contract.ts": 'import "./server/boot.js";\nimport { B } from "./b.js";\nexport const A = B;\n',
      "modules/user/server/boot.ts": "export {};\n",
      "modules/user/b.ts": "export const B = 1;\n",
    });
    expect(moduleRootProblems(repo)).toEqual(["modules/user/contract.ts: ./server/boot.js (not a module-root source file)"]);
  });

  it("follows a ./helper.js sibling that is JavaScript, and holds it to the same rules", () => {
    const repo = repoWith({
      "modules/user/contract.ts": 'export { helper } from "./helper.js";\n',
      "modules/user/helper.js": 'import "../../apps/server/src/log/logger.js";\nexport const helper = 1;\n',
    });
    expect(moduleRootFiles(repo)).toContain("modules/user/helper.js");
    expect(moduleRootProblems(repo)).toEqual(["modules/user/helper.js: ../../apps/server/src/log/logger.js (not a module-root source file)"]);
  });

  it("catches a sibling that is no source file (a declaration or JSON)", () => {
    const repo = repoWith({
      "modules/user/contract.ts": 'export type { T } from "./types.js";\nexport { default as data } from "./data.json";\n',
      "modules/user/types.d.ts": "export type T = 1;\n",
      "modules/user/data.json": "{}\n",
    });
    expect(moduleRootProblems(repo)).toEqual([
      "modules/user/contract.ts: ./types.js (not a module-root source file)",
      "modules/user/contract.ts: ./data.json (not a module-root source file)",
    ]);
  });

  it("catches another module's internals, a runtime SDK import, other packages, dynamic loads and server globals", () => {
    const repo = repoWith({
      "modules/user/contract.ts": [
        'import { server } from "../owner/server/index.js";',
        'import { defineWebModule } from "@deck/module-sdk";',
        'import { validate } from "@deck/schema";',
        'import { z } from "zod";',
        'const later = import("./later.js");',
        "export const env = process.env.X ?? Bun;",
        "",
      ].join("\n"),
      "modules/user/later.ts": "export {};\n",
    });
    expect(moduleRootProblems(repo)).toEqual([
      "modules/user/contract.ts: ../owner/server/index.js (not a module-root source file)",
      "modules/user/contract.ts: @deck/module-sdk (loaded at runtime; import its types only)",
      "modules/user/contract.ts: @deck/schema (loaded at runtime; import its types only)",
      "modules/user/contract.ts: zod (a package outside the kernel contract)",
      "modules/user/contract.ts: ./later.js (a import())",
      "modules/user/contract.ts: process (a server-only global)",
      "modules/user/contract.ts: Bun (a server-only global)",
    ]);
  });

  it("catches CommonJS loaders, by name, by bracket and aliased, and a property named module is fine", () => {
    const repo = repoWith({
      "modules/user/contract.ts": 'export { h } from "./helper.cjs";\nexport const KIND = { module: "user" };\nexport const id = KIND.module;\n',
      "modules/user/helper.cjs": 'const h = module.require("../../apps/server/src/log/logger.js");\n',
      "modules/user/bracket.ts": 'export const b = module["require"]("x");\n',
      "modules/user/aliased.ts": "const r = module.require;\nexport const a = r(\"x\");\n",
      "modules/user/plain.js": 'exports.p = require("x");\n',
    });
    expect(moduleRootProblems(repo)).toEqual([
      "modules/user/aliased.ts: module (a CommonJS loader)",
      'modules/user/bracket.ts: ["require"] (a CommonJS loader)',
      "modules/user/bracket.ts: module (a CommonJS loader)",
      "modules/user/helper.cjs: module (a CommonJS loader)",
      "modules/user/plain.js: x (a require())",
      "modules/user/plain.js: exports (a CommonJS loader)",
      "modules/user/plain.js: require (a CommonJS loader)",
    ]);
  });

  it("catches a server global read by a string key", () => {
    const repo = repoWith({
      "modules/user/contract.ts": [
        'export const a = globalThis["process"];',
        'export const b = (globalThis as any)["Bun"];',
        "export const c = self['process'];",
        "",
      ].join("\n"),
    });
    expect(moduleRootProblems(repo)).toEqual([
      'modules/user/contract.ts: ["process"] (a server-only global)',
      'modules/user/contract.ts: ["Bun"] (a server-only global)',
      'modules/user/contract.ts: ["process"] (a server-only global)',
    ]);
  });

  it.each(SOURCE_EXTENSIONS)("collects a contract%s, which the module-imports guard accepts as a public entry", (ext) => {
    expect(isPublicEntry(`contract${ext}`)).toBe(true);
    const repo = repoWith({ [`modules/user/contract${ext}`]: "export const A = 1;\n" });
    expect(moduleRootFiles(repo)).toContain(`modules/user/contract${ext}`);
  });

  it("skips a declaration file", () => {
    const repo = repoWith({ "modules/user/contract.d.ts": "export declare const A: 1;\n" });
    expect(moduleRootFiles(repo)).not.toContain("modules/user/contract.d.ts");
  });
});
