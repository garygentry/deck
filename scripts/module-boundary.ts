#!/usr/bin/env bun
// List the runtime imports a module's server half makes into the server kernel's internals.
//
// A module's server half (modules/<id>/server/**) builds on @deck/module-sdk and the wire
// contract. Loading a file under apps/server/src at runtime ties the module to the kernel's
// private layout, so a kernel refactor breaks it. Type-only imports are erased before the code
// runs, so `import type`, `export type`, imports whose every specifier is `type`, `typeof
// import(...)` and `declare module` augmentation stay allowed.
//
// Usage:
//   bun scripts/module-boundary.ts          # prints each violation; exits 1 when there are any

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

/** The kernel internals a module server half must not load at runtime (repo-relative). */
export const KERNEL_SERVER_SRC = "apps/server/src";

/** One runtime import from a module server half into the kernel. */
export interface BoundaryViolation {
  /** Repo-relative path of the importing file, `/`-separated. */
  file: string;
  /** The specifier as written. */
  specifier: string;
}

/**
 * Known violations, each waiting on its own follow-up. An entry here is a debt, not a
 * permission: the guard fails when an entry no longer matches, so fixing one forces its removal.
 */
export const ALLOWED_VIOLATIONS: readonly (BoundaryViolation & { reason: string })[] = [
  // Follow-up from #62. The runtime-pages service ref is kernel-owned and typed by kernel UI
  // types (ConfigPage, RuntimePages); it needs a home in the SDK (or a contract package)
  // before the remote module can stop loading the kernel file that declares it.
  {
    file: "modules/remote/server/module.ts",
    specifier: "../../../apps/server/src/ui/runtime-pages.js",
    reason: "RUNTIME_PAGES service ref is declared in the kernel's ui/runtime-pages.ts",
  },
  // Follow-up from #62. These fall back to the kernel's shared pino logger where no module
  // logger is threaded (snapshot: a provider built without one; sources: acquisition-side
  // failures), and their tests spy on that logger. Threading ctx.logger through is a
  // behaviour change of its own.
  {
    file: "modules/snapshot/server/index.ts",
    specifier: "../../../apps/server/src/log/logger.js",
    reason: "falls back to the kernel logger when no module logger is passed",
  },
  {
    file: "modules/sources/server/events.ts",
    specifier: "../../../apps/server/src/log/logger.js",
    reason: "acquisition-side failures log through the kernel logger",
  },
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * The module specifiers `source` loads at runtime: static imports and re-exports that are not
 * type-only, `import x = require(...)`, dynamic `import(...)` and `require(...)` calls with a
 * string literal. Specifiers inside a `declare module` block are augmentation, never loaded.
 */
export function runtimeImports(source: string, fileName = "module.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node)) return; // `declare module "…" { … }`: augmentation only.

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!importIsTypeOnly(node.importClause)) found.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!exportIsTypeOnly(node)) found.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** Whether an import is erased: `import type …`, or named imports that are all `type`. */
function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false; // `import "x"`: a side-effect import always loads.
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // A default import is a value binding.
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** Whether a re-export is erased: `export type …`, or named exports that are all `type`. */
function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false; // `export *` / `export * as ns`.
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/**
 * Package names whose specifiers land inside the kernel's server internals, read from the
 * server package's own manifest: its name maps to `apps/server/src` whenever an export does.
 */
export function kernelPackageNames(repoRoot: string): string[] {
  const manifestPath = join(repoRoot, "apps/server/package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; exports?: unknown };
  if (!manifest.name) return [];
  const targets: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  const kernel = resolve(repoRoot, KERNEL_SERVER_SRC);
  const intoKernel = targets.some((target) => isWithin(resolve(repoRoot, "apps/server", target), kernel));
  return intoKernel ? [manifest.name] : [];
}

/** Whether `specifier`, imported from `fromFile` (absolute), resolves into the kernel's internals. */
export function isKernelSpecifier(specifier: string, fromFile: string, repoRoot: string, packages: readonly string[]): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return isWithin(resolve(dirname(fromFile), specifier), resolve(repoRoot, KERNEL_SERVER_SRC));
  }
  return packages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/** Every source file under each `modules/<id>/server` directory of `repoRoot`. */
export function moduleServerFiles(repoRoot: string): string[] {
  const modulesDir = join(repoRoot, "modules");
  if (!existsSync(modulesDir)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !entry.endsWith(".d.ts")) files.push(path);
    }
  };
  for (const id of readdirSync(modulesDir).sort()) {
    const serverDir = join(modulesDir, id, "server");
    if (existsSync(serverDir) && statSync(serverDir).isDirectory()) walk(serverDir);
  }
  return files.sort();
}

/** Every runtime import from a module server half into the kernel's internals, allowlisted or not. */
export function moduleBoundaryViolations(repoRoot: string): BoundaryViolation[] {
  const packages = kernelPackageNames(repoRoot);
  const violations: BoundaryViolation[] = [];
  for (const path of moduleServerFiles(repoRoot)) {
    for (const specifier of runtimeImports(readFileSync(path, "utf8"), path)) {
      if (isKernelSpecifier(specifier, path, repoRoot, packages)) {
        violations.push({ file: relative(repoRoot, path).split(sep).join("/"), specifier });
      }
    }
  }
  return violations;
}

const sameViolation = (a: BoundaryViolation, b: BoundaryViolation): boolean =>
  a.file === b.file && a.specifier === b.specifier;

/** Violations not on the allowlist, and allowlist entries that no longer match anything. */
export function checkModuleBoundary(
  repoRoot: string,
  allowed: readonly BoundaryViolation[] = ALLOWED_VIOLATIONS,
): { violations: BoundaryViolation[]; stale: BoundaryViolation[] } {
  const found = moduleBoundaryViolations(repoRoot);
  return {
    violations: found.filter((v) => !allowed.some((a) => sameViolation(a, v))),
    stale: allowed.filter((a) => !found.some((v) => sameViolation(a, v))),
  };
}

export function main(): number {
  const repoRoot = resolve(import.meta.dirname, "..");
  const { violations, stale } = checkModuleBoundary(repoRoot);
  for (const v of violations) console.log(`${v.file}: runtime import of kernel internal "${v.specifier}"`);
  for (const a of stale) console.log(`stale allowlist entry: ${a.file} -> "${a.specifier}"`);
  return violations.length + stale.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
