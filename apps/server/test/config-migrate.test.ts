import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { main } from "../src/cli/deck.js";
import { fileIo, runConfigMigrate, unifiedDiff, type MigrateIo } from "../src/cli/migrate.js";
import { load } from "../src/config/load.js";
import { expectedV2, migrateLayer, MigrateError } from "../src/config/migrate.js";

/** The frozen v1 estates: migrated here, never in place. */
const V1_DIRS = ["v1-actions", "v1-estate", "v1-integrations", "v1-llm-usage"].map((name) => `test/fixtures/${name}`);

const yamlFiles = (dir: string) => readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
const commentLines = (text: string) => text.split("\n").filter((line) => line.trim().startsWith("#")).map((line) => line.trim());

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function copyOf(dir: string): string {
  const copy = mkdtempSync(join(tmpdir(), "deck-migrate-"));
  scratch.push(copy);
  for (const name of yamlFiles(dir)) cpSync(join(dir, name), join(copy, name));
  return copy;
}

function dirOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-migrate-"));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function cli(argv: string[]) {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = main(argv);
  const text = (spy: typeof stdout) => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
  const result = { exit, stdout: text(stdout), stderr: text(stderr) };
  stdout.mockRestore();
  stderr.mockRestore();
  return result;
}

describe("migrateLayer on every frozen v1 fixture", () => {
  for (const dir of V1_DIRS) {
    for (const name of yamlFiles(dir)) {
      it(`${dir}/${name}: moves keys, keeps comments and every value line, and is idempotent`, () => {
        const before = readFileSync(join(dir, name), "utf8");
        const result = migrateLayer(before);
        expect(result.status).toBe("migrated");
        // The rewrite is the v1 document moved to its v2 shape, as data.
        expect(parse(result.text)).toEqual(expectedV2(parse(before)));
        expect(parse(result.text).schemaVersion).toBe(2);
        // Comments survive verbatim, and every line keeps its text (moved lines are re-indented).
        expect(commentLines(result.text)).toEqual(commentLines(before));
        const after = new Set(result.text.split("\n").map((line) => line.trim()));
        for (const line of before.split("\n")) {
          if (/^(schemaVersion|llmUsage|groups|actions|agents):/.test(line)) continue;
          expect(after.has(line.trim()), line).toBe(true);
        }
        // Running it again is a no-op, byte for byte.
        expect(migrateLayer(result.text)).toEqual({ status: "current", text: result.text, warnings: [] });
      });
    }
  }
});

