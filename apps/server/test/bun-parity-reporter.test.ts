import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import BunParityReporter, { summarize } from "../../../scripts/bun-parity-reporter.js";

const moduleWith = (count: number) => ({
  children: { allTests: () => Array.from({ length: count }, (_, i) => ({ id: String(i) })) },
});

describe("bun-parity reporter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("counts tests across every module", () => {
    const modules = [moduleWith(2), moduleWith(0), moduleWith(3)];
    expect(summarize("1.4.2", modules, 0, "passed")).toEqual({
      bun: "1.4.2",
      files: 3,
      tests: 5,
      reason: "passed",
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

  it("writes the summary the wrapper script requires", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-parity-"));
    try {
      const out = join(dir, "summary.json");
      vi.stubEnv("DECK_BUN_PARITY_SUMMARY", out);
      new BunParityReporter().onTestRunEnd([moduleWith(4)], [], "passed");
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ files: 1, tests: 4, reason: "passed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
