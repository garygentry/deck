#!/usr/bin/env bun
// List the kernel files a diff touches.
//
// Deck is moving to a small kernel plus modules on one contract. This metric shows how far a
// change reaches into the kernel: a new module should touch zero kernel files unless it
// genuinely needs a new kernel capability. It is informational, so it always exits 0 once
// the diff is read; only a usage or git error exits non-zero.
//
// It also reports, on a separate line, the parity-gate files (goldens, their harness and the
// frozen fixtures) a diff touches: not kernel, but a change there can mask a behaviour change.
//
// Usage:
//   bun scripts/kernel-touch.ts                 # working tree + commits since merge-base with main
//   bun scripts/kernel-touch.ts --base <ref>    # same, against <ref>
//   bun scripts/kernel-touch.ts --range A...B   # an explicit git diff range
//   bun scripts/kernel-touch.ts --json          # machine-readable output
//   git diff --name-only --no-renames … | bun scripts/kernel-touch.ts --stdin

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The kernel: what every module builds on, and what a module must not need to edit.
 * Globs are repo-relative; `**` spans directories and `*` stays within one segment.
 * Paths that do not exist yet (the module host, the SDK) are listed so the metric is right
 * the day they land.
 */
export const KERNEL_PATHS: readonly string[] = [
  // Estate contract and the config pipeline: schema, ownership, rules, findings, types.
  "packages/schema/schema/**",
  "packages/schema/src/**",
  "packages/schema/scripts/**",
  // The module SDK.
  "packages/module-sdk/**",
  // The wire contract shared by server and web. `actions.ts` is the actions module's code,
  // housed there until that module has a shared half of its own.
  "packages/contract/package.json",
  "packages/contract/src/index.ts",
  "packages/contract/src/freshness.ts",
  "packages/contract/src/poll.ts",
  "packages/contract/src/snapshot.ts",
  // Server: config load/merge/validate, CLI, contract, app skeleton and boot, logging.
  "apps/server/src/config/**",
  "apps/server/src/cli/**",
  "apps/server/src/contract/**",
  "apps/server/src/server/**",
  "apps/server/src/log/**",
  "apps/server/src/index.ts",
  // Server: the module host, and the UI manifest resolver (including the temporary UI
  // declarations of features not yet on the module contract).
  "apps/server/src/modules/**",
  "apps/server/src/ui/**",
  // Server: the provider registry, scheduler and the config-to-provider mapping. The
  // per-kind provider directories beside them are data-source modules, not kernel.
  "apps/server/src/providers/registry.ts",
  "apps/server/src/providers/index.ts",
  // Web: the shell, the page registry, the data layer, the `@/ui` library, global styles and the
  // entry point.
  "apps/web/src/shell/**",
  "apps/web/src/registry/**",
  "apps/web/src/data/**",
  "apps/web/src/ui/**",
  "apps/web/src/styles/**",
  "apps/web/src/main.tsx",
  "apps/web/index.html",
  "apps/web/vite.config.ts",
  // Web: the mechanical UI rules. An allowlist entry here is a kernel exception.
  "apps/web/test/ui-guardrails.test.ts",
];

/**
 * Paths never counted, even under a kernel glob: tests and fixtures prove behaviour but are
 * not the kernel surface a module depends on (the guardrail test above is listed explicitly).
 */
