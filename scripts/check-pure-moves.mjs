#!/usr/bin/env node
// Check that a co-location change moves files without changing what they do.
//
// A pure move renames a file and edits nothing but its module specifiers, each of which must
// still load the same module. This script compares the diff from the merge-base with
// <base-ref> to HEAD (or, with --worktree, to the working tree: tracked and staged files, so
// `git mv` first):
//   - each renamed source file is parsed, old and new, with the TypeScript compiler, and the two
//     streams (tree shape, tokens, directive comments such as `// @ts-expect-error`) must be
//     equal, even for a byte-identical file. Other comments and whitespace may change. A path the
//     file names relative to itself may change only when it resolves, from the file's new path,
//     to what the old one resolved to from the old path (through the renames): the same file,
//     directory or external package. That covers every module reference the module-imports
//     guard reads (imports, `import()`, `require()`, `createRequire`, vitest's `vi.mock` family
//     under any local name, `import.meta.resolve`, …), `import.meta.glob` patterns, file URLs
//     (`new URL("…", import.meta.url)`, resolved as WHATWG URLs, trailing slash and escapes
//     included) and `join`/`resolve` from the file's directory (`import.meta.dirname`,
//     `__dirname`, `dirname(fileURLToPath(import.meta.url))`, …); see `sourceLeaves`. Module
//     resolution follows relative paths, the web app's tsconfig path aliases and workspace
//     packages' `exports`. A move to another directory fails while the file reads its location
//     any other way (a non-literal path, another `import.meta` or `__dirname` use), since that
//     cannot be checked. JSON compares as data; any other file must be byte-identical.
//   - a deleted file whose content reappears in an added file is a move git did not detect as
//     a rename (so `git log --follow` would lose its history): not pure. So is any other deleted
//     source under apps/*/src or apps/*/test, which no rename accounts for.
//   - every other change is listed, with modified source files marked when their only edits are
//     specifiers to the same modules, so the non-move edits are easy to review.
//   - checking HEAD with uncommitted changes (tracked or untracked) fails: the output would not
//     describe what is pushed. A change with no renames fails too, since its OK would vouch for
//     nothing, unless --allow-empty says it is meant to move nothing.
// Its output is meant to be pasted into the PR body.
//
// Usage: node scripts/check-pure-moves.mjs <base-ref> [--worktree] [--allow-empty]
// Needs Node 22.18 or later (or 23.6 or later), which load the TypeScript module-imports guard it
// shares by stripping types; or run it with bun.
// Exit: 0 pure, 1 not pure, 2 usage or git error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { moduleReferenceNodes } from "./module-imports.ts";

/**
 * Run git with every knob that could change its diff output pinned (fixed a/ b/ prefixes,
 * unquoted paths, renames on, no external diff; the diff commands also pass --no-ext-diff and
 * --no-textconv). Other config, global and system included, still applies (`safe.directory`).
 */
export function git(cwd, args, { binary = false } = {}) {
  const pinned = [
    "-c", "core.quotePath=false",
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.renames=true",
    "-c", "diff.relative=false",
  ];
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  return execFileSync("git", [...pinned, ...args], { cwd, env, maxBuffer: 512 * 1024 * 1024, ...(binary ? {} : { encoding: "utf8" }) });
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Comments that are code: tool directives (`// @ts-expect-error`, `/* @vite-ignore *\/`,
 * `/*#__PURE__*\/`, `/** @vitest-environment jsdom *\/`, `/// <reference …>`).
 */
export const DIRECTIVE = /^\s*(?:\/\/\/\s*<|\/\/\s*[@#]|\/\*\*?\s*[@#])/;

/** `import.meta.<name>` for one of `names`. */
function isImportMeta(node, names) {
  return ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && names.includes(node.name.text);
}

/** A call of `name` or `<object>.name`. */
function isCallOf(node, name) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === name) || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === name);
}

/** The identifiers each name is declared by in `file` (any scope), to tell a binding from a shadow. */
function declarations(file) {
  const names = new Map();
  const add = (name) => {
    if (name !== undefined && ts.isIdentifier(name)) names.set(name.text, [...(names.get(name.text) ?? []), name]);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportSpecifier(node)
      || ts.isImportEqualsDeclaration(node) || ts.isEnumDeclaration(node)) add(node.name);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Whether identifier `node` is read as a value (not a property name, declaration name or type). */
function isReference(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
    || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent)) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent)
    || ts.isImportEqualsDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

