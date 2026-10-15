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
// too): imports and re-exports, `import x = require(…)`, `import()`, `require()` and
// `createRequire(…)(…)` (and a `require` bound from it), `import.meta.resolve`, `import("…")`
// types, `declare module "…"` augmentation, `/// <reference path|types>`, `import.meta.glob`
// patterns and vitest's `vi.mock`/`vitest.mock` family (under any local name imported from
// vitest, by dot or by bracket). A load whose target cannot be read statically (a non-literal
// `import()` or `vi[key]`, say) is reported as `<unverifiable>`. A specifier reaches another module by relative path, by an app's path alias
// (`@/…`, `@web-test/…`, from the tsconfig `paths`), through a symlinked file or directory, by
// its package name, or through a shared test helper (apps/*/test) that itself reaches it: the
// helper's edges count as the importing module's own.
//
// Known limit, by design: the kernel's own sources (apps/web/src, apps/server/src) are not
// followed. The kernel loads modules legitimately (the registry discovers every web half), so a
// module that imports a kernel file re-exporting another module's internals (`@/k.js` with
// `export * from "…/modules/other/web/model.js"`) is not reported; kernel review owns that.
//
// Usage:
//   bun scripts/module-imports.ts          # prints each violation; exits 1 when there are any

import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

/** The files of a module that other modules may import, relative to its directory, without extension. */
export const PUBLIC_ENTRIES: readonly string[] = ["web/public", "server/public"];

/** Shared test helpers (repo-relative) whose own edges count for the module that imports them. */
export const HELPER_ROOTS: readonly string[] = ["apps/web/test", "apps/server/test"];

/** The tsconfig files (repo-relative) whose `paths` aliases module files may use. */
export const ALIAS_CONFIGS: readonly string[] = ["apps/web/tsconfig.json"];

/** The Vite root (repo-relative) a rooted `import.meta.glob` pattern is relative to. */
export const VITE_ROOT = "apps/web";

export const UNVERIFIABLE = "<unverifiable>";

/** One import from a module into another that breaks the rule. */
export interface CrossModuleViolation {
  /** Repo-relative path of the importing module file, `/`-separated. */
  file: string;
  /** The specifier as written in that file, or `<unverifiable>`. */
  specifier: string;
  /** The module imported from; null for an unverifiable load. */
  target: string | null;
  /**
   * `not-public`: it names a file other than the target's public entry; `undeclared`: the
   * importer's package.json does not depend on the target; `unverifiable`: the load's target
   * cannot be read statically.
   */
  problem: "not-public" | "undeclared" | "unverifiable";
  /** The shared test helper (repo-relative) through which the file reaches the target, if any. */
  via?: string;
}

