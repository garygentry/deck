/**
 * Runtime module loading from DECK_MODULES_DIR: discovery, the decision to import, integrity
 * pins and load failures. No server boots here (see runtime-modules-boot.test.ts).
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import {
  checkPins,
  loadRuntimeModules,
  moduleDigest,
  NO_RUNTIME_MODULES,
  readRuntimeManifests,
  type RuntimeModules,
} from "../src/modules/runtime.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples/modules", import.meta.url));

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const manifestOf = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: "1.0.0", deckApi: "^0.1", ...extra });

/** A server entry exporting `{ manifest, init }` for the manifest in its directory. */
const ENTRY = `import manifest from "./deck-module.json" with { type: "json" };
export default { manifest, init() {} };
`;

/** Write a module directory: `deck-module.json` (an object is serialised) plus any files. */
function writeModule(root: string, dirName: string, manifest: unknown, files: Record<string, string> = { "server.mjs": ENTRY }): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, "deck-module.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** A config directory with one layer. */
function configWith(document: Record<string, unknown>): string {
  const dir = tempDir("deck-rt-cfg-");
  writeFileSync(join(dir, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, ...document }));
  return dir;
}

function env(root: string | undefined, enabled = true): Record<string, string | undefined> {
  return { DECK_MODULES_DIR: root, DECK_MODULES_ENABLED: enabled ? "true" : undefined };
}

