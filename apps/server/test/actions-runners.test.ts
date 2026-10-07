import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIONS_ENV,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_ACTIONS_ENABLED,
  resolveActionsRuntime,
} from "../src/actions/runtime.js";
import { loadRunners, lookupRunner } from "../src/actions/runners.js";

/** A throwaway scratch dir cleaned up after each test. */
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-runners-"));
  scratchDirs.push(dir);
  return dir;
}

/** Write a real executable file in a scratch dir and return its absolute path. */
function realRunner(name: string): string {
  const dir = scratch();
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho hi\n");
  return path;
}

/** Write a manifest JSON file and return its absolute path. */
function manifestFile(content: string): string {
  const dir = scratch();
  const path = join(dir, "runners.json");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveActionsRuntime", () => {
  it("returns an inert runtime and reads no manifest when disabled (empty env)", () => {
    const runtime = resolveActionsRuntime({});
    expect(runtime.enabled).toBe(false);
    expect(runtime.timeoutMs).toBe(DEFAULT_ACTION_TIMEOUT_MS);
    expect(runtime.dataDir).toBe("");
    expect(runtime.runners.size).toBe(0);
    // Sanity: DEFAULT_ACTIONS_ENABLED is the safe-by-default false.
    expect(DEFAULT_ACTIONS_ENABLED).toBe(false);
  });

  it("stays disabled for a non-truthy DECK_ACTIONS_ENABLED and reads no manifest", () => {
    // A bogus runners file path would throw if read; it must not be read while disabled.
    const runtime = resolveActionsRuntime({
      [ACTIONS_ENV.ENABLED]: "false",
      [ACTIONS_ENV.DATA_DIR]: "/nope",
      [ACTIONS_ENV.RUNNERS_FILE]: "/does/not/exist.json",
    });
    expect(runtime.enabled).toBe(false);
    expect(runtime.runners.size).toBe(0);
  });

  it("treats 'true'/'1' (case-insensitive) as enabled", () => {
    const runner = realRunner("restart");
    const file = manifestFile(JSON.stringify({ restart: runner }));
    for (const raw of ["true", "TRUE", "1"]) {
      const runtime = resolveActionsRuntime({
        [ACTIONS_ENV.ENABLED]: raw,
        [ACTIONS_ENV.DATA_DIR]: scratch(),
        [ACTIONS_ENV.RUNNERS_FILE]: file,
      });
      expect(runtime.enabled).toBe(true);
    }
  });

  it("resolves an enabled runtime with runners populated from the manifest", () => {
    const runner = realRunner("restart");
    const file = manifestFile(JSON.stringify({ restart: runner }));
    const dataDir = scratch();

    const runtime = resolveActionsRuntime({
      [ACTIONS_ENV.ENABLED]: "true",
      [ACTIONS_ENV.DATA_DIR]: dataDir,
      [ACTIONS_ENV.RUNNERS_FILE]: file,
    });

    expect(runtime.enabled).toBe(true);
    expect(runtime.dataDir).toBe(dataDir);
    expect(runtime.timeoutMs).toBe(DEFAULT_ACTION_TIMEOUT_MS);
    expect(runtime.runners.get("restart")).toBe(runner);
  });

  it("throws ACTIONS_CONFIG_INVALID when enabled but DECK_DATA_DIR is missing", () => {
    const file = manifestFile(JSON.stringify({ restart: realRunner("restart") }));
    expect(() =>
      resolveActionsRuntime({
        [ACTIONS_ENV.ENABLED]: "true",
        [ACTIONS_ENV.RUNNERS_FILE]: file,
      }),
    ).toThrow(expect.objectContaining({ code: "ACTIONS_CONFIG_INVALID" }));
  });

  it("throws ACTIONS_CONFIG_INVALID when enabled but DECK_RUNNERS_FILE is missing", () => {
    expect(() =>
      resolveActionsRuntime({
        [ACTIONS_ENV.ENABLED]: "true",
        [ACTIONS_ENV.DATA_DIR]: scratch(),
      }),
    ).toThrow(expect.objectContaining({ code: "ACTIONS_CONFIG_INVALID" }));
  });

  it("treats an empty-string required env var as missing", () => {
    const file = manifestFile(JSON.stringify({ restart: realRunner("restart") }));
    expect(() =>
      resolveActionsRuntime({
        [ACTIONS_ENV.ENABLED]: "true",
        [ACTIONS_ENV.DATA_DIR]: "   ",
        [ACTIONS_ENV.RUNNERS_FILE]: file,
      }),
    ).toThrow(expect.objectContaining({ code: "ACTIONS_CONFIG_INVALID" }));
  });

  it("honors a valid positive-integer DECK_ACTION_TIMEOUT_MS", () => {
    const file = manifestFile(JSON.stringify({ restart: realRunner("restart") }));
    const runtime = resolveActionsRuntime({
      [ACTIONS_ENV.ENABLED]: "true",
      [ACTIONS_ENV.DATA_DIR]: scratch(),
      [ACTIONS_ENV.RUNNERS_FILE]: file,
      [ACTIONS_ENV.TIMEOUT_MS]: "1234",
    });
    expect(runtime.timeoutMs).toBe(1234);
  });

  it("uses the default timeout when DECK_ACTION_TIMEOUT_MS is unset", () => {
    const file = manifestFile(JSON.stringify({ restart: realRunner("restart") }));
    const runtime = resolveActionsRuntime({
      [ACTIONS_ENV.ENABLED]: "true",
      [ACTIONS_ENV.DATA_DIR]: scratch(),
      [ACTIONS_ENV.RUNNERS_FILE]: file,
    });
    expect(runtime.timeoutMs).toBe(DEFAULT_ACTION_TIMEOUT_MS);
  });

  it("throws for a non-positive or non-integer DECK_ACTION_TIMEOUT_MS", () => {
    const file = manifestFile(JSON.stringify({ restart: realRunner("restart") }));
    for (const bad of ["0", "-5", "1.5", "abc", "12px"]) {
      expect(() =>
        resolveActionsRuntime({
          [ACTIONS_ENV.ENABLED]: "true",
          [ACTIONS_ENV.DATA_DIR]: scratch(),
          [ACTIONS_ENV.RUNNERS_FILE]: file,
          [ACTIONS_ENV.TIMEOUT_MS]: bad,
        }),
      ).toThrow(expect.objectContaining({ code: "ACTIONS_CONFIG_INVALID" }));
    }
  });
});