/** One way a source file names another module. */
export interface ModuleReference {
  /** The specifier or pattern as written; null when it cannot be read statically. */
  specifier: string | null;
  /** The form, e.g. `import`, `import()`, `vi.mock`, `import.meta.glob`, `reference path`. */
  form: string;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** What a written `.js`-family extension stands for in TypeScript sources. */
const EXTENSION_SWAPS: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** vitest calls that load or replace a module by specifier. */
const VI_LOADERS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/**
 * One reference with the node that names it, for tools that need the position (the pure-move
 * check compares a moved file's tokens with its specifiers set aside). `node` is the literal
 * when `specifier` is read from one, else the argument as written (absent for a triple-slash
 * directive, or a load with no argument).
 */
export interface ModuleReferenceNode extends ModuleReference {
  node?: ts.Node;
}

/** Every reference `source` makes to another module, type-only ones included, in source order. */
export function moduleReferences(source: string, fileName = "module.ts"): ModuleReference[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  return moduleReferenceNodes(file).map(({ specifier, form }) => ({ specifier, form }));
}

/** {@link moduleReferences} over a parsed file, with each reference's node. */
export function moduleReferenceNodes(file: ts.SourceFile): ModuleReferenceNode[] {
  const found: ModuleReferenceNode[] = [];
  for (const ref of file.referencedFiles) found.push({ specifier: ref.fileName, form: "reference path" });
  for (const ref of file.typeReferenceDirectives) found.push({ specifier: ref.fileName, form: "reference types" });

  const viNames = new Set(["vi", "vitest"]);
  const viNamespaces = new Set<string>();
  const requireNames = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "vitest") continue;
    const bindings = statement.importClause?.namedBindings;
    // `import * as V from "vitest"`: `V.vi.mock(…)` and `V.vitest.mock(…)`.
    if (bindings && ts.isNamespaceImport(bindings)) viNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (["vi", "vitest"].includes((element.propertyName ?? element.name).text)) viNames.add(element.name.text);
      }
    }
  }
  // `const req = createRequire(import.meta.url)`: calls of `req` load modules.
  const collectRequires = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCreateRequireCall(node.initializer)) {
      requireNames.add(node.name.text);
    }
    ts.forEachChild(node, collectRequires);
  };
  collectRequires(file);

  // `vi` or `vitest` under a local name, or read off a namespace import of vitest.
  const isVi = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && viNames.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      viNamespaces.has(node.expression.text) &&
      ["vi", "vitest"].includes(node.name.text));
  const argument = (node: ts.CallExpression, form: string): void => {
    const [first] = node.arguments;
    found.push({ specifier: first && ts.isStringLiteralLike(first) ? first.text : null, form, node: first });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, form: ts.isImportDeclaration(node) ? "import" : "export", node: node.moduleSpecifier });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      found.push({ specifier: ts.isStringLiteral(expression) ? expression.text : null, form: "import = require", node: expression });
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      found.push({ specifier: node.name.text, form: "declare module", node: node.name });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, form: "import type()", node: node.argument.literal });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) argument(node, "import()");
      else if (ts.isIdentifier(callee) && callee.text === "require") argument(node, "require()");
      else if (ts.isIdentifier(callee) && requireNames.has(callee.text)) argument(node, "createRequire");
      else if (isCreateRequireCall(callee)) argument(node, "createRequire");
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "resolve" &&
        ((ts.isIdentifier(callee.expression) && (requireNames.has(callee.expression.text) || callee.expression.text === "require")) ||
          isCreateRequireCall(callee.expression))
      ) {
        argument(node, "require.resolve");
      } else if (ts.isPropertyAccessExpression(callee) && VI_LOADERS.has(callee.name.text) && isVi(callee.expression)) {
        argument(node, `vi.${callee.name.text}`);
      } else if (ts.isElementAccessExpression(callee) && isVi(callee.expression)) {
        // `vi["doMock"](…)` is `vi.doMock(…)`; a key that cannot be read could be any loader.
        const key = callee.argumentExpression;
        if (!ts.isStringLiteralLike(key)) found.push({ specifier: null, form: "vi[…]", node: key });
        else if (VI_LOADERS.has(key.text)) argument(node, `vi.${key.text}`);
      } else if (isImportMeta(callee, ["resolve"])) {
        argument(node, "import.meta.resolve");
      } else if (isImportMetaGlob(callee)) {
        const [first] = node.arguments;
        const patterns = first && ts.isArrayLiteralExpression(first) ? [...first.elements] : [first];
        for (const pattern of patterns) {
          found.push({
            specifier: pattern && ts.isStringLiteralLike(pattern) ? pattern.text : null,
            form: "import.meta.glob",
            node: pattern,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** `import.meta.<name>` for one of `names`. */
function isImportMeta(node: ts.Expression, names: readonly string[]): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    names.includes(node.name.text) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** `createRequire(…)` or `x.createRequire(…)`. */
function isCreateRequireCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === "createRequire") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire")
  );
}

/** `import.meta.glob` (or `globEager`). */
function isImportMetaGlob(node: ts.Expression): boolean {
  return isImportMeta(node, ["glob", "globEager"]);
}

/** Every specifier `source` names a module by (the literal ones), in source order. */
export function moduleSpecifiers(source: string, fileName = "module.ts"): string[] {
  return moduleReferences(source, fileName).flatMap((ref) => (ref.specifier === null ? [] : [ref.specifier]));
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

interface Alias {
  /** The written prefix, e.g. `@/` (or the whole specifier for an exact alias). */
  prefix: string;
  exact: boolean;
  /** Absolute directory (or file, for an exact alias) it stands for. */
  target: string;
}

interface Context {
  repoRoot: string;
  modules: readonly ModulePackage[];
  aliases: readonly Alias[];
  helperRoots: readonly string[];
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

/** The `paths` aliases of each tsconfig in {@link ALIAS_CONFIGS}, longest prefix first. */
function aliasesOf(repoRoot: string): Alias[] {
  const aliases: Alias[] = [];
  for (const config of ALIAS_CONFIGS) {
    const path = join(repoRoot, config);
    if (!existsSync(path)) continue;
    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
    const options = (parsed.config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
    const base = resolve(dirname(path), options.baseUrl ?? ".");
    for (const [key, [first]] of Object.entries(options.paths ?? {})) {
      if (first === undefined) continue;
      if (key.endsWith("/*") && first.endsWith("/*")) {
        aliases.push({ prefix: key.slice(0, -1), exact: false, target: resolve(base, first.slice(0, -2)) });
      } else if (!key.includes("*")) {
        aliases.push({ prefix: key, exact: true, target: resolve(base, first) });
      }
    }
  }
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
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
 * The real file a path names, trying what a bundler would: the path itself, its TypeScript
 * twin for a `.js`-family extension, each source extension appended, then an `index` file.
 * Symlinks are resolved, a linked file's included. A path that names nothing resolves through
 * its longest existing ancestor.
 */
function resolveFile(path: string): string {
  const candidates: string[] = [path];
  for (const [written, swaps] of Object.entries(EXTENSION_SWAPS)) {
    if (path.endsWith(written)) candidates.push(...swaps.map((ext) => path.slice(0, -written.length) + ext));
  }
  candidates.push(...SOURCE_EXTENSIONS.map((ext) => path + ext), `${path}.json`);
  candidates.push(...["index.ts", "index.tsx", "index.js"].map((name) => join(path, name)));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  return realpathDeep(path);
}

/** What a reference lands on: real files (several for a glob), a module package path, or nothing outside the repo's sources. */
type Landing = { files: string[] } | { module: ModulePackage; path: string } | null;

function land(ref: ModuleReference & { specifier: string }, fromFile: string, ctx: Context): Landing {
  const spec = ref.specifier;
  if (ref.form === "reference path") return { files: [resolveFile(resolve(dirname(fromFile), spec))] };
  if (ref.form === "import.meta.glob") {
    if (spec.startsWith("!")) return null;
    // A rooted glob pattern is relative to the Vite root, which every web half builds under.
    const absolute = spec.startsWith("/") ? join(ctx.repoRoot, VITE_ROOT, spec) : absoluteOf(spec, fromFile, ctx);
    return absolute === null ? null : { files: expandGlob(absolute) };
  }
  const absolute = absoluteOf(spec, fromFile, ctx);
  if (absolute !== null) return { files: [resolveFile(absolute)] };
  for (const module of ctx.modules) {
    if (spec === module.name) return { module, path: "" };
    if (spec.startsWith(`${module.name}/`)) return { module, path: spec.slice(module.name.length + 1) };
  }
  return null;
}

/** The absolute path a relative, rooted or aliased specifier names; null for a bare package. */
function absoluteOf(spec: string, fromFile: string, ctx: Context): string | null {
  if (spec.startsWith(".")) return resolve(dirname(fromFile), spec);
  if (spec.startsWith("/")) return spec;
  for (const alias of ctx.aliases) {
    if (alias.exact ? spec === alias.prefix : spec.startsWith(alias.prefix)) {
      return alias.exact ? alias.target : join(alias.target, spec.slice(alias.prefix.length));
    }
  }
  return null;
}

/**
 * The real files a glob matches, plus the directory before its first wildcard segment (so a
 * pattern into another module counts even when it matches nothing today).
 */
function expandGlob(absolutePattern: string): string[] {
  const segments = absolutePattern.split("/");
  const wild = segments.findIndex((segment) => /[*?[{]/.test(segment));
  if (wild === -1) return [resolveFile(absolutePattern)];
  const base = segments.slice(0, wild).join("/") || "/";
  const rest = segments.slice(wild).join("/");
  const matches = existsSync(base) ? globSync(rest, { cwd: base }).map((match) => join(base, match)) : [];
  return [realpathDeep(base), ...matches.filter((match) => statSync(match).isFile()).map((match) => realpathSync(match))];
}

/** The module a real path lies in, with its module-relative path; null outside modules/. */
function moduleOf(path: string, ctx: Context): { module: ModulePackage; path: string } | null {
  for (const module of ctx.modules) {
    const rel = relative(module.dir, path);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return { module, path: rel.split(sep).join("/") };
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
  const root = realpathDeep(repoRoot);
  const ctx: Context = {
    repoRoot: root,
    modules: modulePackages(repoRoot),
    aliases: aliasesOf(repoRoot),
    helperRoots: HELPER_ROOTS.map((dir) => realpathDeep(join(repoRoot, dir))),
  };
  const repoPath = (path: string) => relative(root, path).split(sep).join("/");
  const violations: CrossModuleViolation[] = [];
  const seen = new Set<string>();
  const report = (violation: CrossModuleViolation): void => {
    const key = JSON.stringify(violation);
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(violation);
  };
  const isHelper = (path: string) =>
    ctx.helperRoots.some((dir) => {
      const rel = relative(dir, path);
      return !rel.startsWith("..") && !isAbsolute(rel);
    });

  for (const importer of ctx.modules) {
    for (const path of sourceFiles(importer.dir)) {
      const file = repoPath(path);
      const visitedHelpers = new Set<string>();
      // The references `source` (the module file itself, or a helper it reaches) makes, checked for `importer`.
      const check = (source: string, written: string | null, via: string | undefined): void => {
        for (const ref of moduleReferences(readFileSync(source, "utf8"), source)) {
          const specifier = written ?? ref.specifier;
          const base = { file, ...(via === undefined ? {} : { via }) };
          if (ref.specifier === null) {
            report({ ...base, specifier: specifier ?? UNVERIFIABLE, target: null, problem: "unverifiable" });
            continue;
          }
          const landing = land({ ...ref, specifier: ref.specifier }, source, ctx);
          if (landing === null) continue;
          const targets = "files" in landing ? landing.files.map((target) => ({ target, inside: moduleOf(target, ctx) })) : [{ target: null, inside: landing }];
          for (const { target, inside } of targets) {
            if (inside !== null) {
              if (inside.module.id === importer.id) continue;
              if (!isPublicEntry(inside.path)) report({ ...base, specifier: specifier!, target: inside.module.id, problem: "not-public" });
              if (!importer.declared.has(inside.module.name)) report({ ...base, specifier: specifier!, target: inside.module.id, problem: "undeclared" });
            } else if (target !== null && isHelper(target) && existsSync(target) && statSync(target).isFile() && !visitedHelpers.has(target)) {
              // A shared helper's own edges are this module's: follow them, reporting them under
              // the specifier the module wrote.
              visitedHelpers.add(target);
              check(target, specifier, repoPath(target));
            }
          }
        }
      };
      check(path, null, undefined);
    }
  }
  return violations;
}

/**
 * `path` with symlinks resolved through its longest existing ancestor, so a specifier naming
 * a file that does not exist still resolves through a linked directory.
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
        : v.problem === "undeclared"
          ? `imports module "${v.target}" without declaring it in package.json`
          : "is a load whose target cannot be read statically";
    console.log(`${v.file}: "${v.specifier}"${v.via === undefined ? "" : ` (via ${v.via})`} ${why}`);
  }
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
