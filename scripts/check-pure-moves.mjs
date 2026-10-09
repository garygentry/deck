#!/usr/bin/env node
// Check that a co-location change moves files without changing what they do.
//
// A pure move renames a file and edits only its module specifiers (`from "…"`, `import("…")`,
// `import "…"`, `declare module "…"`) and comments. This script reads the diff from the
// merge-base with <base-ref> to HEAD (or, with --worktree, to the working tree: tracked and staged
// files, so `git mv` first) and:
//   - fails when a renamed file changes any other line;
//   - fails when a deleted file and an added file share a basename (a move git did not detect as
//     a rename, so `git log --follow` would lose its history);
//   - lists every other changed file, marking the ones whose edits are specifier-only, so the
//     non-move edits are easy to review.
// Its output is meant to be pasted into the PR body.
//
// Usage: node scripts/check-pure-moves.mjs <base-ref> [--worktree]
// Exit: 0 pure, 1 not pure, 2 usage or git error.

import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(...gitArgs) {
  try {
    return execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    console.error(`git ${gitArgs.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

/** Replace each module specifier with a placeholder, so two lines differing only there compare equal. */
export function normalizeSpecifiers(line) {
  return line.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bdeclare\s+module\s+)(["'])[^"']*\2/g, '$1"<specifier>"');
}

/** A line of comment text: `//`, `/*`, ` * `, `*\/` (every changed line of a doc comment). */
export function isComment(line) {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/**
 * Classify one file's changed lines: `specifier` when each removed line pairs, in order, with an
 * added line equal to it but for module specifiers; comment lines are `comment`; anything else
 * is `logic`.
 */
export function classify(removed, added) {
  const code = (lines) => lines.filter((line) => line.trim() !== "" && !isComment(line));
  const comments = [...removed, ...added].filter((line) => line.trim() !== "" && isComment(line)).length;
  const [from, to] = [code(removed), code(added)];
  const logic = [];
  for (let index = 0; index < Math.max(from.length, to.length); index++) {
    const [before, after] = [from[index], to[index]];
    if (before === undefined || after === undefined || normalizeSpecifiers(before) !== normalizeSpecifiers(after)) {
      if (before !== undefined) logic.push(`- ${before}`);
      if (after !== undefined) logic.push(`+ ${after}`);
    }
  }
  return { specifiers: Math.min(from.length, to.length) - logic.filter((line) => line.startsWith("-")).length, comments, logic };
}

function main() {
  const args = process.argv.slice(2);
  const base = args.find((arg) => !arg.startsWith("--"));
  const worktree = args.includes("--worktree");
  if (base === undefined || args.some((arg) => arg.startsWith("--") && arg !== "--worktree")) {
    console.error("usage: node scripts/check-pure-moves.mjs <base-ref> [--worktree]");
    process.exit(2);
  }

  const mergeBase = git("merge-base", base, "HEAD").trim();
  // Diff the merge-base against HEAD, or against the working tree (`git diff <commit>`).
  const range = worktree ? [mergeBase] : [mergeBase, "HEAD"];

  /** The removed and added lines of one file's diff (`-U0`, so context never appears). */
  const changedLines = (paths) => {
    const patch = git("diff", "-M", "-U0", "--no-color", ...range, "--", ...paths);
    const removed = [];
    const added = [];
    for (const line of patch.split("\n")) {
      if (/^(--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null))/.test(line)) continue;
      if (line.startsWith("-")) removed.push(line.slice(1));
      else if (line.startsWith("+")) added.push(line.slice(1));
    }
    return { removed, added };
  };

  const status = git("diff", "-M", "--name-status", "--no-color", ...range)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));

  let failed = false;
  const renames = status.filter(([code]) => code.startsWith("R"));
  const others = status.filter(([code]) => !code.startsWith("R"));

  console.log(`pure-move check: ${worktree ? "working tree" : "HEAD"} against ${base} (merge-base ${mergeBase.slice(0, 12)})`);
  console.log(`\nrenames (${renames.length}):`);
  for (const [code, from, to] of renames) {
    const { removed, added } = changedLines([from, to]);
    const result = classify(removed, added);
    const verdict = result.logic.length === 0 ? "ok" : "NOT PURE";
    const detail = [`similarity ${code.slice(1)}%`];
    if (result.specifiers > 0) detail.push(`${result.specifiers} specifier line(s)`);
    if (result.comments > 0) detail.push(`${result.comments} comment line(s)`);
    console.log(`  ${verdict.padEnd(8)} ${from} -> ${to} (${detail.join(", ")})`);
    if (result.logic.length > 0) {
      failed = true;
      for (const line of result.logic) console.log(`             ${line}`);
    }
  }

  const deleted = others.filter(([code]) => code === "D").map(([, path]) => path);
  const addedPaths = others.filter(([code]) => code === "A").map(([, path]) => path);
  const undetected = deleted.flatMap((from) => addedPaths.filter((to) => basename(to) === basename(from)).map((to) => [from, to]));
  if (undetected.length > 0) {
    failed = true;
    console.log(`\nmoves git did not detect as renames (${undetected.length}): history would not follow them`);
    for (const [from, to] of undetected) console.log(`  ${from} -> ${to}`);
  }

  console.log(`\nother changes (${others.length}):`);
  for (const [code, path] of others) {
    let note = "";
    if (code === "M") {
      const { removed, added } = changedLines([path]);
      const result = classify(removed, added);
      note = result.logic.length === 0 ? " (specifier/comment edits only)" : "";
    }
    console.log(`  ${code} ${path}${note}`);
  }

  console.log(`\n${failed ? "FAIL: not a pure move" : "OK: every rename is a pure move"}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