describe("loadRuntimeModules", () => {
  it("reads nothing when DECK_MODULES_DIR is unset", async () => {
    const importer = vi.fn();
    expect(await loadRuntimeModules({ env: { DECK_MODULES_ENABLED: "true" }, configDir: configWith({}), importer })).toEqual(NO_RUNTIME_MODULES);
    expect(importer).not.toHaveBeenCalled();
  });

  it("imports the example module's server entry and keeps its config rules", async () => {
    const result = await loadRuntimeModules({ env: env(EXAMPLES), configDir: configWith({ modules: { maintenance: { windows: [] } } }) });
    expect(result.loaded).toEqual(["maintenance"]);
    expect(result.loadProblems.size).toBe(0);
    expect(result.codeless.size).toBe(0);
    const module = result.modules.find((candidate) => candidate.manifest.id === "maintenance")!;
    expect(typeof module.init).toBe("function");
    expect(module.configRules).toHaveLength(1);
    expect(result.envGates.get("maintenance")).toBe("DECK_MODULES_ENABLED");
  });

  it("imports no code while DECK_MODULES_ENABLED is off, but keeps every manifest", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "alpha", manifestOf("alpha"));
    const importer = vi.fn();
    for (const enabled of [undefined, "false", "0", "yes"]) {
      const result = await loadRuntimeModules({ env: { DECK_MODULES_DIR: root, DECK_MODULES_ENABLED: enabled }, configDir: configWith({}), importer });
      expect(result.modules.map((module) => module.manifest.id)).toEqual(["alpha"]);
      expect([...result.codeless]).toEqual(["alpha"]);
      expect(result.loaded).toEqual([]);
    }
    expect(importer).not.toHaveBeenCalled();
  });

  it("imports no code for a module that would not run: its own switch off, deckApi unmet, or a bad manifest", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "needs-section", manifestOf("needs-section", { enabledBy: { config: true } }));
    writeModule(root, "needs-env", manifestOf("needs-env", { enabledBy: { env: "NEEDS_ENV_ON" } }));
    writeModule(root, "future", manifestOf("future", { deckApi: "^9" }));
    writeModule(root, "bad-env", manifestOf("bad-env", { env: ["DECK_PORT"] }));
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer });
    expect([...result.codeless].sort()).toEqual(["bad-env", "future", "needs-env", "needs-section"]);
    expect(result.loadProblems.size).toBe(0);
    expect(importer).not.toHaveBeenCalled();

    // With their switches on, the two gated ones load.
    const on = await loadRuntimeModules({
      env: { ...env(root), NEEDS_ENV_ON: "1" },
      configDir: configWith({ modules: { "needs-section": {} } }),
      importer: async () => ({ default: undefined }),
    });
    expect([...on.loadProblems.keys()].sort()).toEqual(["needs-env", "needs-section"]);
    expect(on.loadProblems.get("needs-env")).toContain("no default export");
  });

  it("reports an unreadable manifest, an id that is not its directory, or two entries as a load failure", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "no-manifest", undefined);
    writeModule(root, "bad-json", "{ nope");
    writeModule(root, "array", "[]");
    writeModule(root, "renamed", manifestOf("other"));
    writeModule(root, "two-entries", manifestOf("two-entries"), { "server.js": ENTRY, "server.mjs": ENTRY });
    // Hidden entries and plain files beside the module directories are not modules.
    mkdirSync(join(root, "..data"));
    writeFileSync(join(root, "README.md"), "# modules\n");
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer });
    expect(result.modules.map((module) => module.manifest.id)).toEqual(["array", "bad-json", "no-manifest", "renamed", "two-entries"]);
    expect(result.loadProblems.get("no-manifest")).toContain("deck-module.json is missing");
    expect(result.loadProblems.get("bad-json")).toContain("not valid JSON");
    expect(result.loadProblems.get("array")).toContain("not a JSON object");
    expect(result.loadProblems.get("renamed")).toContain('declares id "other", but its directory is "renamed"');
    expect(result.loadProblems.get("two-entries")).toContain("more than one server entry (server.js, server.mjs)");
    // Each problem names the directory.
    expect(result.loadProblems.get("array")).toContain(join(root, "array"));
    expect(importer).not.toHaveBeenCalled();
  });

  it("reports an entry that throws, exports no module, or declares another manifest", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "throws", manifestOf("throws"), { "server.mjs": `throw new Error("boom at import");\n` });
    writeModule(root, "no-init", manifestOf("no-init"), { "server.mjs": `import manifest from "./deck-module.json" with { type: "json" };\nexport default { manifest };\n` });
    writeModule(root, "drifted", manifestOf("drifted"), { "server.mjs": `export default { manifest: { id: "drifted", version: "2.0.0", deckApi: "^0.1" }, init() {} };\n` });
    writeModule(root, "bad-rules", manifestOf("bad-rules"), { "server.mjs": `import manifest from "./deck-module.json" with { type: "json" };\nexport default { manifest, init() {}, configRules: [1] };\n` });
    writeModule(root, "good", manifestOf("good"));
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}) });
    expect(result.loaded).toEqual(["good"]);
    expect(result.loadProblems.get("throws")).toContain("its server entry failed to import: boom at import");
    expect(result.loadProblems.get("no-init")).toContain("default export has no init function");
    expect(result.loadProblems.get("drifted")).toContain("manifest differs from deck-module.json");
    expect(result.loadProblems.get("bad-rules")).toContain("configRules must be a list of functions");
    expect([...result.codeless].sort()).toEqual(["bad-rules", "drifted", "no-init", "throws"]);
    // A failed module still stands in by its manifest, in directory order.
    expect(result.modules.map((module) => module.manifest.id)).toEqual(["bad-rules", "drifted", "good", "no-init", "throws"]);
  });

  it("loads a module without a server entry as manifest contributions only", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "web-only", manifestOf("web-only"), {});
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}) });
    expect(result.loaded).toEqual(["web-only"]);
    expect(result.codeless.size).toBe(0);
  });

  it("fails a module whose entry never finishes loading", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "hangs", manifestOf("hangs"));
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer: () => new Promise(() => {}), importTimeoutMs: 20 });
    expect(result.loadProblems.get("hangs")).toContain("did not finish loading within 20 ms");
  });

  it("refuses a server entry that resolves outside its module directory", async () => {
    const root = tempDir("deck-rt-");
    const outside = tempDir("deck-rt-outside-");
    writeFileSync(join(outside, "evil.mjs"), ENTRY);
    const dir = writeModule(root, "escapes", manifestOf("escapes"), {});
    symlinkSync(join(outside, "evil.mjs"), join(dir, "server.mjs"));
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer });
    expect(result.loadProblems.get("escapes")).toContain("resolves outside the module directory");
    expect(importer).not.toHaveBeenCalled();
  });

  it("fails boot only when runtime modules are on and the directory cannot be read", async () => {
    const missing = join(tempDir("deck-rt-"), "absent");
    await expect(loadRuntimeModules({ env: env(missing), configDir: configWith({}) })).rejects.toThrow(`DECK_MODULES_DIR ${missing} cannot be read`);
    const off = await loadRuntimeModules({ env: env(missing, false), configDir: configWith({}) });
    expect(off.modules).toEqual([]);
  });

  it("reads the manifests only for deck validate and render", () => {
    const result = readRuntimeManifests({ env: env(EXAMPLES), configDir: configWith({ modules: { maintenance: { windows: [] } } }) });
    expect(result.modules.map((module) => module.manifest.id)).toEqual(["maintenance"]);
    expect([...result.codeless]).toEqual(["maintenance"]);
    expect(result.loaded).toEqual([]);
    expect(result.planOnly).toBe(true);
  });
});

