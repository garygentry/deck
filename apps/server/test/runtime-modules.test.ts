/**
 * Runtime module loading from DECK_MODULES_DIR: discovery, the plan that decides what to
 * import, integrity pins and load failures. No server boots here (see
 * runtime-modules-boot.test.ts).
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

/** A config directory: one base layer, plus an overlay when given. */
function configWith(document: Record<string, unknown>, overlay?: Record<string, unknown>): string {
  const dir = tempDir("deck-rt-cfg-");
  writeFileSync(join(dir, "00-base.yaml"), stringify({ schemaVersion: 2, estate: { name: "lab" }, ...document }));
  if (overlay !== undefined) writeFileSync(join(dir, "10-overlay.yaml"), stringify({ schemaVersion: 2, ...overlay }));
  return dir;
}

function env(root: string | undefined, enabled = true): Record<string, string | undefined> {
  return { DECK_MODULES_DIR: root, DECK_MODULES_ENABLED: enabled ? "true" : undefined };
}

/** An importer that records what it was asked to import, then imports it. */
function spyImporter() {
  return vi.fn((url: string) => import(url));
}

const ids = (result: RuntimeModules) => result.modules.map((module) => module.manifest.id);

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

  it("imports no code while DECK_MODULES_ENABLED is off; broken directories are inert, not failures", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "alpha", manifestOf("alpha"));
    writeModule(root, "broken", "{ nope");
    const importer = vi.fn();
    for (const enabled of [undefined, "false", "0", "yes"]) {
      const result = await loadRuntimeModules({ env: { DECK_MODULES_DIR: root, DECK_MODULES_ENABLED: enabled }, configDir: configWith({}), importer });
      expect(ids(result)).toEqual(["alpha", "broken"]);
      expect([...result.codeless]).toEqual(["alpha", "broken"]);
      expect(result.loadProblems.size).toBe(0);
      expect(result.loaded).toEqual([]);
    }
    expect(importer).not.toHaveBeenCalled();
  });

  it("imports only the modules the full plan enables, by the host's own rules", async () => {
    const root = tempDir("deck-rt-");
    const marker = join(tempDir("deck-rt-marker-"), "ran");
    const sideEffect = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n${ENTRY}`;
    const files = { "server.mjs": sideEffect };
    writeModule(root, "needs-section", manifestOf("needs-section", { enabledBy: { config: true } }), files);
    writeModule(root, "needs-env", manifestOf("needs-env", { enabledBy: { env: "NEEDS_ENV_ON" } }), files);
    writeModule(root, "future", manifestOf("future", { deckApi: "^9" }), files);
    writeModule(root, "bad-env", manifestOf("bad-env", { env: ["DECK_PORT"] }), files);
    writeModule(root, "orphan", manifestOf("orphan", { dependsOn: ["absent"] }), files);
    writeModule(root, "legacy-data", manifestOf("legacy-data", { dataDir: { legacyPath: "legacy" } }), files);
    writeModule(root, "kernel-path", manifestOf("kernel-path", { contributes: { routes: { rootPaths: ["/metrics"] } } }), files);
    writeModule(root, "env-thief", manifestOf("env-thief", { env: ["DECK_ACTIONS_ENABLED"] }), files);
    const importer = spyImporter();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer });
    expect(importer).not.toHaveBeenCalled();
    expect(result.loaded).toEqual([]);
    expect(result.loadProblems.size).toBe(0);
    expect(existsSync(marker)).toBe(false);

    // With their switches on, the two gated ones are imported.
    const on = await loadRuntimeModules({ env: { ...env(root), NEEDS_ENV_ON: "1" }, configDir: configWith({ modules: { "needs-section": {} } }), importer });
    expect(on.loaded).toEqual(["needs-env", "needs-section"]);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(existsSync(marker)).toBe(true);
  });

  it("never imports a module whose dependency failed to load", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "base-lib", manifestOf("base-lib"), { "server.mjs": `throw new Error("broken");\n` });
    writeModule(root, "dependent", manifestOf("dependent", { dependsOn: ["base-lib"] }));
    const importer = spyImporter();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer });
    expect(result.loadProblems.get("base-lib")).toBe("import error");
    expect(importer.mock.calls.map(([url]) => url)).toEqual([expect.stringContaining("/base-lib/server.mjs")]);
    expect(result.loaded).toEqual([]);
    expect([...result.codeless].sort()).toEqual(["base-lib", "dependent"]);
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
    expect(ids(result)).toEqual(["array", "bad-json", "no-manifest", "renamed", "two-entries"]);
    // The public reason is a category; the detail (with the directory) is for the log.
    for (const id of ids(result)) expect(result.loadProblems.get(id)).toBe("bad manifest");
    expect(result.loadDetails!.get("no-manifest")).toContain("deck-module.json is missing");
    expect(result.loadDetails!.get("bad-json")).toContain("not valid JSON");
    expect(result.loadDetails!.get("array")).toContain("not a JSON object");
    expect(result.loadDetails!.get("renamed")).toContain('declares id "other", but its directory is "renamed"');
    expect(result.loadDetails!.get("two-entries")).toContain("more than one server entry (server.js, server.mjs)");
    expect(result.loadDetails!.get("array")).toContain("array");
    expect(importer).not.toHaveBeenCalled();
  });

  it("isolates a huge or deeply nested manifest to its own module", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "deep", `{"id":"deep","x":${"[".repeat(30_000)}${"]".repeat(30_000)}}`);
    writeModule(root, "huge", JSON.stringify({ ...manifestOf("huge"), pad: "x".repeat(70_000) }));
    writeModule(root, "healthy", manifestOf("healthy"));
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}) });
    expect(result.loaded).toEqual(["healthy"]);
    expect(result.loadProblems.get("deep")).toBe("bad manifest");
    expect(result.loadDetails!.get("deep")).toMatch(/nests deeper than 32 levels|not valid JSON/);
    expect(result.loadDetails!.get("huge")).toContain("larger than 65536 bytes");
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
    for (const id of ["throws", "no-init", "drifted", "bad-rules"]) expect(result.loadProblems.get(id)).toBe("import error");
    expect(result.loadDetails!.get("throws")).toContain("its server entry failed to import: boom at import");
    expect(result.loadDetails!.get("no-init")).toContain("default export has no init function");
    expect(result.loadDetails!.get("drifted")).toContain("manifest differs from deck-module.json");
    expect(result.loadDetails!.get("bad-rules")).toContain("configRules must be a list of functions");
    expect([...result.codeless].sort()).toEqual(["bad-rules", "drifted", "no-init", "throws"]);
    expect(ids(result)).toEqual(["bad-rules", "drifted", "good", "no-init", "throws"]);
  });

  it("loads a module without a server entry as manifest contributions only", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "web-only", manifestOf("web-only"), {});
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}) });
    expect(result.loaded).toEqual(["web-only"]);
    expect(result.codeless.size).toBe(0);
  });

  it("stops boot when an entry never finishes loading, naming the module", async () => {
    const root = tempDir("deck-rt-");
    writeModule(root, "hangs", manifestOf("hangs"));
    await expect(loadRuntimeModules({ env: env(root), configDir: configWith({}), importer: () => new Promise(() => {}), importTimeoutMs: 20 }))
      .rejects.toThrow('runtime module "hangs": its server entry did not finish loading within 20 ms');
  });

  it("refuses a server entry, a manifest or a module directory that resolves outside its confines", async () => {
    const root = tempDir("deck-rt-");
    const outside = tempDir("deck-rt-outside-");
    writeFileSync(join(outside, "evil.mjs"), ENTRY);
    writeFileSync(join(outside, "deck-module.json"), JSON.stringify(manifestOf("linked-manifest")));
    const entryDir = writeModule(root, "escapes", manifestOf("escapes"), {});
    symlinkSync(join(outside, "evil.mjs"), join(entryDir, "server.mjs"));
    mkdirSync(join(root, "linked-manifest"));
    symlinkSync(join(outside, "deck-module.json"), join(root, "linked-manifest", "deck-module.json"));
    writeModule(outside, "escape", manifestOf("escape"));
    symlinkSync(join(outside, "escape"), join(root, "escape"));
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({}), importer });
    for (const id of ["escapes", "linked-manifest", "escape"]) expect(result.loadProblems.get(id)).toBe("outside DECK_MODULES_DIR");
    expect(importer).not.toHaveBeenCalled();
  });

  it("reads modules through a symlinked DECK_MODULES_DIR", async () => {
    const real = tempDir("deck-rt-");
    writeModule(real, "alpha", manifestOf("alpha"));
    const link = join(tempDir("deck-rt-link-"), "modules");
    symlinkSync(real, link);
    const result = await loadRuntimeModules({ env: env(link), configDir: configWith({}) });
    expect(result.loaded).toEqual(["alpha"]);
  });

  it("fails boot only when runtime modules are on and the directory cannot be read", async () => {
    const missing = join(tempDir("deck-rt-"), "absent");
    await expect(loadRuntimeModules({ env: env(missing), configDir: configWith({}) })).rejects.toThrow(`DECK_MODULES_DIR ${missing} cannot be read`);
    const off = await loadRuntimeModules({ env: env(missing, false), configDir: configWith({}) });
    expect(off.modules).toEqual([]);
  });

  it("reads the manifests only for deck validate and render", () => {
    const result = readRuntimeManifests({ env: env(EXAMPLES), configDir: configWith({ modules: { maintenance: { windows: [] } } }) });
    expect(ids(result)).toEqual(["maintenance"]);
    expect([...result.codeless]).toEqual(["maintenance"]);
    expect(result.loaded).toEqual([]);
    expect(result.planOnly).toBe(true);
  });
});

describe("collisions never abort boot", () => {
  /** A modules directory with modules that collide with built-ins, the kernel, or one another. */
  function collidingModules(): string {
    const root = tempDir("deck-rt-");
    writeModule(root, "portal", undefined); // an empty directory named like a built-in
    writeModule(root, "legacy-key", manifestOf("legacy-key", { health: { legacyKey: "llmUsage" } }));
    writeModule(root, "kind-thief", manifestOf("kind-thief", { providerKinds: [{ kind: "prometheus" }] }), {});
    writeModule(root, "code-thief", manifestOf("code-thief", { config: { schema: { type: "object" }, findings: [{ code: "LLM_USAGE_INVALID", severity: "error", summary: "x", fix: "y" }] } }));
    writeModule(root, "alias-a", manifestOf("alias-a", { contributes: { routes: { legacyAliases: ["/api/shared"] } } }));
    writeModule(root, "alias-b", manifestOf("alias-b", { contributes: { routes: { legacyAliases: ["/api/shared"] } } }));
    writeModule(root, "fine", manifestOf("fine"));
    return root;
  }

  it("with runtime modules on: each colliding module fails to load, the rest load", async () => {
    const result = await loadRuntimeModules({ env: env(collidingModules()), configDir: configWith({}) });
    expect(result.rejected.map(({ id }) => id)).toEqual(["portal"]);
    expect(ids(result)).not.toContain("portal");
    for (const id of ["legacy-key", "kind-thief", "code-thief", "alias-b"]) expect(result.loadProblems.get(id), id).toBe("collision");
    expect(result.loadProblems.has("alias-a")).toBe(false);
    expect(result.loaded).toEqual(["alias-a", "fine"]);
  });

  it("with runtime modules off: every directory is inert, with no load failure", async () => {
    const result = await loadRuntimeModules({ env: env(collidingModules(), false), configDir: configWith({}) });
    expect(result.loadProblems.size).toBe(0);
    expect(result.loaded).toEqual([]);
    expect(ids(result)).not.toContain("portal");
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
    const other = writeModule(root, "pinned-2", manifestOf("pinned"), { "server.mjs": ENTRY, "lib/utils.mjs": "export const x = 2;\n" });
    expect(moduleDigest(other)).not.toBe(moduleDigest(dir));
  });

  it("digests the same tree the same through a relative path, a symlinked directory or a symlinked parent", () => {
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "pinned", manifestOf("pinned"), { "server.mjs": ENTRY, "lib/util.mjs": "export {};\n" });
    const digest = moduleDigest(dir);
    expect(moduleDigest(relative(process.cwd(), dir))).toBe(digest);
    const links = tempDir("deck-rt-links-");
    symlinkSync(dir, join(links, "module"));
    expect(moduleDigest(join(links, "module"))).toBe(digest);
    symlinkSync(root, join(links, "parent"));
    expect(moduleDigest(join(links, "parent", "pinned"))).toBe(digest);
  });

  it("reads pins from the layers merged as config loading merges them", async () => {
    const root = tempDir("deck-rt-");
    const pin = moduleDigest(writeModule(root, "pinned", manifestOf("pinned")));
    const stale = `sha256-${"A".repeat(43)}=`;
    // An overlay's pin alone is used.
    expect((await loadRuntimeModules({ env: env(root), configDir: configWith({}, { moduleIntegrity: { pinned: pin } }) })).loaded).toEqual(["pinned"]);
    // Pinned in both layers, the earlier layer's pin is the one used (ownership `both`), as in
    // the validated config: a stale base pin under a fresh overlay one does not match.
    const staleBase = await loadRuntimeModules({ env: env(root), configDir: configWith({ moduleIntegrity: { pinned: stale } }, { moduleIntegrity: { pinned: pin } }) });
    expect(staleBase.loadProblems.get("pinned")).toBe("pin mismatch");
    expect(staleBase.pins.get("pinned")).toBe(stale);
    const freshBase = await loadRuntimeModules({ env: env(root), configDir: configWith({ moduleIntegrity: { pinned: pin } }, { moduleIntegrity: { pinned: stale } }) });
    expect(freshBase.loaded).toEqual(["pinned"]);
  });

  it("imports nothing from a directory that does not match its pin", async () => {
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "pinned", manifestOf("pinned"));
    const pin = moduleDigest(dir);
    writeFileSync(join(dir, "server.mjs"), `${ENTRY}// tampered\n`);
    const importer = vi.fn();
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({ moduleIntegrity: { pinned: pin } }), importer });
    expect(result.loadProblems.get("pinned")).toBe("pin mismatch");
    expect(result.loadDetails!.get("pinned")).toContain(`does not match the pinned ${pin}`);
    expect(importer).not.toHaveBeenCalled();
  });

  it("checks each module's pin just before its own import, so a change made during an earlier import is caught", async () => {
    const root = tempDir("deck-rt-");
    const first = writeModule(root, "a-first", manifestOf("a-first"));
    const second = writeModule(root, "b-second", manifestOf("b-second"));
    const pins = { "a-first": moduleDigest(first), "b-second": moduleDigest(second) };
    const importer = vi.fn(async (url: string) => {
      // While the first module imports, the second's file changes.
      if (url.includes("a-first")) writeFileSync(join(second, "server.mjs"), `${ENTRY}// changed\n`);
      return import(url);
    });
    const result = await loadRuntimeModules({ env: env(root), configDir: configWith({ moduleIntegrity: pins }), importer });
    expect(result.loaded).toEqual(["a-first"]);
    expect(result.loadProblems.get("b-second")).toBe("pin mismatch");
    expect(importer).toHaveBeenCalledTimes(1);
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
    expect(result.loadDetails!.get("malformed")).toContain("integrity pin is not a sha256-<base64> digest");
    expect(result.loadDetails!.get("linked")).toContain('"data.txt" is not a regular file or directory');
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
    expect(result.loadDetails!.get("locked")).toContain("its directory cannot be read");
    expect(importer).not.toHaveBeenCalled();
  });

  it("checks pins in manifest-only planning too", () => {
    const root = tempDir("deck-rt-");
    const dir = writeModule(root, "pinned", manifestOf("pinned"));
    const pin = moduleDigest(dir);
    expect(readRuntimeManifests({ env: env(root), configDir: configWith({ moduleIntegrity: { pinned: pin } }) }).loadProblems.size).toBe(0);
    writeFileSync(join(dir, "server.mjs"), `${ENTRY}// changed\n`);
    expect(readRuntimeManifests({ env: env(root), configDir: configWith({ moduleIntegrity: { pinned: pin } }) }).loadProblems.get("pinned")).toBe("pin mismatch");
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
    expect(checkPins(runtime, { moduleIntegrity: { a: "sha256-x", b: "sha256-z" }, modules: { b: {} } })).toBeNull();
  });
});
