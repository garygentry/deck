import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ExitClass } from "../config/load.js";
import { migrateLayer, MigrateError, type MigrateResult } from "../config/migrate.js";
import { resolveConfigDir } from "../config/resolve-dir.js";
import { formatToolError } from "./findings-format.js";

const USAGE = "usage: deck config migrate <dir> [--dry-run]\n";

/** A layer to rewrite: the path deck reads, the file it resolves to, and its metadata. */
interface Layer {
  file: string;
  /** The real file behind `file` (itself, unless `file` is a symlink); it is rewritten in place. */
  target: string;
  before: string;
  mode: number;
  uid: number;
  gid: number;
  result: MigrateResult;
}

/** The filesystem calls a commit makes; tests substitute failing ones. */
export interface MigrateIo {
  /** Create `path` exclusively (never following or replacing anything already there). */
  create(path: string, text: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export const fileIo: MigrateIo = {
  create(path, text, mode) {
    writeFileSync(path, text, { flag: "wx", mode });
    chmodSync(path, mode);
  },
  chown: chownSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
};

class CommitError extends Error {}

/**
 * `deck config migrate <dir> [--dry-run]`: rewrite every YAML layer in a config directory
 * from schemaVersion 1 to 2, in place. Every layer is migrated and staged before any is
 * replaced, and a failure while replacing restores the layers already replaced, so the
 * directory is never left half migrated. A symlinked layer is migrated at its target, so
 * the link survives. File mode is kept, and owner and group where permitted. Exit 0 when the
 * directory was migrated or was already current, 2 on any problem.
 */
export function runConfigMigrate(argv: readonly string[], io: MigrateIo = fileIo): ExitClass {
  let dryRun = false;
  const positional: string[] = [];
  for (const argument of argv) {
    if (argument === "--dry-run") dryRun = true;
    else if (argument.startsWith("-")) {
      process.stderr.write(`unknown option ${argument}\n${USAGE}`);
      return 2;
    } else positional.push(argument);
  }
  if (positional.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  const resolved = resolveConfigDir({ arg: positional[0] });
  if (!resolved.ok) {
    process.stderr.write(`${formatToolError(resolved.error)}\n`);
    return 2;
  }
  const fail = (path: string, message: string): ExitClass => {
    process.stderr.write(`${formatToolError({ code: "CONFIG_MIGRATE_FAILED", path, message })}\n`);
    return 2;
  };

  const layers: Layer[] = [];
  const targets = new Set<string>();
  for (const file of resolved.files) {
    let target: string;
    let before: string;
    let stats: ReturnType<typeof statSync>;
    try {
      target = realpathSync(file);
      stats = statSync(target);
      before = readFileSync(target, "utf8");
    } catch (error) {
      return fail(file, `cannot read the layer: ${(error as Error).message}`);
    }
    // Two layer names for one file (a symlink to a sibling) are migrated once.
    if (targets.has(target)) continue;
    targets.add(target);
    try {
      const result = migrateLayer(before);
      layers.push({ file, target, before, mode: Number(stats.mode) & 0o7777, uid: Number(stats.uid), gid: Number(stats.gid), result });
    } catch (error) {
      if (!(error instanceof MigrateError)) throw error;
      return fail(file, error.message);
    }
  }

  const label = ({ file, target }: Layer) => (file === target ? file : `${file} -> ${target}`);
  const migrated = layers.filter(({ result }) => result.status === "migrated");
  for (const layer of layers) {
    for (const warning of layer.result.warnings) process.stderr.write(`warning  ${label(layer)}  ${warning}\n`);
    if (layer.result.status === "current") process.stdout.write(`${label(layer)}: already schemaVersion 2\n`);
  }
  if (dryRun) {
    for (const layer of migrated) process.stdout.write(unifiedDiff(layer.before, layer.result.text, basename(layer.file)));
    return 0;
  }

  try {
    commit(migrated, io);
  } catch (error) {
    if (!(error instanceof CommitError)) throw error;
    return fail(resolved.dir, error.message);
  }
  for (const layer of migrated) process.stdout.write(`${label(layer)}: migrated to schemaVersion 2\n`);
  if (migrated.length > 0) process.stdout.write(`next: deck validate ${resolved.dir}\n`);
  return 0;
}

/** A fresh, unguessable name beside `target` for staging its replacement. */
function stagingPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.migrate-${randomBytes(8).toString("hex")}.tmp`);
}

/** Write `text` to a new staged file beside `layer.target`, with the layer's mode and owner. */
function stage(layer: Layer, text: string, io: MigrateIo, created: string[]): string {
  const path = stagingPath(layer.target);
  io.create(path, text, layer.mode);
  created.push(path);
  try {
    io.chown(path, layer.uid, layer.gid);
  } catch (error) {
    process.stderr.write(`warning  ${layer.file}  could not keep owner ${layer.uid}:${layer.gid} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); the migrated file belongs to this user\n`);
  }
  return path;
}

/**
 * Stage every layer, then replace them one by one. If staging fails nothing is replaced;
 * if a replacement fails, the layers already replaced get their original text back. Every
 * staged file this run created is removed either way. Throws CommitError describing what
 * happened.
 */
function commit(layers: readonly Layer[], io: MigrateIo): void {
  const created: string[] = [];
  const cleanUp = () => {
    for (const path of created) {
      try {
        io.remove(path);
      } catch {
        // Best effort: a leftover staged file is harmless (deck reads only *.yaml).
      }
    }
  };
  const staged: string[] = [];
  try {
    for (const layer of layers) staged.push(stage(layer, layer.result.text, io, created));
  } catch (error) {
    cleanUp();
    throw new CommitError(`could not stage the migrated layers (${(error as Error).message}); nothing was changed`);
  }
  const replaced: Layer[] = [];
  for (const [index, layer] of layers.entries()) {
    try {
      io.rename(staged[index]!, layer.target);
      created.splice(created.indexOf(staged[index]!), 1);
      replaced.push(layer);
    } catch (error) {
      const unrestored: string[] = [];
      for (const done of replaced) {
        try {
          const original = stage(done, done.before, io, created);
          io.rename(original, done.target);
          created.splice(created.indexOf(original), 1);
        } catch {
          unrestored.push(done.target);
        }
      }
      cleanUp();
      throw new CommitError(
        `could not replace ${layer.target} (${(error as Error).message}); ` +
          (unrestored.length === 0
            ? `restored the ${replaced.length} layer(s) already replaced; nothing was changed`
            : `could not restore ${unrestored.join(", ")}, which are now schemaVersion 2`),
      );
    }
  }
}

type Edit = { op: " " | "-" | "+"; line: string };

/** A unified diff of two texts, with three lines of context per hunk. */
export function unifiedDiff(before: string, after: string, name: string): string {
  const a = splitLines(before);
  const b = splitLines(after);
  // A last line without a newline differs from the same text with one.
  const NO_NEWLINE = "\u0000no-newline";
  if (!before.endsWith("\n") && a.length > 0) a[a.length - 1] += NO_NEWLINE;
  if (!after.endsWith("\n") && b.length > 0) b[b.length - 1] += NO_NEWLINE;
  const edits = diffLines(a, b).map((edit) => ({ ...edit, line: edit.line.replace(NO_NEWLINE, "") }));
  const context = 3;
  const output = [`--- a/${name}\n`, `+++ b/${name}\n`];
  let index = 0;
  while (index < edits.length) {
    if (edits[index]!.op === " ") {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    // Extend the hunk while changes are within 2 × context of each other.
    for (;;) {
      while (end < edits.length && edits[end]!.op !== " ") end += 1;
      let next = end;
      while (next < edits.length && edits[next]!.op === " " && next - end < 2 * context) next += 1;
      if (next < edits.length && edits[next]!.op !== " ") end = next;
      else break;
    }
    end = Math.min(edits.length, end + context);
    const hunk = edits.slice(start, end);
    const oldStart = edits.slice(0, start).filter((edit) => edit.op !== "+").length + 1;
    const newStart = edits.slice(0, start).filter((edit) => edit.op !== "-").length + 1;
    const oldCount = hunk.filter((edit) => edit.op !== "+").length;
    const newCount = hunk.filter((edit) => edit.op !== "-").length;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`);
    for (const edit of hunk) {
      output.push(`${edit.op}${edit.line}\n`);
      // A last line without a newline is marked, as diff does, so the patch applies exactly.
      const lastOfA = edit.op !== "+" && edit === lastOf(edits, "+") && !before.endsWith("\n");
      const lastOfB = edit.op !== "-" && edit === lastOf(edits, "-") && !after.endsWith("\n");
      if (lastOfA || lastOfB) output.push("\\ No newline at end of file\n");
    }
    index = end;
  }
  return output.join("");
}

/** Line edits from a longest-common-subsequence table; config layers are small. */
function diffLines(a: readonly string[], b: readonly string[]): Edit[] {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      edits.push({ op: " ", line: a[i]! });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      edits.push({ op: "-", line: a[i]! });
      i += 1;
    } else {
      edits.push({ op: "+", line: b[j]! });
      j += 1;
    }
  }
  return edits;
}

/** Lines without their terminators; a final newline does not start another line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** The last edit that is not `skip` (the last line of one side). */
function lastOf(edits: readonly Edit[], skip: Edit["op"]): Edit | undefined {
  for (let index = edits.length - 1; index >= 0; index -= 1) if (edits[index]!.op !== skip) return edits[index];
  return undefined;
}
