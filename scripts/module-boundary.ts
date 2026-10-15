#!/usr/bin/env bun
// List the runtime imports a module's server half makes into the server kernel's internals.
//
// A module's server half (modules/<id>/server/**) builds on @deck/module-sdk and the wire
// contract. Loading a file under apps/server/src at runtime ties the module to the kernel's
// private layout, so a kernel refactor breaks it. Type-only imports are erased before the code
// runs, so `import type`, `export type`, imports whose every specifier is `type`, `typeof
// import(...)` and ambient `declare module "…"` / `declare global` augmentation stay allowed.
// A load the guard cannot check (a non-literal `import()` or `require()`, `createRequire`,
// `module.require`) fails closed: it is reported as unverifiable.
//
// Usage:
//   bun scripts/module-boundary.ts          # prints each violation; exits 1 when there are any

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

/** The kernel internals a module server half must not load at runtime (repo-relative). */
export const KERNEL_SERVER_SRC = "apps/server/src";

/**
 * One load a source file makes at runtime. `specifier` is null when it cannot be read
 * statically. `use` names the form and the value bindings, e.g. `import { logger }`,
 * `export *`, `import()`, `createRequire`.
 */
export interface RuntimeImport {
  specifier: string | null;
  use: string;
}

/** One runtime import from a module server half into the kernel, or one the guard cannot check. */
export interface BoundaryViolation {
  /** Repo-relative path of the importing file, `/`-separated. */
  file: string;
  /** The specifier as written, or `<unverifiable>` for a load that cannot be read statically. */
  specifier: string;
  /** How it is loaded (see {@link RuntimeImport.use}). */
  use: string;
}

/** A known violation group: every runtime use one file makes of one kernel specifier. */
export interface AllowedViolation {
  file: string;
  specifier: string;
  /** Exactly the uses allowed, so the debt cannot grow behind an existing entry. */
  uses: readonly string[];
  reason: string;
}

export const UNVERIFIABLE = "<unverifiable>";

/**
 * Known violations, each tracked by #88. An entry here is a debt, not a permission: it pins the
 * exact uses, so a new import or re-export through the same file fails, and the guard fails
 * when an entry no longer matches anything, so fixing one forces its removal.
 */
export const ALLOWED_VIOLATIONS: readonly AllowedViolation[] = [
  // #88. The runtime-pages service ref is kernel-owned and typed by kernel UI types
  // (ConfigPage, RuntimePages); it needs a home in the SDK (or a contract package) before the
  // remote module can stop loading the kernel file that declares it.
  {
    file: "modules/remote/server/module.ts",
    specifier: "../../../apps/server/src/ui/runtime-pages.js",
    uses: ["import { RUNTIME_PAGES }"],
    reason: "RUNTIME_PAGES service ref is declared in the kernel's ui/runtime-pages.ts",
  },
  // #88. These fall back to the kernel's shared pino logger where no module logger is threaded
  // (snapshot: a provider built without one; sources: acquisition-side failures), and their
  // tests spy on that logger. Threading ctx.logger through is a behaviour change of its own.
  {
    file: "modules/snapshot/server/index.ts",
    specifier: "../../../apps/server/src/log/logger.js",
    uses: ["import { logger }"],
    reason: "falls back to the kernel logger when no module logger is passed",
  },
  {
    file: "modules/sources/server/events.ts",
    specifier: "../../../apps/server/src/log/logger.js",
    uses: ["import { logger }"],
    reason: "acquisition-side failures log through the kernel logger",
  },
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The loads `source` makes at runtime: static imports and re-exports that are not type-only,
 * `import x = require(...)`, `import(...)` and `require(...)`. Ambient `declare module "…"` and
 * `declare global` blocks are augmentation, never loaded; an executable `namespace` body runs,
 * so it is scanned. A load whose target cannot be read statically has a null specifier.
 */
export function runtimeImports(source: string, fileName = "module.ts"): RuntimeImport[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found: RuntimeImport[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node) && isAmbientAugmentation(node)) return;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const use = importUse(node.importClause);
      if (use !== null) found.push({ specifier: node.moduleSpecifier.text, use });
      // `import { createRequire as r }`: the alias is what gets called, so flag the import.
      const bindings = node.importClause?.namedBindings;
      if (!node.importClause?.isTypeOnly && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "createRequire" && !element.isTypeOnly) found.push({ specifier: null, use: "createRequire" });
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const use = exportUse(node);
      if (use !== null) found.push({ specifier: node.moduleSpecifier.text, use });
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      found.push({ specifier: ts.isStringLiteral(expression) ? expression.text : null, use: "import = require" });
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      const literal = first && ts.isStringLiteralLike(first) ? first.text : null;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) found.push({ specifier: literal, use: "import()" });
      else if (ts.isIdentifier(callee) && callee.text === "require") found.push({ specifier: literal, use: "require()" });
      else if (isPropertyCall(callee, "module", "require")) found.push({ specifier: null, use: "module.require()" });
    }
    // Any reference to createRequire (imported, called, read off `module`) builds a require the
    // guard cannot follow.
    if (ts.isIdentifier(node) && node.text === "createRequire" && !isInTypePosition(node)) {
      found.push({ specifier: null, use: "createRequire" });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** `declare module "x" { … }` or `declare global { … }`: types only, never executed. */
function isAmbientAugmentation(node: ts.ModuleDeclaration): boolean {
  if (ts.isStringLiteral(node.name)) return true; // A quoted name is always ambient.
  return (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}

function isPropertyCall(callee: ts.Expression, object: string, property: string): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === object &&
    callee.name.text === property
  );
}