/** The leading `!` of a negated glob pattern, and the rest. */
const globParts = (pattern) => (pattern.startsWith("!") ? ["!", pattern.slice(1)] : ["", pattern]);

/**
 * The source of `text` as a stream to compare: every node's kind and child count (so the tree's
 * shape, which line breaks can change through ASI, is part of it), every leaf (a token,
 * identifier or literal) with its text, and every directive comment. Other comments and
 * whitespace are left out.
 *
 * Paths the file names relative to itself stand as `{ specifier, form, … }` entries, each
 * resolved later from the file's old and new paths:
 *   - "module": every form `scripts/module-imports.ts` reads (`moduleReferenceNodes`, shared so
 *     the two guards cannot drift): imports, re-exports, `import()`, `require()`,
 *     `createRequire(…)` loads and `require.resolve`, `import("…")` types, `declare module`,
 *     `import.meta.resolve`, and vitest's `mock`/`doMock`/`unmock`/`doUnmock`/`importActual`/
 *     `importMock` on `vi` or `vitest` under any local name, by dot or by literal bracket;
 *   - "glob": an `import.meta.glob` pattern;
 *   - "url": the path in `new URL("…", base)` (also `new globalThis.URL`), where the base is the
 *     file's URL: `import.meta.url`, `new URL("./", import.meta.url)`, or a const bound to one
 *     that nothing else in the file declares;
 *   - "path": the literals in `join(anchor, "…", …)` / `resolve(anchor, "…", …)`, where the
 *     anchor is the file's directory or path: `import.meta.dirname`/`filename`, `__dirname`/
 *     `__filename`, `dirname(fileURLToPath(import.meta.url))`, `fileURLToPath(import.meta.url)`,
 *     `fileURLToPath(new URL(".", import.meta.url))`, or a const bound to one of them.
 *
 * `dynamic` lists the location-dependent uses that cannot be resolved: a non-literal path in
 * any of those positions, a `vi[key]` whose key is not a literal, a `/// <reference path>`,
 * a `createRequire` whose base is not the file, and every other use of `import.meta`,
 * `__dirname`, `__filename` or a const bound to the file's location. A move to another
 * directory fails while any remain.
 */
