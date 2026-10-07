/**
 * Real fixture runner scripts for the governed-actions e2e + smoke coverage.
 *
 * These are the ONLY tests that exercise the production Bun `RunnerSpawner` and
 * the real audit write (the vitest jobs inject a fake spawner). The runner
 * manifest that deck loads must map runner names to ABSOLUTE paths of existing
 * files (`loadRunners`), and absolute paths are checkout-specific — so the
 * fixture manifest is written at runtime from the resolved script paths here
 * rather than committed with machine-specific paths.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute paths of the committed fixture runner scripts. */
export const RUNNER_SCRIPTS = {
  /** Reads stdin, streams a few stdout lines with pauses, exits 0 (succeeded). */
  "echo-runner": join(here, "echo-runner.sh"),
  /** Reads stdin, writes stdout+stderr, exits 3 (failed). */
  "nonzero-runner": join(here, "nonzero-runner.sh"),
  /** Emits one line then sleeps long (cancel/timeout). */
  "long-runner": join(here, "long-runner.sh"),
  /** Smoke echo runner mapped to the `smoke-echo` action. */
  "smoke-echo": join(here, "smoke-echo.sh"),
} as const satisfies Record<string, string>;

/**
 * Write a runner manifest (name → absolute script path) to `destPath` and return
 * it. The absolute values satisfy `loadRunners`' isAbsolute + existing-file gate.
 */
export function writeRunnersManifest(destPath: string): string {
  writeFileSync(destPath, `${JSON.stringify(RUNNER_SCRIPTS, null, 2)}\n`);
  return destPath;
}

/** Convenience: the manifest as a plain object, e.g. for `new Map(Object.entries(...))`. */
export function runnersManifest(): Record<string, string> {
  return { ...RUNNER_SCRIPTS };
}
