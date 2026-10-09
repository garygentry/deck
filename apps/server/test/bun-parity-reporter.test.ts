import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type BunParitySummary, verdict } from "../../../scripts/bun-parity-check.js";
import BunParityReporter, { summarize } from "../../../scripts/bun-parity-reporter.js";

const CHECK = fileURLToPath(new URL("../../../scripts/bun-parity-check-cli.ts", import.meta.url));

/** A fake vitest TestModule in `moduleState` whose tests ended in the given states. */
const fileIn = (moduleState: string, ...states: string[]) => ({
  state: () => moduleState,
  children: { allTests: () => states.map((state) => ({ result: () => ({ state }) })) },
});
/** A finished test file whose tests ended in the given states. */
const moduleWith = (...states: string[]) => fileIn(states.includes("failed") ? "failed" : "passed", ...states);

const PASSING: BunParitySummary = {
  bun: "1.4.2",
  scheduled: 2,
  listed: 2,
  files: 2,
  tests: 3,
  executed: 3,
  reason: "passed",
  unhandledErrors: 0,
};

const scratch: string[] = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-parity-"));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("bun-parity reporter", () => {
  it("counts only executed tests and only completed files", () => {
    const modules = [moduleWith("passed", "skipped"), fileIn("pending", "pending"), moduleWith("failed", "passed")];
    expect(summarize("1.4.2", 3, modules, 0, "failed")).toEqual({
      bun: "1.4.2",
      scheduled: 3,
      listed: 3,
      // The middle file is still "pending" (it has a pending test), so it did not complete.
      files: 2,
      tests: 5,
      executed: 3,
      reason: "failed",
      unhandledErrors: 0,
    });
  });

  it("refuses to run unless the runtime is Bun", () => {
    const init = () => new BunParityReporter().onInit();
    if (process.versions.bun) {
      // The bun-parity CI job takes this branch: it must announce Bun, not throw.
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      init();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`Bun ${process.versions.bun}`));
      log.mockRestore();
    } else {
      expect(init).toThrow(/running under Node .*bunx --bun vitest/);
    }
  });

  it("records each scheduled file once and writes the summary the check reads", () => {
    const out = join(scratchDir(), "summary.json");
    vi.stubEnv("DECK_BUN_PARITY_SUMMARY", out);
    const reporter = new BunParityReporter();
    // One file can be scheduled once per project; it is still one file.
    reporter.onTestRunStart([{ moduleId: "/a.test.ts" }, { moduleId: "/a.test.ts" }, { moduleId: "/b.test.ts" }]);
    reporter.onTestRunEnd([moduleWith("passed", "passed")], [], "passed");
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      scheduled: 2,
      listed: 1,
      files: 1,
      tests: 2,
      executed: 2,
      reason: "passed",
    });
  });

  it.each([
    ["queued", fileIn("queued", "pending")],
    ["pending, a test still running", fileIn("pending", "passed", "pending")],
    ["passed, a test still pending", fileIn("passed", "passed", "pending")],
  ])("a listed file that is %s is not completed: the check fails the run", (_label, unfinished) => {
    const out = join(scratchDir(), "summary.json");
    vi.stubEnv("DECK_BUN_PARITY_SUMMARY", out);
    const reporter = new BunParityReporter();
    reporter.onTestRunStart([{ moduleId: "/a.test.ts" }, { moduleId: "/b.test.ts" }]);
    reporter.onTestRunEnd([moduleWith("passed"), unfinished], [], "passed");
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ scheduled: 2, listed: 2, files: 1 });
    const run = spawnSync(process.execPath, [CHECK, out], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain("1 of 2 scheduled test files completed (2 listed at the end of the run)");
  });

  it("a file skipped by design counts as completed", () => {
    expect(summarize("1.4.2", 2, [moduleWith("passed"), fileIn("skipped", "skipped", "skipped")], 0, "passed")).toMatchObject({
      files: 2,
      executed: 1,
    });
  });
});

describe("bun-parity check", () => {
  it.each<[string, Partial<BunParitySummary>, RegExp]>([
    ["a Node runtime", { bun: "" }, /did not report a Bun runtime/],
    ["a failed run", { reason: "failed" }, /ended "failed"/],
    ["an interrupted run", { reason: "interrupted" }, /ended "interrupted"/],
    ["unhandled errors", { unhandledErrors: 2 }, /2 unhandled error/],
    ["unfinished test files", { scheduled: 5, listed: 5, files: 3 }, /3 of 5 scheduled test files completed \(5 listed/],
    ["more completed files than scheduled", { scheduled: 1, files: 2 }, /2 of 1 scheduled test files completed/],
    ["no scheduled files (onTestRunStart never ran)", { scheduled: 0, listed: 2, files: 2 }, /scheduled no test files/],
    ["only skipped tests", { tests: 4, executed: 0 }, /no test executed \(4 collected\)/],
    ["no tests at all", { tests: 0, executed: 0 }, /no test executed/],
  ])("rejects %s", (_label, change, problem) => {
    expect(verdict({ ...PASSING, ...change })).toEqual([expect.stringMatching(problem)]);
  });

  it("accepts a complete, passing run", () => {
    expect(verdict(PASSING)).toEqual([]);
  });

  // The wrapper's decision after vitest exits 0 is this script's exit code, so drive it as the
  // wrapper does: one process per summary, on whichever runtime runs this suite.
  const runCheck = (summary: BunParitySummary | undefined, script = CHECK) => {
    const file = join(scratchDir(), "summary.json");
    if (summary !== undefined) writeFileSync(file, JSON.stringify(summary));
    return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  };

  it.each<[string, BunParitySummary | undefined]>([
    ["no summary (vitest exited before the end of its run)", undefined],
    ["a failed run", { ...PASSING, reason: "failed" }],
    ["an interrupted run", { ...PASSING, reason: "interrupted" }],
    ["unhandled errors", { ...PASSING, unhandledErrors: 1 }],
    ["unfinished test files", { ...PASSING, scheduled: 3, listed: 3 }],
    ["no scheduled files", { ...PASSING, scheduled: 0 }],
    ["no executed tests", { ...PASSING, executed: 0 }],
  ])("as a script, exits 1 for %s", (_label, summary) => {
    const run = runCheck(summary);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(/bun-parity: /);
  });

  it("as a script reached through a symlink, still judges the run", () => {
    // A "was I run directly?" guard compares paths and would skip the check here (exit 0).
    const link = join(scratchDir(), "check-link.ts");
    symlinkSync(CHECK, link);
    const failed = runCheck({ ...PASSING, reason: "failed" }, link);
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stderr).toContain('ended "failed"');
    expect(runCheck(PASSING, link).status).toBe(0);
  });

  it("as a script, exits 0 for a complete, passing run", () => {
    const run = runCheck(PASSING);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`bun-parity: summary ${JSON.stringify(PASSING)}`);
  });
});
