// Judge a bun-parity vitest run from the summary scripts/bun-parity-reporter.ts wrote. The
// command is scripts/bun-parity-check-cli.ts <summary.json>, which calls `main`.
//
// A run fails unless it was under Bun, reached its end, completed every scheduled test file,
// executed at least one test (skipped tests do not count), passed, and raised no unhandled
// errors. A missing summary means vitest exited before its run ended. Erasable TypeScript only,
// so it runs under Bun and under Node's type stripping alike.
import { existsSync, readFileSync } from "node:fs";

export interface BunParitySummary {
  /** `process.versions.bun` of the vitest process; empty under Node. */
  bun: string;
  /** Test files vitest scheduled at the start of the run. */
  scheduled: number;
  /** Test files the run-end report lists, finished or not. */
  listed: number;
  /** Listed test files that finished: terminal state and no test still pending. */
  files: number;
  /** Tests collected, in any state. */
  tests: number;
  /** Tests that ran: passed or failed, not skipped or pending. */
  executed: number;
  /** vitest's run-end reason: "passed", "failed" or "interrupted". */
  reason: string;
  unhandledErrors: number;
}

/** Every reason the run does not count; empty when it does. */
export function verdict(summary: BunParitySummary): string[] {
  const problems: string[] = [];
  if (!summary.bun) problems.push("the run did not report a Bun runtime");
  if (summary.reason !== "passed") problems.push(`the run ended "${summary.reason}", not "passed"`);
  if (summary.unhandledErrors > 0) problems.push(`the run raised ${summary.unhandledErrors} unhandled error(s)`);
  if (summary.scheduled < 1) {
    problems.push("the run scheduled no test files (the reporter's onTestRunStart never ran)");
  } else if (summary.files !== summary.scheduled) {
    problems.push(
      `${summary.files} of ${summary.scheduled} scheduled test files completed (${summary.listed} listed at the end of the run)`,
    );
  }
  if (summary.executed < 1) problems.push(`no test executed (${summary.tests} collected)`);
  return problems;
}

/** Judge the summary at `file`, printing it and every problem; the process exit code. */
export function main(file: string | undefined): number {
  if (file === undefined) {
    console.error("usage: bun-parity-check-cli.ts <summary.json>");
    return 2;
  }
  if (!existsSync(file) || readFileSync(file, "utf8").trim() === "") {
    console.error("bun-parity: vitest exited but never reached the end of its run (no summary written)");
    return 1;
  }
  const summary = JSON.parse(readFileSync(file, "utf8")) as BunParitySummary;
  console.log(`bun-parity: summary ${JSON.stringify(summary)}`);
  const problems = verdict(summary);
  for (const problem of problems) console.error(`bun-parity: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}