/** Whether an identifier sits inside a type (e.g. `typeof createRequire` in a type annotation). */
function isInTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

/** How an import loads its module, or null when it is erased (`import type`, all-`type` names). */
function importUse(clause: ts.ImportClause | undefined): string | null {
  if (!clause) return "import"; // `import "x"`: a side-effect import always loads.
  if (clause.isTypeOnly) return null;
  const names: string[] = [];
  if (clause.name) names.push("default");
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
  if (bindings && ts.isNamedImports(bindings)) {
    const values = bindings.elements.filter((element) => !element.isTypeOnly);
    // `import { type A }` alone is erased (no verbatimModuleSyntax); `import {}` still loads.
    if (values.length === 0 && bindings.elements.length > 0 && !clause.name) return null;
    names.push(...values.map((element) => (element.propertyName ?? element.name).text));
  }
  return names.length === 0 ? "import" : `import { ${names.sort().join(", ")} }`;
}

/** How a re-export loads its module, or null when it is erased (`export type`, all-`type` names). */
function exportUse(node: ts.ExportDeclaration): string | null {
  if (node.isTypeOnly) return null;
  const clause = node.exportClause;
  if (!clause) return "export *";
  if (ts.isNamespaceExport(clause)) return "export * as";
  const values = clause.elements.filter((element) => !element.isTypeOnly);
  if (values.length === 0 && clause.elements.length > 0) return null;
  const names = values.map((element) => (element.propertyName ?? element.name).text).sort();
  return names.length === 0 ? "export" : `export { ${names.join(", ")} }`;
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
    const target = resolve(dirname(fromFile), specifier);
    const kernel = resolve(repoRoot, KERNEL_SERVER_SRC);
    // Follow symlinks (a workspace link in node_modules, say) on both sides.
    const targets = [target, realpathDeep(target)];
    const kernels = [kernel, realpathDeep(kernel)];
    return targets.some((t) => kernels.some((k) => isWithin(t, k)));
  }
  return packages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
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
      else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !/\.d\.[cm]?ts$/.test(entry)) files.push(path);
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
    const file = relative(repoRoot, path).split(sep).join("/");
    for (const { specifier, use } of runtimeImports(readFileSync(path, "utf8"), path)) {
      if (specifier === null) violations.push({ file, specifier: UNVERIFIABLE, use });
      else if (isKernelSpecifier(specifier, path, repoRoot, packages)) violations.push({ file, specifier, use });
    }
  }
  return violations;
}

/**
 * Violations not covered by the allowlist, and allowlist entries that no longer match. An entry
 * covers a (file, specifier) group only when the group's uses are exactly its `uses`; any
 * other group of that pair is reported whole.
 */
export function checkModuleBoundary(
  repoRoot: string,
  allowed: readonly AllowedViolation[] = ALLOWED_VIOLATIONS,
): { violations: BoundaryViolation[]; stale: AllowedViolation[] } {
  const found = moduleBoundaryViolations(repoRoot);
  const groupOf = (file: string, specifier: string) =>
    found.filter((v) => v.file === file && v.specifier === specifier);
  const sameUses = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().every((use, i) => use === [...b].sort()[i]);

  const covered = new Set<BoundaryViolation>();
  for (const entry of allowed) {
    if (entry.specifier === UNVERIFIABLE) continue; // Never allowlistable.
    const group = groupOf(entry.file, entry.specifier);
    if (sameUses(group.map((v) => v.use), entry.uses)) group.forEach((v) => covered.add(v));
  }
  return {
    violations: found.filter((v) => !covered.has(v)),
    stale: allowed.filter((entry) => groupOf(entry.file, entry.specifier).length === 0),
  };
}

export function main(): number {
  const repoRoot = resolve(import.meta.dirname, "..");
  const { violations, stale } = checkModuleBoundary(repoRoot);
  for (const v of violations) console.log(`${v.file}: runtime ${v.use} of kernel internal "${v.specifier}"`);
  for (const a of stale) console.log(`stale allowlist entry: ${a.file} -> "${a.specifier}"`);
  return violations.length + stale.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