export function sourceLeaves(path, text) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  // Each specifier node, mapped to how it resolves (see above).
  const specifiers = new Map();
  const dynamic = [];
  // The `import.meta`, `__dirname`/`__filename` and anchor-const reads a recognized form accounts for.
  const consumed = new Set();
  const declared = declarations(file);
  /**
   * Whether call `node` is `name` from one of `modules`, by its binding in this file: a named
   * import (renamed or not) of `name`, or `ns.name` on a namespace or default import (or a named
   * `posix`/`win32` import of node:path). A local function, another object's method or a
   * shadowed import of the same name is not, so it gets no path semantics.
   */
  const isHelper = (node, name, modules) => {
    if (!ts.isCallExpression(node)) return false;
    const importOf = (identifier) => {
      const bindings = declared.get(identifier.text) ?? [];
      if (bindings.length !== 1) return undefined;
      let statement = bindings[0].parent;
      while (statement !== undefined && !ts.isImportDeclaration(statement)) statement = statement.parent;
      if (statement === undefined || statement.importClause?.isTypeOnly || !modules.includes(statement.moduleSpecifier.text)) return undefined;
      return bindings[0].parent;
    };
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      const binding = importOf(callee);
      return binding !== undefined && ts.isImportSpecifier(binding) && !binding.isTypeOnly && (binding.propertyName ?? binding.name).text === name;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === name) {
      const binding = importOf(callee.expression);
      return binding !== undefined && (ts.isNamespaceImport(binding) || ts.isImportClause(binding)
        || (ts.isImportSpecifier(binding) && !binding.isTypeOnly && ["posix", "win32"].includes((binding.propertyName ?? binding.name).text)));
    }
    return false;
  };
  const PATH = ["node:path", "path"];
  const URL_MODULES = ["node:url", "url"];
  const consume = (node) => {
    const visit = (child) => {
      if (ts.isMetaProperty(child) || ts.isIdentifier(child)) consumed.add(child);
      ts.forEachChild(child, visit);
    };
    visit(node);
  };

  // `URL` is the global, or imported from node:url.
  const urlNames = new Set(["URL"]);
  for (const name of declared.get("URL") ?? []) {
    const spec = name.parent && ts.isImportSpecifier(name.parent) ? name.parent.parent.parent.parent.moduleSpecifier : undefined;
    if (spec === undefined || !["node:url", "url"].includes(spec.text)) urlNames.delete("URL");
  }
  const isNewUrl = (node) => ts.isNewExpression(node) && node.arguments?.length === 2 && (
    (ts.isIdentifier(node.expression) && urlNames.has(node.expression.text))
    || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "globalThis" && node.expression.name.text === "URL"));

  // Consts bound to the file's location, each declared once in the file (so no scope shadows it).
  const anchors = new Map();
  /** What `node` says about the file's location: "url", "dirurl", "dir", "file", or undefined. */
  const anchorOf = (node) => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    if (isImportMeta(node, ["url"])) return "url";
    if (isImportMeta(node, ["dirname"])) return "dir";
    if (isImportMeta(node, ["filename"])) return "file";
    if (ts.isIdentifier(node)) {
      if (anchors.has(node.text)) return anchors.get(node.text);
      if (!declared.has(node.text) && node.text === "__dirname") return "dir";
      if (!declared.has(node.text) && node.text === "__filename") return "file";
      return undefined;
    }
    if (isNewUrl(node)) {
      const [path, base] = node.arguments;
      const of = anchorOf(base);
      return (of === "url" || of === "dirurl") && ts.isStringLiteralLike(path) && [".", "./"].includes(path.text) ? "dirurl" : undefined;
    }
    if (isHelper(node, "fileURLToPath", URL_MODULES) && node.arguments.length === 1) {
      const of = anchorOf(node.arguments[0]);
      return of === "url" ? "file" : of === "dirurl" ? "dir" : undefined;
    }
    if (isHelper(node, "dirname", PATH) && node.arguments.length === 1 && anchorOf(node.arguments[0]) === "file") return "dir";
    return undefined;
  };
  const collectAnchors = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0 && declared.get(node.name.text)?.length === 1
      // An exported const is read where this check cannot see it.
      && !(ts.isVariableStatement(node.parent.parent) && node.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))) {
      const of = anchorOf(node.initializer);
      if (of !== undefined) {
        anchors.set(node.name.text, of);
        consume(node.initializer);
        return;
      }
    }
    ts.forEachChild(node, collectAnchors);
  };
  collectAnchors(file);

  // The module-imports guard's references: literals are specifiers, the rest cannot be checked.
  const createRequires = [];
  const findCreateRequires = (node) => {
    if (isCallOf(node, "createRequire")) createRequires.push(node);
    ts.forEachChild(node, findCreateRequires);
  };
  findCreateRequires(file);
  const fileRequires = createRequires.every((call) => {
    const of = call.arguments.length === 1 && isHelper(call, "createRequire", ["node:module", "module"]) ? anchorOf(call.arguments[0]) : undefined;
    if (of === "url" || of === "file") consume(call.arguments[0]);
    return of === "url" || of === "file";
  });
  for (const { node, specifier, form } of moduleReferenceNodes(file)) {
    if (form === "reference path") dynamic.push("/// <reference path>");
    if (node === undefined) continue;
    if (!fileRequires && (form === "createRequire" || form === "require.resolve")) dynamic.push(`${form} (its base is not this file)`);
    else if (specifier !== null && ts.isStringLiteralLike(node)) specifiers.set(node, form === "import.meta.glob" ? { form: "glob" } : { form: "module" });
    else if (!(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) dynamic.push(form);
    if (form === "import.meta.glob" || form === "import.meta.resolve") {
      let call = node.parent;
      while (call !== undefined && !ts.isCallExpression(call)) call = call.parent;
      if (call !== undefined) consume(call.expression);
    }
  }

  const find = (node) => {
    // An anchor const's initializer is the file's location itself, not a path to resolve.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && anchors.has(node.name.text) && declared.get(node.name.text)?.[0] === node.name) return;
    if (isNewUrl(node)) {
      const [path, base] = node.arguments;
      const of = anchorOf(base);
      if (of === "url" || of === "dirurl") {
        consume(base);
        if (ts.isStringLiteralLike(path)) specifiers.set(path, { form: "url", base: of });
        else dynamic.push("new URL(…, import.meta.url)");
        find(path);
        return;
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && (isHelper(node, "join", PATH) || isHelper(node, "resolve", PATH))) {
      const [first, ...rest] = node.arguments;
      const of = anchorOf(first);
      if (of === "dir" || of === "file") {
        consume(first);
        const fn = isHelper(node, "join", PATH) ? "join" : "resolve";
        if (rest.every((part) => ts.isStringLiteralLike(part))) {
          specifiers.set(rest[0], { form: "path", base: of, fn, parts: rest.map((part) => part.text) });
          for (const part of rest.slice(1)) specifiers.set(part, { form: "part" });
        } else {
          dynamic.push(`${fn}() from the file's location`);
        }
        for (const part of rest) find(part);
        return;
      }
    }
    ts.forEachChild(node, find);
  };
  find(file);

  // Whatever reads the file's location and is not accounted for above.
  const leftovers = (node) => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && !consumed.has(node)) {
      dynamic.push(ts.isPropertyAccessExpression(node.parent) ? `import.meta.${node.parent.name.text}` : "import.meta");
    } else if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier === undefined && anchors.has((node.propertyName ?? node.name).text)) {
      // `export { HERE }` / `export { HERE as base }`: read where this check cannot see it.
      dynamic.push(`${(node.propertyName ?? node.name).text} (bound to the file's location) exported`);
    } else if (ts.isIdentifier(node) && !consumed.has(node) && isReference(node)) {
      if (anchors.has(node.text)) dynamic.push(`${node.text} (bound to the file's location) used other than as a base`);
      else if (["__dirname", "__filename"].includes(node.text) && !declared.has(node.text)) dynamic.push(node.text);
    }
    ts.forEachChild(node, leftovers);
  };
  leftovers(file);

  const leaves = [];
  const directives = (ranges) => {
    for (const range of ranges ?? []) {
      const comment = text.slice(range.pos, range.end);
      if (DIRECTIVE.test(comment)) leaves.push({ kind: "directive", text: comment.trim() });
    }
  };
  const walk = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = specifiers.has(node) ? [] : node.getChildren(file);
    if (children.length === 0) {
      // A leaf owns the comments before it (from the line after the previous token) and after it on its line.
      directives(ts.getLeadingCommentRanges(text, node.pos));
      if (specifiers.has(node)) leaves.push({ specifier: node.text, ...specifiers.get(node) });
      else if (node.kind !== ts.SyntaxKind.EndOfFileToken) leaves.push({ kind: node.kind, text: node.getText(file) });
      directives(ts.getTrailingCommentRanges(text, node.end));
      return;
    }
    leaves.push({ kind: node.kind, text: `(${children.length}` });
    for (const child of children) walk(child);
  };
  walk(file);
  return { leaves, dynamic, parseErrors: file.parseDiagnostics?.length ?? 0 };
}

