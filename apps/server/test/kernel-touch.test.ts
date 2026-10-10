import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  changedPaths,
  globToRegExp,
  isKernelPath,
  KERNEL_PATHS,
  kernelTouches,
  parityGateTouches,
} from "../../../scripts/kernel-touch.js";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("kernel-touch", () => {
  it("compiles globs with segment-aware wildcards", () => {
    expect(globToRegExp("apps/web/src/ui/**").test("apps/web/src/ui/patterns/Meter.tsx")).toBe(true);
    expect(globToRegExp("**/test/**").test("apps/server/test/boot.test.ts")).toBe(true);
    expect(globToRegExp("**/test/**").test("test/x.ts")).toBe(true);
    expect(globToRegExp("apps/*/index.html").test("apps/web/index.html")).toBe(true);
    expect(globToRegExp("apps/*/index.html").test("apps/web/src/index.html")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("classifies kernel files, module files and tests", () => {
    expect(isKernelPath("apps/server/src/server/boot.ts")).toBe(true);
    expect(isKernelPath("apps/server/src/providers/registry.ts")).toBe(true);
    expect(isKernelPath("packages/schema/schema/deck.schema.json")).toBe(true);
    expect(isKernelPath("apps/web/src/ui/lib/icons.ts")).toBe(true);
    expect(isKernelPath("apps/web/src/shell/manifest-slot.ts")).toBe(true);
    // The UI manifest resolver and the kernel-wired features' UI declarations.
    expect(isKernelPath("apps/server/src/ui/resolve.ts")).toBe(true);
    expect(isKernelPath("apps/server/src/ui/kernel-features.ts")).toBe(true);
    // The web's shared data layer.
    expect(isKernelPath("apps/web/src/data/hooks.ts")).toBe(true);
    // The guardrail test is listed explicitly, so it counts despite the test exclusion.
    expect(isKernelPath("apps/web/test/ui-guardrails.test.ts")).toBe(true);

    expect(isKernelPath("modules/llm-usage/server/collector.ts")).toBe(false);
    expect(isKernelPath("apps/server/src/providers/prometheus/index.ts")).toBe(false);
    expect(isKernelPath("modules/docker/server/index.ts")).toBe(false);
    expect(isKernelPath("modules/llm-usage/web/LlmUsagePage.tsx")).toBe(false);
    expect(isKernelPath("apps/server/test/boot.test.ts")).toBe(false);
    expect(isKernelPath("packages/schema/src/fixtures/primary/00-base.yaml")).toBe(false);
    expect(isKernelPath("docs/guides/llm-usage.md")).toBe(false);
  });

  it("reports the llm-usage feature's kernel seams and nothing feature-local", () => {
    const touched = kernelTouches([
      "modules/llm-usage/server/collector.ts",
      "apps/server/src/server/app.ts",
      "apps/server/src/server/boot.ts",
      "apps/server/src/contract/api.ts",
      "packages/schema/src/ownership.ts",
      "modules/llm-usage/web/index.ts",
      "apps/web/src/shell/manifest-slot.ts",
      "apps/server/test/llm-usage-io.test.ts",
      "apps/server/src/server/app.ts",
      "",
    ]);
    expect(touched).toEqual([
      "apps/server/src/contract/api.ts",
      "apps/server/src/server/app.ts",
      "apps/server/src/server/boot.ts",
      "apps/web/src/shell/manifest-slot.ts",
      "packages/schema/src/ownership.ts",
    ]);
  });

  it("every concrete kernel path exists in the repo", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n");
    // Paths for the module host and SDK land later in the module-architecture work.
    const future = new Set(["packages/module-sdk/**", "apps/server/src/modules/**"]);
    for (const glob of KERNEL_PATHS.filter((path) => !future.has(path))) {
      const pattern = globToRegExp(glob);
      expect(tracked.some((path) => pattern.test(path)), glob).toBe(true);
    }
  });

  it("reports parity-gate files on their own, never as kernel", () => {
    const paths = [
      "apps/server/test/golden/parity/v1-estate.json",
      "apps/server/test/parity/harness.ts",
      "apps/server/test/parity-golden.test.ts",
      "apps/server/test/fixtures/v1-estate/00-base.yaml",
      "apps/server/test/fixtures/portal-estate/00-base.yaml",
      "apps/server/test/fixtures/prometheus/warn.json",
      "packages/schema/src/fixtures/primary/00-base.yaml",
      "apps/server/test/fixtures/markdown-tree/index.md",
      "apps/server/src/server/app.ts",
    ];
    expect(parityGateTouches(paths)).toEqual([
      "apps/server/test/fixtures/portal-estate/00-base.yaml",
      "apps/server/test/fixtures/prometheus/warn.json",
      "apps/server/test/fixtures/v1-estate/00-base.yaml",
      "apps/server/test/golden/parity/v1-estate.json",
      "apps/server/test/parity-golden.test.ts",
      "apps/server/test/parity/harness.ts",
      "packages/schema/src/fixtures/primary/00-base.yaml",
    ]);
    expect(kernelTouches(paths)).toEqual(["apps/server/src/server/app.ts"]);
  });

  it("counts a kernel file moved out of the kernel", () => {
    const repo = mkdtempSync(join(tmpdir(), "kernel-touch-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      run("init", "-q");
      run("config", "user.email", "parity@example.invalid");
      run("config", "user.name", "parity");
      run("config", "commit.gpgsign", "false");
      const from = "apps/server/src/server/app.ts";
      mkdirSync(join(repo, dirname(from)), { recursive: true });
      writeFileSync(join(repo, from), "export const app = 1;\n".repeat(20));
      run("add", ".");
      run("commit", "-q", "-m", "before");
      mkdirSync(join(repo, "apps/server/src/llm"), { recursive: true });
      run("mv", from, "apps/server/src/llm/routes.ts");
      run("commit", "-q", "-m", "move");

      const changed = changedPaths({ base: "main", range: "HEAD~1...HEAD", stdin: false, json: false }, repo);
      expect(changed.sort()).toEqual(["apps/server/src/llm/routes.ts", from]);
      expect(kernelTouches(changed)).toEqual([from]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("lists untracked files repo-relative when run from a subdirectory", () => {
    const repo = mkdtempSync(join(tmpdir(), "kernel-touch-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      run("init", "-q", "-b", "main");
      run("config", "user.email", "parity@example.invalid");
      run("config", "user.name", "parity");
      run("config", "commit.gpgsign", "false");
      run("commit", "-q", "--allow-empty", "-m", "root");
      const kernelFile = "apps/server/src/server/new-route.ts";
      mkdirSync(join(repo, dirname(kernelFile)), { recursive: true });
      writeFileSync(join(repo, kernelFile), "export {};\n");

      const changed = changedPaths({ base: "main", stdin: false, json: false }, join(repo, "apps/server"));
      expect(kernelTouches(changed)).toEqual([kernelFile]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