export const EXCLUDED_PATHS: readonly string[] = [
  "**/test/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "packages/schema/src/fixtures/**",
];

/**
 * The parity gate: goldens, the harness that captures them and the fixtures they freeze. Not
 * kernel, but a change here can hide a behaviour change, so it is reported on its own line.
 */
export const PARITY_GATE_PATHS: readonly string[] = [
  "apps/server/test/golden/parity/**",
  "apps/server/test/parity/**",
  "apps/server/test/parity-golden.test.ts",
  // Every input a golden is built from: the estates it boots, the canned upstream bodies and
  // runner manifest it serves, and the schema fixtures (primary, minimal, invalid, snapshots).
  "apps/server/test/fixtures/v1-*/**",
  "apps/server/test/fixtures/actions-estate/**",
  "apps/server/test/fixtures/actions-smoke/**",
  "apps/server/test/fixtures/alerts-estate/**",
  "apps/server/test/fixtures/portal-estate/**",
  "apps/server/test/fixtures/portal-broken-ref/**",
  "apps/server/test/fixtures/prometheus/**",
  "apps/server/test/fixtures/alertmanager/**",
  "packages/schema/src/fixtures/**",
];

/** Compile a repo-relative glob (`**`, `*`, `?`) to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const kernelPatterns = KERNEL_PATHS.map(globToRegExp);
const excludedPatterns = EXCLUDED_PATHS.map(globToRegExp);
const explicitKernel = new Set(KERNEL_PATHS.filter((path) => !/[*?]/.test(path)));

/** True when a repo-relative path is a kernel file. */
export function isKernelPath(path: string): boolean {
  if (explicitKernel.has(path)) return true;
  if (excludedPatterns.some((pattern) => pattern.test(path))) return false;
  return kernelPatterns.some((pattern) => pattern.test(path));
}

const parityGatePatterns = PARITY_GATE_PATHS.map(globToRegExp);

/** True when a repo-relative path belongs to the parity gate. */
export function isParityGatePath(path: string): boolean {
  return parityGatePatterns.some((pattern) => pattern.test(path));
}

function distinct(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) => path !== ""))];
}

/** The kernel files among `paths`, sorted and de-duplicated. */
export function kernelTouches(paths: readonly string[]): string[] {
  return distinct(paths).filter(isKernelPath).sort();
}

/** The parity-gate files among `paths`, sorted and de-duplicated. */
export function parityGateTouches(paths: readonly string[]): string[] {
  return distinct(paths).filter(isParityGatePath).sort();
}

export interface Options {
  base: string;
  range?: string;
  stdin: boolean;
  json: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { base: "main", stdin: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--stdin") options.stdin = true;
    else if (arg === "--base" || arg === "--range") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--base") options.base = value;
      else options.range = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function git(args: readonly string[], cwd?: string): string[] {
  return execFileSync("git", args, { encoding: "utf8", ...(cwd === undefined ? {} : { cwd }) })
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * Changed paths for the options: an explicit range, or everything since the merge-base.
 * `--no-renames` lists a moved file under both its old and new path, so moving a file out of
 * the kernel still counts as touching the kernel.
 */
export function changedPaths(options: Options, cwd?: string): string[] {
  if (options.stdin) return readFileSync(0, "utf8").split("\n");
  if (options.range !== undefined) return git(["diff", "--name-only", "--no-renames", options.range], cwd);
  const [mergeBase] = git(["merge-base", options.base, "HEAD"], cwd);
  return [
    ...git(["diff", "--name-only", "--no-renames", mergeBase!], cwd),
    // `--full-name`: repo-relative even when run from a subdirectory, like `git diff`.
    ...git(["ls-files", "--others", "--exclude-standard", "--full-name"], cwd),
  ];
}

export function main(argv: readonly string[]): number {
  let options: Options;
  let changed: string[];
  try {
    options = parseOptions(argv);
    changed = changedPaths(options);
  } catch (cause) {
    process.stderr.write(`kernel-touch: ${(cause as Error).message}\n`);
    return 2;
  }
  const touched = kernelTouches(changed);
  const parityGate = parityGateTouches(changed);
  const total = distinct(changed).length;
  if (options.json) {
    const report = {
      kernelFiles: touched,
      kernelCount: touched.length,
      parityGateFiles: parityGate,
      parityGateCount: parityGate.length,
      changedCount: total,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`kernel files touched: ${touched.length} (of ${total} changed)\n`);
    for (const path of touched) process.stdout.write(`  ${path}\n`);
    process.stdout.write(`parity-gate files touched: ${parityGate.length}\n`);
    for (const path of parityGate) process.stdout.write(`  ${path}\n`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
