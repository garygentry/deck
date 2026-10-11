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
const binding = (path: string, kind: string) =>
  `info  /${path}/bindings/${kind}  PROVIDER_BINDING_UNSUPPORTED  provider kind '${kind}' does not accept host or service bindings`;
/** The primary fixture's host bindings of snapshot, prometheus and alertmanager, which accept none. */
const HOST_BINDINGS = [binding("hosts/0", "snapshot"), binding("hosts/1", "alertmanager"), binding("hosts/3", "prometheus")];
/**
 * `deck validate` on the primary fixture. Its host bindings of snapshot, prometheus and alertmanager and
 * its service bindings of markdown-tree and file-tree accept none, so each is reported (info)
 * for the overlay layer and again for the merged document, where the services sit at other
 * indices. `between` are the merged document's other findings.
 */
const primaryValidate = (between: string[] = []) =>
  [
    ...HOST_BINDINGS,
    binding("services/2", "markdown-tree"),
    binding("services/3", "file-tree"),
    ...HOST_BINDINGS,
    ...between,
    binding("services/3", "markdown-tree"),
    binding("services/7", "file-tree"),
    "clean (advisory only)",
  ].map((line) => `${line}\n`).join("");
const temporary: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  it("validates the primary fixture as clean (advisory only) with exit 0", () => {
    vi.stubEnv("DECK_ACTIONS_ENABLED", "true");
    const { stdout, stderr } = spyOutput();
    expect(runValidate([cleanDir])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(primaryValidate());
    expect(stderr).not.toHaveBeenCalled();
  });

  it("notes the primary fixture's actions section at info while the actions module is off", () => {
    vi.stubEnv("DECK_ACTIONS_ENABLED", "");
    const { stdout, stderr } = spyOutput();
    expect(runValidate([cleanDir])).toBe(0);
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toBe(
      primaryValidate(['info  /modules/actions  MODULE_SECTION_DISABLED  modules.actions is set, but module "actions" is not enabled (not enabled: DECK_ACTIONS_ENABLED is not true); the section is ignored.']),
    );
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

  it.each([
    [
      "a provider id shared across collections",
      {
        hosts: [{ name: "alpha", bindings: { docker: { id: "containers" } } }],
        integrations: [{ id: "containers", kind: "docker", title: "Docker", baseUrl: "http://docker.invalid" }],
      },
      "PROVIDER_ID_SHARED",
    ],
    [
      "a refused credentialEnv",
      { integrations: [{ id: "status", kind: "gatus", title: "Gatus", baseUrl: "http://gatus.invalid", credentialEnv: "DECK_PORT" }] },
      "MODULE_CREDENTIAL_ENV_REFUSED",
    ],
  ])("renders an estate with %s, as boot accepts it, while deck validate exits 1", (_label, overlay, code) => {
    const estate = tracked({
      "00-base.yaml": { schemaVersion: 2, estate: { name: "advisory" }, hosts: [{ name: "alpha", kind: "vm", purpose: "p" }] },
      "10-overlay.yaml": { schemaVersion: 2, ...overlay },
    });
    const out = join(tracked({}).dir, "rendered.json");
    const { stderr } = spyOutput();

    expect(runRender([estate.dir, "--out", out])).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(renderConfig(estate.dir)).toBe(readFileSync(out, "utf8"));
    expect(runValidate([estate.dir])).toBe(1);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(code);
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