/** A package `exports` map's target for `subpath` (exact keys and `*` patterns, string targets). */
function exportTarget(exports, subpath) {
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (exports === null || typeof exports !== "object") return undefined;
  const pick = (target) => (typeof target === "string" ? target : target?.import ?? target?.default);
  if (Object.hasOwn(exports, subpath)) return pick(exports[subpath]);
  for (const [pattern, target] of Object.entries(exports)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= head.length + tail.length) {
      return pick(target)?.replace("*", subpath.slice(head.length, subpath.length - tail.length));
    }
  }
  return undefined;
}

/** One revision of the repository: its file list and contents, and how its specifiers resolve. */
export class Tree {
  /** `rev` null is the working tree (its tracked files). */
  constructor(cwd, rev) {
    this.cwd = cwd;
    this.rev = rev;
    const listing = rev === null ? git(cwd, ["ls-files", "-z"]) : git(cwd, ["ls-tree", "-r", "-z", "--name-only", rev]);
    this.files = new Set(listing.split("\0").filter((path) => path !== "" && (rev !== null || existsSync(posix.join(cwd, path)))));
    this.cache = new Map();
    this.packages = [...this.files]
      .filter((path) => path.endsWith("/package.json") && !path.includes("node_modules/"))
      .flatMap((path) => {
        try {
          const manifest = JSON.parse(this.read(path).toString("utf8"));
          return typeof manifest.name === "string" ? [{ name: manifest.name, dir: posix.dirname(path), exports: manifest.exports }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.name.length - a.name.length);
    this.aliases = this.webAliases();
  }

  read(path) {
    if (!this.cache.has(path)) {
      this.cache.set(path, this.rev === null ? readFileSync(posix.join(this.cwd, path)) : git(this.cwd, ["cat-file", "blob", `${this.rev}:${path}`], { binary: true }));
    }
    return this.cache.get(path);
  }

  /** The web app's tsconfig `paths` (`@/*` → `apps/web/src/*`), which its built-in modules share. */
  webAliases() {
    const config = "apps/web/tsconfig.json";
    if (!this.files.has(config)) return [];
    try {
      const { compilerOptions = {} } = JSON.parse(this.read(config).toString("utf8"));
      const base = posix.join("apps/web", compilerOptions.baseUrl ?? ".");
      return Object.entries(compilerOptions.paths ?? {})
        .filter(([pattern, targets]) => pattern.endsWith("/*") && typeof targets?.[0] === "string" && targets[0].endsWith("/*"))
        .map(([pattern, [target]]) => ({ prefix: pattern.slice(0, -1), dir: posix.join(base, target.slice(0, -1)) }));
    } catch {
      return [];
    }
  }

  /** The file `base` names: itself, its `.ts` source for a `.js` specifier, or a directory index. */
  file(base) {
    const stem = base.replace(/\.[cm]?jsx?$/, "");
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
    return candidates.find((candidate) => this.files.has(candidate));
  }

  /** What `specifier` loads from `from`: `file:<path>`, `package:<name>`, or `unresolved:<base>`. */
  resolve(specifier, from) {
    // A bundler query (Vite's `?raw`) loads the same file another way: resolve the path, keep the query.
    const query = specifier.indexOf("?");
    if (query > 0) return `${this.resolve(specifier.slice(0, query), from)}${specifier.slice(query)}`;
    let base;
    if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
      base = posix.normalize(posix.join(posix.dirname(from), specifier));
    } else {
      const webCompiled = from.startsWith("apps/web/") || /^modules\/[^/]+\/(?:web|test\/web)\//.test(from);
      const alias = webCompiled ? this.aliases.find(({ prefix }) => specifier.startsWith(prefix)) : undefined;
      if (alias !== undefined) {
        base = posix.join(alias.dir, specifier.slice(alias.prefix.length));
      } else {
        const pkg = this.packages.find(({ name }) => specifier === name || specifier.startsWith(`${name}/`));
        if (pkg === undefined) return `package:${specifier}`;
        const target = exportTarget(pkg.exports, `.${specifier.slice(pkg.name.length)}`);
        if (target === undefined) return `unresolved:${specifier}`;
        base = posix.normalize(posix.join(pkg.dir, target));
      }
    }
    const file = this.file(base);
    return file === undefined ? `unresolved:${base}` : `file:${file}`;
  }

  /** What repo-relative `path` is: `file:`, `dir:` (a directory of tracked files; `slash` kept), or `unresolved:`. */
  locate(path, slash) {
    if (path === "" || path === ".") return `dir:${slash ? "./" : "."}`;
    if (this.files.has(path)) return slash ? `unresolved:${path}/` : `file:${path}`;
    for (const file of this.files) if (file.startsWith(`${path}/`)) return `dir:${path}${slash ? "/" : ""}`;
    return `unresolved:${path}${slash ? "/" : ""}`;
  }

  /**
   * What `new URL(spec, base)` names from `from`, by WHATWG URL resolution against the file's URL
   * (`base` "url") or its directory's (`base` "dirurl"): `file:<path>` (exactly that file), or
   * `dir:<path>` with its trailing slash kept (`x/` and `x` differ as a base, and `a.ts/` is no
   * file); `url:<href>` for an absolute URL, which names the same thing from anywhere; or
   * `unresolved:` for a path outside the repository, a query or fragment, or a bad escape.
   */
  resolveUrl(spec, from, base = "url") {
    const root = "file:///repo/";
    const dir = posix.dirname(from);
    const fileUrl = new URL(`${root}${(base === "url" ? from : dir === "." ? "" : `${dir}/`).split("/").map(encodeURIComponent).join("/")}`);
    let url;
    try {
      url = new URL(spec, fileUrl);
    } catch {
      return `unresolved:${spec}`;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("/")) return `url:${url.href}`;
    if (url.protocol !== "file:" || url.host !== "" || url.search !== "" || url.hash !== "" || !url.pathname.startsWith("/repo/")) return `unresolved:${spec}`;
    const segments = url.pathname.slice("/repo/".length).split("/");
    const slash = segments.length > 0 && segments[segments.length - 1] === "";
    if (slash) segments.pop();
    let path;
    try {
      path = segments.map((segment) => {
        const decoded = decodeURIComponent(segment);
        // `fileURLToPath` refuses an encoded `/` (and a NUL is no path).
        if (decoded.includes("/") || decoded.includes("\0")) throw new Error("bad segment");
        return decoded;
      }).join("/");
    } catch {
      return `unresolved:${spec}`;
    }
    return this.locate(path, slash);
  }

  /**
   * What `join`/`resolve(anchor, ...parts)` names from `from` (`base` "dir": the file's directory;
   * "file": its path), with node's path semantics: `file:`/`dir:`, `abs:<path>` when `resolve`
   * meets an absolute part (the same from anywhere), or `unresolved:`.
   */
  resolvePath(parts, from, base, fn) {
    const start = `/repo/${base === "dir" ? posix.dirname(from) : from}`;
    const joined = fn === "join" ? posix.join(start, ...parts) : posix.resolve(start, ...parts);
    if (fn === "resolve" && parts.some((part) => part.startsWith("/"))) return `abs:${joined}`;
    if (joined !== "/repo" && !joined.startsWith("/repo/")) return `unresolved:${joined}`;
    const slash = joined.endsWith("/") && joined !== "/repo/";
    const path = joined.slice("/repo/".length).replace(/\/$/, "");
    // A directory reads the same with or without its slash; a file with one does not read.
    const found = this.locate(path, slash);
    return found.startsWith("dir:") ? found.replace(/\/$/, "") : found;
  }

  /** An `import.meta.glob` pattern from `from`, as a repo-relative pattern (a rooted one stays as written). */
  resolveGlob(pattern, from) {
    const [negated, rest] = globParts(pattern);
    if (rest.startsWith("/")) return `glob:${negated}${rest}`;
    if (!rest.startsWith(".")) return `glob:${negated}${rest}`;
    const path = posix.normalize(posix.join(posix.dirname(from), rest));
    return path.startsWith("../") ? `unresolved:${pattern}` : `glob:${negated}${path}`;
  }
}

/**
 * Where directory `dir` is after the renames: the directory its files all moved to, keeping
 * their paths under it, or `dir` itself when they did not all move together.
 */
function renamedDir(oldTree, dir, renames) {
  const prefix = dir === "." ? "" : `${dir}/`;
  let moved;
  for (const file of oldTree.files) {
    if (!file.startsWith(prefix)) continue;
    const to = renames.get(file);
    const rest = file.slice(prefix.length);
    if (to === undefined || !to.endsWith(`/${rest}`)) return dir;
    const target = to.slice(0, -rest.length - 1);
    if (moved !== undefined && moved !== target) return dir;
    moved = target;
  }
  return moved ?? dir;
}

/** Deep equality of two parsed JSON values. */
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

const show = (leaf) => ("specifier" in leaf ? `${leaf.form === "module" ? "specifier" : leaf.form} "${leaf.form === "path" ? leaf.parts.join(", ") : leaf.specifier}"` : JSON.stringify(leaf.text));

/**
 * Compare a file across a move (or an edit in place): `problems` (what is not pure),
 * `specifiers` (how many were rewritten, each to the same module) and `trivia` (only comments
 * or whitespace otherwise changed).
 */
export function compareFile({ oldTree, newTree, from, to, renames }) {
  const [before, after] = [oldTree.read(from), newTree.read(to)];
  const source = SOURCE.test(from) && SOURCE.test(to);
  // A source file is compared even when byte-identical: an unchanged relative specifier loads
  // another module once the file has moved.
  if (!source && Buffer.compare(before, after) === 0) return { problems: [], specifiers: 0, trivia: false };
  if (from.endsWith(".json") && to.endsWith(".json")) {
    try {
      return sameJson(JSON.parse(before.toString("utf8")), JSON.parse(after.toString("utf8")))
        ? { problems: [], specifiers: 0, trivia: true }
        : { problems: ["JSON content differs"], specifiers: 0, trivia: false };
    } catch {
      return { problems: ["JSON does not parse"], specifiers: 0, trivia: false };
    }
  }
  if (!source) return { problems: ["content differs (not a source file, so it must be byte-identical)"], specifiers: 0, trivia: false };
  const a = sourceLeaves(from, before.toString("utf8"));
  const b = sourceLeaves(to, after.toString("utf8"));
  const problems = [];
  if (a.parseErrors !== b.parseErrors) problems.push(`parse errors differ (${a.parseErrors} → ${b.parseErrors})`);
  if (a.leaves.length !== b.leaves.length) problems.push(`token count differs (${a.leaves.length} → ${b.leaves.length})`);
  // A path that is not a literal resolves from the file's directory too, but cannot be checked.
  if (posix.dirname(from) !== posix.dirname(to)) {
    for (const use of new Set([...a.dynamic, ...b.dynamic])) problems.push(`${use} with a non-literal path: cannot check that it loads the same file from the new directory`);
  }
  let specifiers = 0;
  for (let index = 0; index < Math.min(a.leaves.length, b.leaves.length) && problems.length < 20; index++) {
    const [x, y] = [a.leaves[index], b.leaves[index]];
    if (!("specifier" in x) && !("specifier" in y)) {
      if (x.kind !== y.kind || x.text !== y.text) problems.push(`token ${index}: ${show(x)} → ${show(y)}`);
      continue;
    }
    if (!("specifier" in x && "specifier" in y)) {
      problems.push(`token ${index}: ${show(x)} → ${show(y)}`);
      continue;
    }
    if (x.form !== y.form || x.base !== y.base || x.fn !== y.fn) {
      problems.push(`token ${index}: ${show(x)} → ${show(y)}`);
      continue;
    }
    // A later part of a join/resolve: its text is in the first part's leaf.
    if (x.form === "part") continue;
    const resolveIn = (tree, leaf, path) => {
      if (leaf.form === "url") return tree.resolveUrl(leaf.specifier, path, leaf.base);
      if (leaf.form === "path") return tree.resolvePath(leaf.parts, path, leaf.base, leaf.fn);
      if (leaf.form === "glob") return tree.resolveGlob(leaf.specifier, path);
      return tree.resolve(leaf.specifier, path);
    };
    const was = resolveIn(oldTree, x, from);
    const now = resolveIn(newTree, y, to);
    const at = x.form === "module" ? was.indexOf("?") : -1;
    const [target, query] = at < 0 ? [was, ""] : [was.slice(0, at), was.slice(at)];
    let expected = was;
    if (target.startsWith("file:")) expected = `file:${renames.get(target.slice(5)) ?? target.slice(5)}${query}`;
    else if (target.startsWith("dir:")) {
      const slash = target.endsWith("/");
      const dir = target.slice(4).replace(/\/$/, "") || ".";
      expected = `dir:${renamedDir(oldTree, dir, renames)}${slash ? "/" : ""}`;
    }
    if (was.startsWith("unresolved:") || now !== expected) {
      const named = (leaf) => (leaf.form === "path" ? leaf.parts.join(", ") : leaf.specifier);
      const label = { module: "specifier", url: "URL", path: "path", glob: "glob" }[x.form];
      problems.push(`${label} "${named(x)}" → "${named(y)}" loads ${now.replace(/^\w+:/, "")}, not ${expected.replace(/^\w+:/, "")}`);
    } else if (x.specifier !== y.specifier || (x.form === "path" && x.parts.join("/") !== y.parts.join("/"))) {
      specifiers++;
    }
  }
  return { problems, specifiers, trivia: problems.length === 0 && specifiers === 0 && Buffer.compare(before, after) !== 0 };
}

/** Parse `git diff --name-status -z` output into `[status, path, path?]` entries. */
function nameStatus(output) {
  const parts = output.split("\0");
  const entries = [];
  for (let index = 0; index < parts.length && parts[index] !== "";) {
    const status = parts[index++];
    entries.push(/^[RC]/.test(status) ? [status, parts[index++], parts[index++]] : [status, parts[index++]]);
  }
  return entries;
}

/** A file's content without specifiers or trivia, to pair a move git did not detect. */
function fingerprint(tree, path) {
  const content = tree.read(path);
  if (!SOURCE.test(path)) return `bytes:${content.toString("base64")}`;
  return JSON.stringify(sourceLeaves(path, content.toString("utf8")).leaves.map((leaf) => ("specifier" in leaf ? "<specifier>" : leaf.text)));
}

/** Run the check in the repository at `cwd`; returns `{ ok, output }`. */
export function check(cwd, base, { worktree = false, allowEmpty = false } = {}) {
  const lines = [];
  const mergeBase = git(cwd, ["merge-base", base, "HEAD"]).trim();
  const range = worktree ? [mergeBase] : [mergeBase, "HEAD"];
  const status = nameStatus(git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M50%", "--name-status", "-z", ...range]));
  const oldTree = new Tree(cwd, mergeBase);
  const newTree = new Tree(cwd, worktree ? null : "HEAD");
  const renameEntries = status.filter(([code]) => code.startsWith("R"));
  const renames = new Map(renameEntries.map(([, from, to]) => [from, to]));
  let failed = false;

  lines.push(`pure-move check: ${worktree ? "working tree" : "HEAD"} against ${base} (merge-base ${mergeBase.slice(0, 12)})`);
  if (!worktree) {
    const dirty = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter((entry) => /^.. /.test(entry));
    if (dirty.length > 0) {
      failed = true;
      lines.push("", `NOT CHECKED: the working tree has uncommitted changes (${dirty.length}); commit them, or check them with --worktree:`);
      for (const entry of dirty) lines.push(`  ${entry}`);
    }
  }
  lines.push("", `renames (${renameEntries.length}):`);
  for (const [code, from, to] of renameEntries) {
    const { problems, specifiers, trivia } = compareFile({ oldTree, newTree, from, to, renames });
    const detail = [`similarity ${Number(code.slice(1))}%`];
    if (specifiers > 0) detail.push(`${specifiers} specifier(s) rewritten, same module`);
    if (trivia) detail.push("comments/whitespace only");
    lines.push(`  ${problems.length === 0 ? "ok      " : "NOT PURE"} ${from} -> ${to} (${detail.join(", ")})`);
    if (problems.length > 0) {
      failed = true;
      for (const problem of problems) lines.push(`             ${problem}`);
    }
  }

  const others = status.filter(([code]) => !code.startsWith("R"));
  const deleted = others.filter(([code]) => code === "D").map(([, path]) => path);
  const added = others.filter(([code]) => code === "A").map(([, path]) => path);
  const deletedPrints = new Map(deleted.map((path) => [fingerprint(oldTree, path), path]));
  const undetected = added.flatMap((path) => {
    const from = deletedPrints.get(fingerprint(newTree, path));
    return from === undefined ? [] : [[from, path]];
  });
  if (undetected.length > 0) {
    failed = true;
    lines.push("", `NOT PURE: moves git did not detect as renames (${undetected.length}); history would not follow them:`);
    for (const [from, to] of undetected) lines.push(`  ${from} -> ${to}`);
  }

  // A deleted app source or test that nothing pairs may have moved with edits too large for
  // rename detection: its history and its purity are both unchecked.
  const paired = new Set(undetected.map(([from]) => from));
  const unpaired = deleted.filter((path) => !paired.has(path) && SOURCE.test(path) && /^apps\/[^/]+\/(?:src|test)\//.test(path));
  if (unpaired.length > 0) {
    failed = true;
    lines.push("", `NOT PURE: deleted app sources no rename pairs (${unpaired.length}); move them with git mv, or delete them in a separate change:`);
    for (const path of unpaired) lines.push(`  D ${path}`);
  }

  const additions = added.filter((path) => path.startsWith("modules/"));
  lines.push("", `additions under modules/ (${additions.length}):`);
  for (const path of additions) lines.push(`  A ${path}`);

  const rest = others.filter(([code, path]) => !(code === "A" && path.startsWith("modules/")));
  lines.push("", `other changes (${rest.length}):`);
  for (const [code, path] of rest) {
    let note = "";
    if (code === "M" && SOURCE.test(path)) {
      const { problems, specifiers, trivia } = compareFile({ oldTree, newTree, from: path, to: path, renames });
      if (problems.length === 0) note = specifiers > 0 ? " (specifier edits only, same modules)" : trivia ? " (comments/whitespace only)" : "";
    }
    lines.push(`  ${code} ${path}${note}`);
  }

  if (renameEntries.length === 0 && !allowEmpty) {
    failed = true;
    lines.push("", "NOT PURE: no renames, so nothing moved; pass --allow-empty if the change is meant to move nothing");
  }

  lines.push("", failed ? "FAIL: not a pure move" : "OK: every rename is a pure move");
  return { ok: !failed, output: lines.join("\n") };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--worktree" && arg !== "--allow-empty")) {
    console.error("usage: node scripts/check-pure-moves.mjs <base-ref> [--worktree] [--allow-empty]");
    process.exit(2);
  }
  let result;
  try {
    result = check(process.cwd(), positional[0], { worktree: args.includes("--worktree"), allowEmpty: args.includes("--allow-empty") });
  } catch (error) {
    console.error(`check-pure-moves: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  console.log(result.output);
  process.exit(result.ok ? 0 : 1);
}

// Run as a script however it is invoked (through a symlink, by a relative path), never on import.
const invoked = process.argv[1];
if (invoked !== undefined && existsSync(invoked) && realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))) main();
