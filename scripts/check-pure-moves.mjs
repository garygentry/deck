#!/usr/bin/env node
// Check that a co-location change moves files without changing what they do.
//
// A pure move renames a file and edits nothing but its module specifiers, each of which must
// still load the same module. This script compares the diff from the merge-base with
// <base-ref> to HEAD (or, with --worktree, to the working tree: tracked and staged files, so
// `git mv` first):
//   - each renamed source file is parsed, old and new, with the TypeScript compiler, and the two
//     streams (tree shape, tokens, directive comments such as `// @ts-expect-error`) must be
//     equal, even for a byte-identical file. Other comments and whitespace may change. A module
//     specifier (`import`/`export … from`, `import()`, `require()`, `import("…")` types,
//     `declare module`, vitest's `vi.mock`/`doMock`/`unmock`/`doUnmock`/`importActual`/
//     `importMock`, also as `vitest.…`) may change only when it resolves, from the file's new
//     path, to the module the old one resolved to from the old path (through the renames): the
//     same file, or the same external package. Resolution follows relative paths, the web app's
//     tsconfig path aliases and workspace packages' `exports`. The path in
//     `new URL("…", import.meta.url)` (or a const bound to `import.meta.url`) follows the same
//     rule as a file URL: the same file or directory, with no extension added. Any of these
//     whose path is not a literal fails a move to another directory, since it cannot be
//     checked. JSON compares as data; any other file must be byte-identical.
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
// Exit: 0 pure, 1 not pure, 2 usage or git error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

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

/** Vitest's module-path APIs: the first argument is a specifier, resolved as an import's. */
export const VI_MODULE_CALLS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/** `vi.mock`, `vitest.doMock`, …: a call whose first argument names a module. */
function isViModuleCall(callee) {
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && (callee.expression.text === "vi" || callee.expression.text === "vitest")
    && ts.isIdentifier(callee.name) && VI_MODULE_CALLS.has(callee.name.text);
}

/** `import.meta.url`. */
function isImportMetaUrl(node) {
  return ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "url";
}

/** Names the file binds to `import.meta.url` (`const TEST_FILE_URL = import.meta.url`). */
function fileUrlNames(file) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isImportMetaUrl(node.initializer)
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** `new URL(path, import.meta.url)` (or a const bound to it): a path relative to the file. */
function isFileUrl(node, names) {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "URL" || node.arguments?.length !== 2) return false;
  const base = node.arguments[1];
  return isImportMetaUrl(base) || (ts.isIdentifier(base) && names.has(base.text));
}

/**
 * The source of `text` as a stream to compare: every node's kind and child count (so the tree's
 * shape, which line breaks can change through ASI, is part of it), every leaf (a token,
 * identifier or literal) with its text, and every directive comment. Other comments and
 * whitespace are left out. Module specifiers stand as `{ specifier, form }` entries: `form` is
 * "module" for an import's (`import`/`export … from`, `import()`, `require()`, `import("…")`
 * types, `declare module`, and vitest's `vi.mock`/`doMock`/`unmock`/`doUnmock`/`importActual`/
 * `importMock`, also spelled `vitest.`) and "url" for the path in `new URL("…", import.meta.url)`.
 * `dynamic` lists the forms whose path argument is not a literal, so cannot be resolved.
 */
export function sourceLeaves(path, text) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  // Each specifier node, mapped to its form: "module" (loaded as a module) or "url" (a file URL).
  const specifiers = new Map();
  // Forms whose argument is a path the file names, but not as a literal: they cannot be checked.
  const dynamic = [];
  const mark = (node, form = "module") => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.set(node, form);
  };
  /** `node` in a specifier position: a literal is a specifier, anything else (but `import()`) is dynamic. */
  const argument = (node, form, use) => {
    if (node === undefined) return;
    if (ts.isStringLiteralLike(node)) mark(node, form);
    else if (!(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) dynamic.push(use);
  };
  const fileUrls = fileUrlNames(file);
  const find = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) mark(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) mark(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) argument(node.arguments[0], "module", "import()");
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") argument(node.arguments[0], "module", "require()");
    else if (ts.isCallExpression(node) && isViModuleCall(node.expression)) argument(node.arguments[0], "module", `${node.expression.expression.text}.${node.expression.name.text}()`);
    else if (ts.isNewExpression(node) && isFileUrl(node, fileUrls)) argument(node.arguments[0], "url", "new URL(…, import.meta.url)");
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) mark(node.argument.literal);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) mark(node.name);
    ts.forEachChild(node, find);
  };
  find(file);
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
      if (specifiers.has(node)) leaves.push({ specifier: node.text, form: specifiers.get(node) });
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

  /**
   * What `new URL(path, import.meta.url)` names from `from`: `file:<path>` (exactly that file, no
   * extension added), `dir:<path>` (a directory holding tracked files), `url:<href>` for an
   * absolute URL, or `unresolved:<path>`.
   */
  resolveUrl(path, from) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) return `url:${path}`;
    const base = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, "");
    if (this.files.has(base)) return `file:${base}`;
    const prefix = base === "." ? "" : `${base}/`;
    for (const file of this.files) if (file.startsWith(prefix)) return `dir:${base}`;
    return `unresolved:${base}`;
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

const show = (leaf) => ("specifier" in leaf ? `specifier "${leaf.specifier}"` : JSON.stringify(leaf.text));

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
    if (x.form !== y.form) {
      problems.push(`token ${index}: ${show(x)} → ${show(y)}`);
      continue;
    }
    const url = x.form === "url";
    const was = url ? oldTree.resolveUrl(x.specifier, from) : oldTree.resolve(x.specifier, from);
    const now = url ? newTree.resolveUrl(y.specifier, to) : newTree.resolve(y.specifier, to);
    const at = url ? -1 : was.indexOf("?");
    const [target, query] = at < 0 ? [was, ""] : [was.slice(0, at), was.slice(at)];
    const expected = target.startsWith("file:")
      ? `file:${renames.get(target.slice(5)) ?? target.slice(5)}${query}`
      : target.startsWith("dir:") ? `dir:${renamedDir(oldTree, target.slice(4), renames)}` : was;
    if (was.startsWith("unresolved:") || now !== expected) {
      problems.push(`specifier "${x.specifier}" → "${y.specifier}" loads ${now.replace(/^\w+:/, "")}, not ${expected.replace(/^\w+:/, "")}`);
    } else if (x.specifier !== y.specifier) {
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