describe("integrity pins", () => {
  it("digests a module directory deterministically, and any edit changes it", () => {
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "pinned", manifestOf("pinned"), { "server.mjs": ENTRY, "lib/util.mjs": "export const x = 1;\n" });
    const digest = moduleDigest(dir);
    expect(digest).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    expect(moduleDigest(dir)).toBe(digest);
    writeFileSync(join(dir, "lib/util.mjs"), "export const x = 2;\n");
    expect(moduleDigest(dir)).not.toBe(digest);
    // A renamed file changes it too, even with the same bytes.
    const other = writeModule(root, "pinned-2", manifestOf("pinned"), { "server.mjs": ENTRY, "lib/utils.mjs": "export const x = 2;\n" });
    expect(moduleDigest(other)).not.toBe(moduleDigest(dir));
  });

  it("loads a module whose directory matches its pin, from any config layer", async () => {
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "pinned", manifestOf("pinned"));
    const config = tempDir("deck-rt-cfg-");
    writeFileSync(join(config, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, moduleIntegrity: { pinned: `sha256-${"A".repeat(43)}=` } }));
    writeFileSync(join(config, "10-overlay.yaml"), stringify({ schemaVersion: 2, moduleIntegrity: { pinned: moduleDigest(dir) } }));
    const result = await loadRuntimeModules({ env: env(root), configDir: config });
    expect(result.loaded).toEqual(["pinned"]);
    expect(result.pins.get("pinned")).toBe(moduleDigest(dir));
  });

  it("imports nothing from a directory that does not match its pin", async () => {
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "pinned", manifestOf("pinned"));
    const pin = moduleDigest(dir);
    writeFileSync(join(dir, "server.mjs"), `${ENTRY}// tampered\n`);
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({ moduleIntegrity: { pinned: pin } }), importer });
    expect(result.loadProblems.get("pinned")).toContain(`does not match the pinned ${pin}`);
    expect(importer).not.toHaveBeenCalled();
  });

  it("imports nothing under a malformed pin, or a pinned directory holding a symbolic link", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "malformed", manifestOf("malformed"));
    const linked = writeModule(root, "linked", manifestOf("linked"));
    symlinkSync("/etc/hostname", join(linked, "data.txt"));
    const importer = vi.fn();
    const result = await loadRuntimeModules({
      env: env(root),
      configDir: configWith({ moduleIntegrity: { malformed: "md5-abc", linked: `sha256-${"A".repeat(43)}=` } }),
      importer,
    });
    expect(result.loadProblems.get("malformed")).toContain("integrity pin is not a sha256-<base64> digest");
    expect(result.loadProblems.get("linked")).toContain('"data.txt" is not a regular file or directory');
    expect(importer).not.toHaveBeenCalled();
  });

  it("imports nothing when a pinned directory cannot be read", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "locked", manifestOf("locked"), { "server.mjs": ENTRY, "private/key.mjs": "export {};\n" });
    chmodSync(join(dir, "private"), 0o000);
    cleanup.push(() => chmodSync(join(dir, "private"), 0o755));
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({ moduleIntegrity: { locked: `sha256-${"A".repeat(43)}=` } }), importer });
    expect(result.loadProblems.get("locked")).toContain("its directory cannot be read");
    expect(importer).not.toHaveBeenCalled();
  });

  it("checkPins: the validated config must hold the pins and sections loading was decided from", () => {
    const runtime: RuntimeModules = {
      ...NO_RUNTIME_MODULES,
      dir: "/modules",
      modules: [{ manifest: manifestOf("a"), init: () => {} }, { manifest: manifestOf("b"), init: () => {} }],
      loaded: ["a"],
      pins: new Map([["a", "sha256-x"]]),
      sections: new Set(["b"]),
    };
    expect(checkPins(runtime, { moduleIntegrity: { a: "sha256-x" }, modules: { b: {} } })).toBeNull();
    expect(checkPins(runtime, { moduleIntegrity: { a: "sha256-y" }, modules: { b: {} } })).toContain('integrity pin of runtime module "a" changed');
    expect(checkPins(runtime, { modules: { b: {} } })).toContain('integrity pin of runtime module "a" changed');
    expect(checkPins(runtime, { moduleIntegrity: { a: "sha256-x" } })).toContain("modules.b section changed");
    // A pin added for a module whose code never loaded changes nothing that ran.
    expect(checkPins(runtime, { moduleIntegrity: { a: "sha256-x", b: "sha256-z" }, modules: { b: {} } })).toBeNull();
  });
});