describe("migrateLayer", () => {
  const v1 = [
    "# estate overlay",
    "schemaVersion: 1   # the version",
    "estate:",
    "  name: lab",
    "",
    "# Presentation: groups shown on the portal.",
    "groups:",
    "  - id: main # first",
    "    title: Main",
    "    items: [{ type: link, title: Docs, href: \"https://docs.invalid/\" }]",
    "llmUsage:",
    "  # thresholds in percent",
    "  thresholds: { warn: 70, danger: 85 }",
    "integrations:",
    "  - id: notes",
    "    kind: link",
    "    title: Notes",
    "    baseUrl: https://notes.invalid",
    "    card:",
    "      text: |",
    "        line one",
    "",
    "        line three",
    "actions: []",
    "agents: []",
    "",
  ].join("\n");

  it("moves each key under modules at the first moved key's place, keeping comments and styles", () => {
    const { status, text, warnings } = migrateLayer(v1);
    expect(status).toBe("migrated");
    expect(warnings).toEqual([]);
    expect(text).toBe([
      "# estate overlay",
      "schemaVersion: 2   # the version",
      "estate:",
      "  name: lab",
      "",
      "modules:",
      "  portal:",
      "    # Presentation: groups shown on the portal.",
      "    groups:",
      "      - id: main # first",
      "        title: Main",
      "        items: [{ type: link, title: Docs, href: \"https://docs.invalid/\" }]",
      "  llm-usage:",
      "    # thresholds in percent",
      "    thresholds: { warn: 70, danger: 85 }",
      "  actions:",
      "    actions: []",
      "integrations:",
      "  - id: notes",
      "    kind: link",
      "    title: Notes",
      "    baseUrl: https://notes.invalid",
      "    card:",
      "      text: |",
      "        line one",
      "",
      "        line three",
      "",
    ].join("\n"));
    expect(parse(text).integrations[0].card.text).toBe("line one\n\nline three\n");
  });

  it("keeps each key in the layer it was in", () => {
    const base = migrateLayer("schemaVersion: 1\nestate:\n  name: lab\n").text;
    expect(base).toBe("schemaVersion: 2\nestate:\n  name: lab\n");
    expect(parse(migrateLayer("schemaVersion: 1\ngroups: []\n").text)).toEqual({ schemaVersion: 2, modules: { portal: { groups: [] } } });
  });

  it("drops agents, warning only when it has entries", () => {
    expect(migrateLayer("schemaVersion: 1\nagents: []\n")).toEqual({ status: "migrated", text: "schemaVersion: 2\n", warnings: [] });
    const result = migrateLayer("schemaVersion: 1\nagents:\n  - { id: a, kind: x }\n");
    expect(result.text).toBe("schemaVersion: 2\n");
    expect(result.warnings).toEqual([expect.stringContaining("dropped `agents`")]);
  });

  it("refuses what it cannot rewrite safely", () => {
    expect(() => migrateLayer("schemaVersion: 7\n")).toThrow(MigrateError);
    expect(() => migrateLayer("schemaVersion: 1\nmodules: {}\n")).toThrow(/already have `modules`/);
    expect(() => migrateLayer("{ schemaVersion: 1, groups: [] }\n")).toThrow(/flow style/);
    expect(() => migrateLayer("- 1\n")).toThrow(/not a mapping/);
    expect(() => migrateLayer("schemaVersion: [\n")).toThrow(/not valid YAML/);
  });

  it("adds a final newline to a file without one", () => {
    expect(migrateLayer("schemaVersion: 1\nllmUsage: {}").text).toBe("schemaVersion: 2\nmodules:\n  llm-usage: {}\n");
  });
});