describe("loadRunners", () => {
  it("returns a populated ReadonlyMap for a well-formed manifest", () => {
    const a = realRunner("restart");
    const b = realRunner("backup");
    const file = manifestFile(JSON.stringify({ restart: a, backup: b }));

    const runners = loadRunners(file);
    expect(runners.get("restart")).toBe(a);
    expect(runners.get("backup")).toBe(b);
    expect(runners.size).toBe(2);
  });

  it("throws RUNNERS_MANIFEST_INVALID when the file is unreadable", () => {
    expect(() => loadRunners(join(scratch(), "missing.json"))).toThrow(
      expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
    );
  });

  it("throws RUNNERS_MANIFEST_INVALID for malformed JSON", () => {
    const file = manifestFile("{ not valid json ");
    expect(() => loadRunners(file)).toThrow(
      expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
    );
  });

  it("throws RUNNERS_MANIFEST_INVALID for a non-object root (array/null/scalar)", () => {
    for (const content of ["[]", "null", '"str"', "42"]) {
      const file = manifestFile(content);
      expect(() => loadRunners(file)).toThrow(
        expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
      );
    }
  });

  it("throws RUNNERS_MANIFEST_INVALID for a non-string value", () => {
    const file = manifestFile(JSON.stringify({ restart: 123 }));
    expect(() => loadRunners(file)).toThrow(
      expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
    );
  });

  it("throws RUNNERS_MANIFEST_INVALID for a relative path value", () => {
    const file = manifestFile(JSON.stringify({ restart: "relative/path" }));
    expect(() => loadRunners(file)).toThrow(
      expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
    );
  });

  it("throws RUNNERS_MANIFEST_INVALID for a missing target file", () => {
    const file = manifestFile(JSON.stringify({ restart: "/does/not/exist/runner" }));
    expect(() => loadRunners(file)).toThrow(
      expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
    );
  });

  it("throws RUNNERS_MANIFEST_INVALID when the target is a directory, not a file", () => {
    const dir = scratch();
    const file = manifestFile(JSON.stringify({ restart: dir }));
    expect(() => loadRunners(file)).toThrow(
      expect.objectContaining({ code: "RUNNERS_MANIFEST_INVALID" }),
    );
  });
});

describe("lookupRunner", () => {
  it("returns the absolute path for a known name and undefined for an unknown one", () => {
    const runner = realRunner("restart");
    const runners = new Map<string, string>([["restart", runner]]);
    expect(lookupRunner(runners, "restart")).toBe(runner);
    expect(lookupRunner(runners, "nope")).toBeUndefined();
  });

  it("never touches the filesystem and never derives a path from the name", () => {
    // A name that looks like a traversal attempt is a plain miss — no join/resolve.
    const runners = new Map<string, string>([["restart", "/opt/runners/restart"]]);
    expect(lookupRunner(runners, "../../etc/passwd")).toBeUndefined();
    expect(lookupRunner(runners, "restart/../backup")).toBeUndefined();

    // Source discipline: the name is used only as a Map key — no join()/resolve() calls
    // anywhere in runners.ts (REQ-SEC-03, CON-01).
    const src = readFileSync(
      fileURLToPath(new URL("../src/actions/runners.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/\bjoin\s*\(/);
    expect(src).not.toMatch(/\bresolve\s*\(/);
  });
});
