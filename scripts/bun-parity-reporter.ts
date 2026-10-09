// Vitest reporter for the CI `bun-parity` job (scripts/bun-parity-vitest.sh).
//
// The job exists to run the unit tests on the runtime that ships, so it must fail loudly when
// they ran somewhere else or not at all:
// - `bunx vitest` without `--bun` follows vitest's `#!/usr/bin/env node` shebang, so the tests
//   run under Node while the job reads green. `onInit` refuses that and prints the Bun version.
// - Some vitest/Bun combinations end the process early with exit 0 and no summary (vitest 1.x
//   cannot start its worker pool on Bun at all). `onTestRunEnd` writes a summary file, and
//   scripts/bun-parity-check.ts fails the step when it is missing or shows an incomplete run.
//
// It declares the slice of vitest's reporter API it uses rather than importing `vitest/node`:
// scripts/ has no vitest dependency of its own, and pnpm does not hoist one to the root.
import { writeFileSync } from "node:fs";

import type { BunParitySummary } from "./bun-parity-check.js";

/** The part of vitest's `TestCase` the summary reads. */
interface TestCaseLike {
  result(): { state: string };
}

/** The part of vitest's `TestModule` the summary reads. */
interface TestModuleLike {
  children: { allTests(): Iterable<TestCaseLike> };
}

/** The part of vitest's `TestSpecification` the summary reads. */
interface TestSpecificationLike {
  moduleId: string;
}

export function summarize(
  bun: string,
  scheduled: number,
  testModules: ReadonlyArray<TestModuleLike>,
  unhandledErrors: number,
  reason: string,
): BunParitySummary {
  let tests = 0;
  let executed = 0;
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
      tests += 1;
      const { state } = test.result();
      if (state === "passed" || state === "failed") executed += 1;
    }
  }
  return { bun, scheduled, files: testModules.length, tests, executed, reason, unhandledErrors };
}

export default class BunParityReporter {
  #scheduled = 0;

  onInit(): void {
    const bun = process.versions.bun;
    if (!bun) {
      throw new Error(
        `bun-parity: vitest is running under Node ${process.version}, not Bun; start it with \`bunx --bun vitest\``,
      );
    }
    console.log(`bun-parity: vitest runtime is Bun ${bun} (${process.execPath})`);
  }

  /** The files vitest means to run, so the summary can show whether any were dropped. */
  onTestRunStart(specifications: ReadonlyArray<TestSpecificationLike>): void {
    this.#scheduled = new Set(specifications.map((specification) => specification.moduleId)).size;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModuleLike>, unhandledErrors: ReadonlyArray<unknown>, reason: string): void {
    const out = process.env.DECK_BUN_PARITY_SUMMARY;
    if (!out) return;
    const summary = summarize(process.versions.bun ?? "", this.#scheduled, testModules, unhandledErrors.length, reason);
    writeFileSync(out, JSON.stringify(summary));
  }
}
