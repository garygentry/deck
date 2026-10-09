// Vitest reporter for the CI `bun-parity` job (scripts/bun-parity-vitest.sh).
//
// The job exists to run the unit tests on the runtime that ships, so it must fail loudly when
// they ran somewhere else or not at all:
// - `bunx vitest` without `--bun` follows vitest's `#!/usr/bin/env node` shebang, so the tests
//   run under Node while the job reads green. `onInit` refuses that and prints the Bun version.
// - Some vitest/Bun combinations end the process early with exit 0 and no summary (vitest 1.x
//   cannot start its worker pool on Bun at all). `onTestRunEnd` writes a summary file that the
//   wrapper script requires, so an early exit fails the job instead of reading green.
//
// It declares the slice of vitest's reporter API it uses rather than importing `vitest/node`:
// scripts/ has no vitest dependency of its own, and pnpm does not hoist one to the root.
import { writeFileSync } from "node:fs";

/** The part of vitest's `TestModule` the summary reads. */
interface TestModuleLike {
  children: { allTests(): Iterable<unknown> };
}

export interface BunParitySummary {
  bun: string;
  files: number;
  tests: number;
  reason: string;
  unhandledErrors: number;
}

export function summarize(
  bun: string,
  testModules: ReadonlyArray<TestModuleLike>,
  unhandledErrors: number,
  reason: string,
): BunParitySummary {
  let tests = 0;
  for (const module of testModules) tests += Array.from(module.children.allTests()).length;
  return { bun, files: testModules.length, tests, reason, unhandledErrors };
}

export default class BunParityReporter {
  onInit(): void {
    const bun = process.versions.bun;
    if (!bun) {
      throw new Error(
        `bun-parity: vitest is running under Node ${process.version}, not Bun; start it with \`bunx --bun vitest\``,
      );
    }
    console.log(`bun-parity: vitest runtime is Bun ${bun} (${process.execPath})`);
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModuleLike>, unhandledErrors: ReadonlyArray<unknown>, reason: string): void {
    const out = process.env.DECK_BUN_PARITY_SUMMARY;
    if (!out) return;
    writeFileSync(out, JSON.stringify(summarize(process.versions.bun ?? "", testModules, unhandledErrors.length, reason)));
  }
}
