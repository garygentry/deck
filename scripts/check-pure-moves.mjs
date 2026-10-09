#!/usr/bin/env node
// Check that a co-location change moves files without changing what they do.
//
// A pure move renames a file and edits nothing but its module specifiers, each of which must
// still load the same module. This script compares the diff from the merge-base with
// <base-ref> to HEAD (or, with --worktree, to the working tree: tracked and staged files, so
// `git mv` first):
//   - each renamed source file is parsed, old and new, with the TypeScript compiler, and the two
//     token streams must be equal. Comments and whitespace are trivia and may change. A module
//     specifier (`import`/`export … from`, `import()`, `require()`, `import("…")` types,
//     `declare module`) may change only when it resolves, from the file's new path, to the
//     module the old one resolved to from the old path (through the renames): the same file,
//     or the same external package. Resolution follows relative paths, the web app's tsconfig
//     path aliases and workspace packages' `exports`. JSON compares as data; any other file
//     must be byte-identical.
//   - a deleted file whose content reappears in an added file is a move git did not detect as
//     a rename (so `git log --follow` would lose its history): not pure.
//   - every other change is listed, with modified source files marked when their only edits are
//     specifiers to the same modules, so the non-move edits are easy to review.
// Its output is meant to be pasted into the PR body.
//
// Usage: node scripts/check-pure-moves.mjs <base-ref> [--worktree]
// Exit: 0 pure, 1 not pure, 2 usage or git error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { devNull } from "node:os";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * Run git with every knob that could change its diff output pinned: fixed a/ b/ prefixes,
 * unquoted paths, renames on, no global or system config and no external diff (the diff
 * commands also pass --no-ext-diff and --no-textconv).
 */
export function git(cwd, args, { binary = false } = {}) {
  const pinned = [
    "-c", "core.quotePath=false",
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.renames=true",
    "-c", "diff.relative=false",
  ];
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
  delete env.GIT_EXTERNAL_DIFF;
  return execFileSync("git", [...pinned, ...args], { cwd, env, maxBuffer: 512 * 1024 * 1024, ...(binary ? {} : { encoding: "utf8" }) });
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Every source leaf (a token, identifier or literal) of `text`, comments and whitespace aside. */
export function sourceLeaves(path, text) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const specifiers = new Set();
  const mark = (node) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.add(node);
  };
  const find = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) mark(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) mark(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) mark(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) mark(node.argument.literal);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) mark(node.name);
    ts.forEachChild(node, find);
  };
  find(file);
  const leaves = [];
  const walk = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (specifiers.has(node)) {
      leaves.push({ specifier: node.text });
      return;
    }
    const children = node.getChildren(file);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) leaves.push({ kind: node.kind, text: node.getText(file) });
      return;
    }
    for (const child of children) walk(child);
  };
  walk(file);
  return { leaves, parseErrors: file.parseDiagnostics?.length ?? 0 };
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
  if (Buffer.compare(before, after) === 0) return { problems: [], specifiers: 0, trivia: false };
  if (from.endsWith(".json") && to.endsWith(".json")) {
    try {
      return sameJson(JSON.parse(before.toString("utf8")), JSON.parse(after.toString("utf8")))
        ? { problems: [], specifiers: 0, trivia: true }
        : { problems: ["JSON content differs"], specifiers: 0, trivia: false };
    } catch {
      return { problems: ["JSON does not parse"], specifiers: 0, trivia: false };
    }
  }
  if (!SOURCE.test(from) || !SOURCE.test(to)) return { problems: ["content differs (not a source file, so it must be byte-identical)"], specifiers: 0, trivia: false };
  const a = sourceLeaves(from, before.toString("utf8"));
  const b = sourceLeaves(to, after.toString("utf8"));
  const problems = [];
  if (a.parseErrors !== b.parseErrors) problems.push(`parse errors differ (${a.parseErrors} → ${b.parseErrors})`);
  if (a.leaves.length !== b.leaves.length) problems.push(`token count differs (${a.leaves.length} → ${b.leaves.length})`);
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
    if (x.specifier === y.specifier && from === to) continue;
    const was = oldTree.resolve(x.specifier, from);
    const now = newTree.resolve(y.specifier, to);
    const expected = was.startsWith("file:") ? `file:${renames.get(was.slice(5)) ?? was.slice(5)}` : was;
    if (was.startsWith("unresolved:") || now !== expected) {
      problems.push(`specifier "${x.specifier}" → "${y.specifier}" loads ${now.replace(/^\w+:/, "")}, not ${expected.replace(/^\w+:/, "")}`);
    } else if (x.specifier !== y.specifier) {
      specifiers++;
    }
  }
  return { problems, specifiers, trivia: problems.length === 0 && specifiers === 0 };
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
export function check(cwd, base, { worktree = false } = {}) {
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

  lines.push("", failed ? "FAIL: not a pure move" : "OK: every rename is a pure move");
  return { ok: !failed, output: lines.join("\n") };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--worktree")) {
    console.error("usage: node scripts/check-pure-moves.mjs <base-ref> [--worktree]");
    process.exit(2);
  }
  let result;
  try {
    result = check(process.cwd(), positional[0], { worktree: args.includes("--worktree") });
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
