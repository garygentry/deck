#!/usr/bin/env bun
// List the imports one built-in module makes into another that skip its public entry or its
// declared dependencies.
//
// A built-in module (modules/<id>/) is one workspace package. Another module may use only what
// it exports from its public entry, `web/public.ts` for its web half or `server/public.ts` for
// its server half, and the importing module declares the edge as a dependency on the other's
// package (`@deck/module-<id>`) in its package.json. Its manifest `dependsOn` is a separate,
// runtime choice: it is added when the importer cannot run without the other module.
//
// Every form that ties one file to another counts, type-only ones included (a type is coupling
// too): imports and re-exports, `import x = require(…)`, `import()` and `require()` with a
// literal, `import("…")` types, `declare module "…"` augmentation and vitest's `vi.mock`-style
// calls. A specifier reaches another module by relative path, through a symlink, or by its
// package name.
//
// Usage:
//   bun scripts/module-imports.ts          # prints each violation; exits 1 when there are any

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

/** The files of a module that other modules may import, relative to its directory, without extension. */
export const PUBLIC_ENTRIES: readonly string[] = ["web/public", "server/public"];

/** One import from a module into another that breaks the rule. */
export interface CrossModuleViolation {
  /** Repo-relative path of the importing file, `/`-separated. */
  file: string;
  /** The specifier as written. */
  specifier: string;
  /** The module imported from. */
  target: string;
  /** `not-public`: it names a file other than the target's public entry; `undeclared`: the importer's package.json does not depend on the target. */
  problem: "not-public" | "undeclared";
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** vitest calls that load or replace a module by specifier. */
const VI_LOADERS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/** Every specifier `source` names a module by, type-only ones included, in source order. */
export function moduleSpecifiers(source: string, fileName = "module.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteral(node.moduleReference.expression)) found.push(node.moduleReference.expression.text);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      found.push(node.name.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** `import(…)`, `require(…)` or `vi.mock(…)` and its siblings. */
function isLoaderCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "vi" &&
    VI_LOADERS.has(callee.name.text)
  );
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface ModulePackage {
  id: string;
  /** Absolute path of `modules/<id>`, with symlinks resolved. */
  dir: string;
  name: string;
  /** Every package it depends on (dependencies, peer and dev dependencies). */
  declared: ReadonlySet<string>;
}

/** Each `modules/<id>` directory of `repoRoot` that has a package.json. */
function modulePackages(repoRoot: string): ModulePackage[] {
  const modulesDir = join(repoRoot, "modules");
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir)
    .sort()
    .filter((id) => existsSync(join(modulesDir, id, "package.json")))
    .map((id) => {
      const dir = join(modulesDir, id);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies }));
      return { id, dir: realpathDeep(dir), name: pkg.name ?? `@deck/module-${id}`, declared };
    });
}

/** Every source file under `dir`, skipping node_modules (symlinked directories are not followed). */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if ((entry.isFile() || (entry.isSymbolicLink() && existsSync(path) && statSync(path).isFile())) && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push(path);
      }
    }
  };
  walk(dir);
  return files.sort();
}

/**
 * The module a specifier lands in and the path inside it (`/`-separated, extension kept), or
 * null when it lands in no module.
 */
function targetOf(specifier: string, fromFile: string, modules: readonly ModulePackage[]): { module: ModulePackage; path: string } | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const target = realpathDeep(resolve(dirname(fromFile), specifier));
    for (const module of modules) {
      const rel = relative(module.dir, target);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return { module, path: rel.split(sep).join("/") };
    }
    return null;
  }
  for (const module of modules) {
    if (specifier === module.name) return { module, path: "" };
    if (specifier.startsWith(`${module.name}/`)) return { module, path: specifier.slice(module.name.length + 1) };
  }
  return null;
}

/** Whether `path` (inside a module) names one of its public entries. */
export function isPublicEntry(path: string): boolean {
  const ext = SOURCE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  const bare = ext === undefined ? path : path.slice(0, -ext.length);
  return PUBLIC_ENTRIES.includes(bare);
}

/** Every import from a module into another that skips its public entry or an undeclared dependency. */
export function moduleImportViolations(repoRoot: string): CrossModuleViolation[] {
  const modules = modulePackages(repoRoot);
  const violations: CrossModuleViolation[] = [];
  for (const importer of modules) {
    for (const path of sourceFiles(importer.dir)) {
      const file = relative(realpathDeep(repoRoot), path).split(sep).join("/");
      for (const specifier of moduleSpecifiers(readFileSync(path, "utf8"), path)) {
        const target = targetOf(specifier, path, modules);
        if (target === null || target.module.id === importer.id) continue;
        if (!isPublicEntry(target.path)) violations.push({ file, specifier, target: target.module.id, problem: "not-public" });
        if (!importer.declared.has(target.module.name)) {
          violations.push({ file, specifier, target: target.module.id, problem: "undeclared" });
        }
      }
    }
  }
  return violations;
}

/**
 * `path` with symlinks resolved through its longest existing ancestor, so a specifier naming
 * `x.js` beside a real `x.ts` still resolves through a linked directory.
 */
function realpathDeep(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

export function main(): number {
  const repoRoot = resolve(import.meta.dirname, "..");
  const violations = moduleImportViolations(repoRoot);
  for (const v of violations) {
    const why =
      v.problem === "not-public"
        ? `reaches past module "${v.target}"'s public entry (${PUBLIC_ENTRIES.map((entry) => `${entry}.ts`).join(" or ")})`
        : `imports module "${v.target}" without declaring it in package.json`;
    console.log(`${v.file}: "${v.specifier}" ${why}`);
  }
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
