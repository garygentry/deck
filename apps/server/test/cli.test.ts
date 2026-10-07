import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding } from "@deck/schema";
import { invalid, primary } from "@deck/schema/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../src/config/canonical.js";
import { main } from "../src/cli/deck.js";
import { formatFinding, formatToolError } from "../src/cli/findings-format.js";
import { renderConfig, runRender } from "../src/cli/render.js";
import { runSnapshot, runSnapshotValidate } from "../src/cli/snapshot.js";
import { runValidate } from "../src/cli/validate.js";
import { makeConfigDir } from "./util/tmp-config.js";

const cleanDir = dirname(primary.paths.base);
const temporary: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temporary.length) temporary.pop()!();
});

function tracked(layers: Record<string, unknown>) {
  const result = makeConfigDir(layers);
  temporary.push(result.cleanup);
  return result;
}

function spyOutput() {
  return {
    stdout: vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  };
}

describe("deck CLI", () => {
  it("validates the primary fixture as clean with exit 0", () => {
    const { stdout, stderr } = spyOutput();
    expect(runValidate([cleanDir])).toBe(0);
    expect(stdout).toHaveBeenCalledWith("clean\n");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("returns exit 1 and prints every invalid finding with severity and path", () => {
    const fixture = invalid.find(({ layer }) => layer === "base")!;
    const { dir } = tracked({ "00-base.yaml": fixture.document });
    const { stderr } = spyOutput();
    expect(runValidate(["--config", dir])).toBe(1);
    const output = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(output).toContain(fixture.expect);
    for (const line of output.trim().split("\n")) {
      expect(line).toMatch(/^(error|warning|info)  \/.*  \S+  \S/);
    }
  });

  it("returns exit 2 for a missing directory", () => {
    const missing = join(process.cwd(), "missing-cli-config");
    const { stderr } = spyOutput();
    expect(runValidate([missing])).toBe(2);
    expect(String(stderr.mock.calls[0][0])).toContain("CONFIG_DIR_MISSING");
  });

  it("returns exit 2 and usage for an unknown or missing subcommand", () => {
    const { stderr } = spyOutput();
    expect(main(["unknown"])).toBe(2);
    expect(main([])).toBe(2);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(String(stderr.mock.calls[0][0])).toContain("usage: deck");
  });

  it("renders canonical output only for exit 0", () => {
    const outputDir = tracked({});
    const cleanOut = join(outputDir.dir, "clean.json");
    const invalidOut = join(outputDir.dir, "invalid.json");
    const missingOut = join(outputDir.dir, "missing.json");
    const fixture = invalid.find(({ layer }) => layer === "base")!;
    const invalidDir = tracked({ "00-base.yaml": fixture.document });
    spyOutput();

    expect(runRender([cleanDir, "--out", cleanOut])).toBe(0);
    expect(readFileSync(cleanOut, "utf8")).toBe(canonicalize(primary.merged));
    expect(runRender([invalidDir.dir, "--out", invalidOut])).toBe(1);
    expect(runRender([join(outputDir.dir, "absent"), "--out", missingOut])).toBe(2);
    expect(existsSync(invalidOut)).toBe(false);
    expect(existsSync(missingOut)).toBe(false);
  });

  it("renderConfig returns the clean canonical render", () => {
    expect(renderConfig(cleanDir)).toBe(canonicalize(primary.merged));
  });

  it("validates a clean snapshot file with exit 0", () => {
    const { stdout, stderr } = spyOutput();
    expect(runSnapshotValidate([primary.paths.snapshots.combined])).toBe(0);
    expect(stdout).toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("returns exit 1 for a schema-invalid snapshot document", () => {
    const { dir } = tracked({});
    const file = join(dir, "bad.json");
    const broken = structuredClone(primary.snapshots.combined) as { hosts?: Array<{ name: unknown }> };
    broken.hosts![0].name = 123; // type violation → ajv error finding
    writeFileSync(file, JSON.stringify(broken));
    const { stderr } = spyOutput();
    expect(runSnapshotValidate([file])).toBe(1);
    const output = stderr.mock.calls.map(([text]) => String(text)).join("");
    for (const line of output.trim().split("\n")) {
      expect(line).toMatch(/^(error|warning|info)  \/.*  \S+  \S/);
    }
  });

  it("returns exit 2 for a missing snapshot file", () => {
    const { stderr } = spyOutput();
    expect(runSnapshotValidate([join(process.cwd(), "missing-snapshot.json")])).toBe(2);
    expect(String(stderr.mock.calls[0][0])).toContain("SNAPSHOT_FILE_UNREADABLE");
  });

  it("returns exit 2 for a malformed-JSON snapshot file", () => {
    const { dir } = tracked({});
    const file = join(dir, "garbage.json");
    writeFileSync(file, "{ not valid json");
    const { stderr } = spyOutput();
    expect(runSnapshotValidate([file])).toBe(2);
    expect(String(stderr.mock.calls[0][0])).toContain("SNAPSHOT_JSON_PARSE");
  });

  it("returns exit 2 and usage for snapshot without a file or an unknown action", () => {
    const { stderr } = spyOutput();
    expect(runSnapshotValidate([])).toBe(2);
    expect(runSnapshot(["frobnicate"])).toBe(2);
    expect(main(["snapshot"])).toBe(2);
    expect(String(stderr.mock.calls[0][0])).toContain("usage: deck snapshot validate");
  });

  it("dispatches snapshot validate through main", () => {
    spyOutput();
    expect(main(["snapshot", "validate", primary.paths.snapshots.combined])).toBe(0);
  });

  it("formats findings and tool errors without stack traces", () => {
    const finding: Finding = {
      severity: "warning",
      path: "/hosts/0/name",
      code: "HOST_DUPLICATE",
      message: "duplicate host",
    };
    expect(formatFinding(finding)).toBe(
      `${finding.severity}  ${finding.path || "/"}  ${finding.code}  ${finding.message}`,
    );
    const formatted = formatToolError({ code: "CONFIG_DIR_MISSING", path: "/tmp/nope", message: "missing" });
    expect(formatted).toBe("CONFIG_DIR_MISSING  /tmp/nope  missing");
    expect(formatted).not.toContain("Error:");
    expect(formatted).not.toContain(" at ");
  });
});