describe("deck config migrate", () => {
  it("rewrites every layer of a v1 estate in place, and the result loads clean", () => {
    for (const fixture of V1_DIRS) {
      const dir = copyOf(fixture);
      expect(load({ arg: dir })).toMatchObject({ exitClass: 2, toolError: { code: "CONFIG_MIGRATION_REQUIRED" } });
      const run = cli(["config", "migrate", dir]);
      expect(run.exit, fixture).toBe(0);
      expect(run.stdout).toContain(`next: deck validate ${dir}`);
      expect(load({ arg: dir }).exitClass, fixture).toBe(0);
    }
  });

  it("keeps overlay-owned keys in the overlay file", () => {
    const dir = copyOf("test/fixtures/v1-estate");
    cli(["config", "migrate", dir]);
    expect(parse(readFileSync(join(dir, "00-base.yaml"), "utf8")).modules).toBeUndefined();
    expect(parse(readFileSync(join(dir, "10-overlay.yaml"), "utf8")).modules.portal.groups.length).toBeGreaterThan(0);
  });

  it("is a no-op the second time: no write, byte-identical files", () => {
    const dir = copyOf("test/fixtures/v1-llm-usage");
    cli(["config", "migrate", dir]);
    const files = yamlFiles(dir).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8"), mtime: statSync(join(dir, name)).mtimeMs }));
    const again = cli(["config", "migrate", dir]);
    expect(again.exit).toBe(0);
    expect(again.stdout).toContain("already schemaVersion 2");
    expect(again.stdout).not.toContain("next:");
    for (const file of files) {
      expect(readFileSync(join(dir, file.name), "utf8")).toBe(file.text);
      expect(statSync(join(dir, file.name)).mtimeMs).toBe(file.mtime);
    }
  });

  it("--dry-run prints a unified diff and writes nothing", () => {
    const dir = copyOf("test/fixtures/v1-llm-usage");
    const before = yamlFiles(dir).map((name) => readFileSync(join(dir, name), "utf8"));
    const run = cli(["config", "migrate", dir, "--dry-run"]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain("--- a/10-overlay.yaml\n+++ b/10-overlay.yaml\n@@ ");
    expect(run.stdout).toContain("-schemaVersion: 1\n+schemaVersion: 2\n");
    expect(run.stdout).toContain("+modules:\n");
    expect(yamlFiles(dir).map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(before);
  });

  it("writes nothing when any layer cannot be migrated", () => {
    const dir = dirOf({ "00-base.yaml": "schemaVersion: 1\nestate: { name: x }\n", "10-overlay.yaml": "schemaVersion: 1\nmodules: {}\n" });
    const run = cli(["config", "migrate", dir]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toMatch(/^CONFIG_MIGRATE_FAILED {2}.*10-overlay\.yaml {2}a schemaVersion 1 document cannot already have `modules`/);
    expect(readFileSync(join(dir, "00-base.yaml"), "utf8")).toBe("schemaVersion: 1\nestate: { name: x }\n");
  });

  it("reports a dropped non-empty agents list on stderr", () => {
    const dir = dirOf({ "00-base.yaml": "schemaVersion: 1\nestate: { name: x }\nagents: [{ id: a, kind: k }]\n" });
    const run = cli(["config", "migrate", dir]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain("warning");
    expect(run.stderr).toContain("dropped `agents`");
  });

  it("exits 2 with usage or a classified error for bad arguments", () => {
    expect(cli(["config", "migrate"])).toMatchObject({ exit: 2, stderr: expect.stringContaining("usage: deck config migrate") });
    expect(cli(["config", "migrate", "a", "b"]).exit).toBe(2);
    expect(cli(["config", "migrate", join(tmpdir(), "deck-no-such-dir")])).toMatchObject({ exit: 2, stderr: expect.stringContaining("CONFIG_DIR_MISSING") });
    expect(cli(["config"])).toMatchObject({ exit: 2, stderr: expect.stringContaining("deck config migrate <dir>") });
  });
});

describe("unifiedDiff", () => {
  it("emits hunks with three lines of context and correct ranges", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"].join("\n");
    expect(unifiedDiff(before, after, "x.yaml")).toBe(
      "--- a/x.yaml\n+++ b/x.yaml\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n",
    );
    expect(unifiedDiff("same\n", "same\n", "x.yaml")).toBe("--- a/x.yaml\n+++ b/x.yaml\n");
  });
});

describe("review round 1: migrateLayer", () => {
  it("keeps the comments of a dropped agents section (C9)", () => {
    const { text } = migrateLayer("schemaVersion: 1\n# reserved\nagents: [] # important\n# end comment\n");
    expect(text).toBe("schemaVersion: 2\n# reserved\n# important\n# end comment\n");
  });

  it("keeps a comment banner with the key it introduces, and the file's line endings (L12)", () => {
    const v1 = "schemaVersion: 1\r\ngroups: []\r\n\r\n# ---- hosts ----\r\n\r\nhosts:\r\n  - { name: h, kind: vm, purpose: p }\r\nllmUsage: {}\r\n";
    const { text } = migrateLayer(v1);
    expect(text).toBe(
      "schemaVersion: 2\r\nmodules:\r\n  portal:\r\n    groups: []\r\n  llm-usage: {}\r\n\r\n# ---- hosts ----\r\n\r\nhosts:\r\n  - { name: h, kind: vm, purpose: p }\r\n",
    );
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("keeps a trailing comment and a `...` end marker at the end (L1, C9)", () => {
    const { text } = migrateLayer("schemaVersion: 1\ngroups: []\n# footer\n...\n");
    expect(text).toBe("schemaVersion: 2\nmodules:\n  portal:\n    groups: []\n# footer\n...\n");
  });

  it("moves the modules section to where an alias still follows its anchor, or refuses (L1)", () => {
    // The anchor is between the moved keys: the section can go at the last moved key's place.
    const later = "schemaVersion: 1\ngroups: []\nhosts:\n  - { name: h, kind: vm, purpose: &p shared }\nactions:\n  - { id: a, title: *p, runner: r, confirm: none }\n";
    const result = migrateLayer(later);
    expect(parse(result.text)).toEqual(expectedV2(parse(later)));
    // Anchors both ways round: no placement works, so it is a MigrateError, not a crash.
    const tangled = "schemaVersion: 1\ngroups:\n  - { id: &g gid, title: t, items: [] }\nhosts:\n  - { name: *g, kind: vm, purpose: &p shared }\nactions:\n  - { id: a, title: *p, runner: r, confirm: none }\n";
    expect(() => migrateLayer(tangled)).toThrow(MigrateError);
    expect(() => migrateLayer(tangled)).toThrow(/migrate this file by hand/);
    // An alias the input itself cannot resolve is a MigrateError too.
    expect(() => migrateLayer("schemaVersion: 1\ngroups: *nowhere\n")).toThrow(MigrateError);
  });
});

describe("review round 1: deck config migrate", () => {
  const V1_BASE = "schemaVersion: 1\nestate: { name: x }\n";
  const V1_OVERLAY = "schemaVersion: 1\ngroups: []\n";

  it("rejects an unknown option before reading or writing anything (C8, L2)", () => {
    for (const option of ["--dryrun", "-n", "--dry_run", "--force"]) {
      const dir = dirOf({ "00-base.yaml": V1_BASE });
      const run = cli(["config", "migrate", dir, option]);
      expect(run).toMatchObject({ exit: 2, stderr: expect.stringContaining(`unknown option ${option}`) });
      expect(readFileSync(join(dir, "00-base.yaml"), "utf8")).toBe(V1_BASE);
    }
  });

  it("migrates a symlinked layer at its target and keeps the link (C6, L3a)", () => {
    const outside = dirOf({ "inventory.yaml": V1_BASE });
    const dir = dirOf({ "10-overlay.yaml": V1_OVERLAY });
    symlinkSync(join(outside, "inventory.yaml"), join(dir, "00-base.yaml"));
    const run = cli(["config", "migrate", dir]);
    expect(run.exit).toBe(0);
    expect(lstatSync(join(dir, "00-base.yaml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "inventory.yaml"), "utf8")).toBe("schemaVersion: 2\nestate: { name: x }\n");
    expect(run.stdout).toContain(`${join(dir, "00-base.yaml")} -> ${realpathSync(join(outside, "inventory.yaml"))}: migrated`);
  });

  it("keeps the file mode, and warns when it cannot keep the owner (C7, L3b)", () => {
    const dir = dirOf({ "00-base.yaml": V1_BASE });
    chmodSync(join(dir, "00-base.yaml"), 0o600);
    const io: MigrateIo = { ...fileIo, chown: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runConfigMigrate([dir], io)).toBe(0);
    expect(statSync(join(dir, "00-base.yaml")).mode & 0o777).toBe(0o600);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toMatch(/could not keep owner \d+:\d+ \(EPERM\)/);
  });

  it("never follows or replaces a file at a staging name, and leaves no staged files (C5)", () => {
    const victim = dirOf({ "precious.txt": "keep me\n" });
    const dir = dirOf({ "00-base.yaml": V1_BASE });
    // The old fixed staging name, planted as a symlink to an unrelated file.
    symlinkSync(join(victim, "precious.txt"), join(dir, `00-base.yaml.migrate-${process.pid}.tmp`));
    expect(cli(["config", "migrate", dir]).exit).toBe(0);
    expect(readFileSync(join(victim, "precious.txt"), "utf8")).toBe("keep me\n");
    expect(readdirSync(dir).sort()).toEqual(["00-base.yaml", `00-base.yaml.migrate-${process.pid}.tmp`]);
    // Staging is exclusive: an existing path is an error, never overwritten.
    expect(() => fileIo.create(join(victim, "precious.txt"), "x", 0o644)).toThrow(/EEXIST/);
  });

  it("restores already-replaced layers when a later replacement fails, and cleans up (C4, L3c)", () => {
    const dir = dirOf({ "00-base.yaml": V1_BASE, "10-overlay.yaml": V1_OVERLAY });
    let renames = 0;
    const io: MigrateIo = {
      ...fileIo,
      rename: (from, to) => {
        renames += 1;
        if (renames === 2) throw new Error("EIO: disk went away");
        fileIo.rename(from, to);
      },
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runConfigMigrate([dir], io)).toBe(2);
    const printed = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(printed).toMatch(/^CONFIG_MIGRATE_FAILED .*could not replace .*10-overlay\.yaml \(EIO: disk went away\); restored the 1 layer\(s\) already replaced; nothing was changed/);
    expect(readFileSync(join(dir, "00-base.yaml"), "utf8")).toBe(V1_BASE);
    expect(readFileSync(join(dir, "10-overlay.yaml"), "utf8")).toBe(V1_OVERLAY);
    expect(readdirSync(dir).sort()).toEqual(["00-base.yaml", "10-overlay.yaml"]);
  });

  it("changes nothing when staging fails part way (C4)", () => {
    const dir = dirOf({ "00-base.yaml": V1_BASE, "10-overlay.yaml": V1_OVERLAY });
    let creates = 0;
    const io: MigrateIo = {
      ...fileIo,
      create: (path, text, mode) => {
        creates += 1;
        if (creates === 2) throw new Error("ENOSPC: no space left");
        fileIo.create(path, text, mode);
      },
    };
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runConfigMigrate([dir], io)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["00-base.yaml", "10-overlay.yaml"]);
    expect(readFileSync(join(dir, "00-base.yaml"), "utf8")).toBe(V1_BASE);
  });

  it("prints a --dry-run diff that applies as a patch (L10)", () => {
    for (const fixture of V1_DIRS) {
      const dir = copyOf(fixture);
      const run = cli(["config", "migrate", dir, "--dry-run"]);
      const patchFile = join(dir, "migrate.patch");
      for (const name of yamlFiles(dir)) {
        const one = run.stdout.slice(run.stdout.indexOf(`--- a/${name}`));
        const end = one.indexOf("--- a/", 1);
        writeFileSync(patchFile, end === -1 ? one : one.slice(0, end));
        execFileSync("patch", ["--quiet", "--batch", join(dir, name), patchFile]);
        expect(readFileSync(join(dir, name), "utf8"), `${fixture}/${name}`).toBe(migrateLayer(readFileSync(join(fixture, name), "utf8")).text);
      }
    }
    expect(unifiedDiff("a\nb\n", "a\nb\nc\n", "x")).toBe("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n b\n+c\n");
    expect(unifiedDiff("a", "b\n", "x")).toBe("--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n");
  });
});

describe("review round 2: migrateLayer", () => {
  it("takes the agents key-line comment from the parser, not a # inside a quoted value (N3)", () => {
    expect(migrateLayer('schemaVersion: 1\nagents: ["x #y"] # keep me\n').text).toBe("schemaVersion: 2\n# keep me\n");
    expect(migrateLayer("schemaVersion: 1\nagents: ['a#b', \"c # d\"]\n").text).toBe("schemaVersion: 2\n");
    expect(migrateLayer("schemaVersion: 1\nagents: # block list\n  - { id: a, kind: k } # item\n  # inner\n").text)
      .toBe("schemaVersion: 2\n# block list\n  # inner\n");
  });
});
