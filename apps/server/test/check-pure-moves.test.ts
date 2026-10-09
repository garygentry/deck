import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../../scripts/check-pure-moves.mjs");

/** The file the probes edit: a moved module importing a sibling, a helper and a workspace package. */
const GROW = [
  'import { helper } from "../shared/helper.js";',
  'import { a } from "./a.js";',
  'import { b } from "./b.js";',
  'import { login } from "./auth.js";',
  'import { tool } from "@x/lib/tool";',
  "",
  "/** Doubles a shape's size. */",
  "export function grow(size: number): number {",
  "  const label = 'import \"./a.js\"';",
  "  return helper(size) * 2 + a + b + login(label) + tool;",
  "}",
  "",
  "export const made = /*#__PURE__*/ helper(1);",
  "",
].join("\n");

describe("check-pure-moves", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
  const check = (...args: string[]) => run(SCRIPT, "base", ...args);
  /** Move the `grow` directory to the module layout, then rewrite grow.ts with `edit`, and commit. */
  const moveGrow = (edit: (source: string) => string) => {
    mkdirSync(join(repo, "modules/grow"), { recursive: true });
    git("mv", "apps/server/src/grow", "modules/grow/server");
    write("modules/grow/server/grow.ts", edit(GROW.replace('"../shared/helper.js"', '"../../../apps/server/src/shared/helper.js"')));
    git("add", "-A");
    git("commit", "-qm", "move");
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pure-moves-"));
    git("init", "-q");
    git("config", "user.email", "pure@example.invalid");
    git("config", "user.name", "pure");
    git("config", "commit.gpgsign", "false");
    write("apps/server/src/grow/grow.ts", GROW);
    for (const name of ["a", "b", "auth", "auth-noop"]) write(`apps/server/src/grow/${name}.ts`, `export const ${name.replace("-", "_")} = 1;\nexport const login = (x: string) => x.length;\n`);
    write("apps/server/src/shared/helper.ts", "export const helper = (n: number) => n;\n");
    write("packages/lib/package.json", JSON.stringify({ name: "@x/lib", exports: { "./tool": "./src/tool.ts" } }));
    write("packages/lib/src/tool.ts", "export const tool = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "before");
    git("branch", "base");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes a move whose specifiers still load the same modules, with comment edits", () => {
    moveGrow((source) => source
      .replace('"@x/lib/tool"', '"../../../packages/lib/src/tool.js"')
      .replace("Doubles a shape's size.", "Doubles a shape's size (moved)."));
    const result = check();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok\s+apps\/server\/src\/grow\/grow\.ts -> modules\/grow\/server\/grow\.ts \(similarity \d+%, 2 specifier\(s\) rewritten, same module\)/);
    expect(result.stdout).toContain("OK: every rename is a pure move");
  });

  it.each([
    ["code added behind an empty comment", (source: string) => source.replace("  return", '  /**/ fetch("https://example.invalid");\n  return')],
    ["a changed operand", (source: string) => source.replace("* 2", "* 3")],
    ["an import-like string literal", (source: string) => source.replace(`'import "./a.js"'`, `'import "./b.js"'`)],
    ["a specifier retargeted to another module", (source: string) => source.replace('"./auth.js"', '"./auth-noop.js"')],
    ["two specifiers swapped", (source: string) => source.replace('"./a.js"', '"./TMP"').replace('"./b.js"', '"./a.js"').replace('"./TMP"', '"./b.js"')],
    ["a line break that ends a statement (ASI)", (source: string) => source.replace("  return helper(size)", "  return\n  helper(size)")],
    ["an added directive comment", (source: string) => source.replace("  return helper", "  // @ts-expect-error\n  return helper")],
    ["a dropped directive comment", (source: string) => source.replace("/*#__PURE__*/ ", "")],
  ])("fails %s", (_name, edit) => {
    moveGrow(edit);
    const result = check();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toMatch(/NOT PURE\s+apps\/server\/src\/grow\/grow\.ts -> modules\/grow\/server\/grow\.ts/);
    expect(result.stdout).toContain("FAIL: not a pure move");
  });

  describe("a byte-identical move still resolves its specifiers", () => {
    /** Move only uses-a.ts (an unchanged `./a.js` import), plus `also` (git mv pairs) and `add` (new files). */
    const moveUsesA = (also: string[], add: Record<string, string> = {}) => {
      mkdirSync(join(repo, "modules/grow/server"), { recursive: true });
      for (const name of ["uses-a.ts", ...also]) git("mv", `apps/server/src/grow/${name}`, `modules/grow/server/${name}`);
      for (const [path, text] of Object.entries(add)) write(path, text);
      git("add", "-A");
      git("commit", "-qm", "move uses-a");
    };

    beforeEach(() => {
      write("apps/server/src/grow/uses-a.ts", 'import { a } from "./a.js";\nexport const twice = a * 2;\n');
      git("add", ".");
      git("commit", "-qm", "uses-a");
      git("branch", "-f", "base");
    });

    it("fails when the unchanged specifier now loads another file", () => {
      moveUsesA([], { "modules/grow/server/a.ts": "export const a = 2;\n" });
      const result = check();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('specifier "./a.js" → "./a.js" loads modules/grow/server/a.ts, not apps/server/src/grow/a.ts');
    });

    it("fails when the unchanged specifier now resolves to nothing", () => {
      moveUsesA([]);
      const result = check();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toMatch(/NOT PURE\s+apps\/server\/src\/grow\/uses-a\.ts/);
    });

    it("passes when the imported sibling moves with it", () => {
      moveUsesA(["a.ts"]);
      const result = check();
      expect(result.status, result.stdout).toBe(0);
    });
  });

  it("fails a deleted app source that no rename pairs", () => {
    mkdirSync(join(repo, "modules/grow/server"), { recursive: true });
    git("rm", "-q", "apps/server/src/grow/b.ts");
    write("modules/grow/server/b.ts", "export const b = { rewritten: true, entirely: [1, 2, 3] };\nexport const extra = () => b;\n");
    git("add", "-A");
    git("commit", "-qm", "rewrite b");
    const result = check();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("deleted app sources no rename pairs (1)");
    expect(result.stdout).toContain("  D apps/server/src/grow/b.ts");
  });

  it("reads the global git config but pins the diff settings it could change", () => {
    moveGrow((source) => source.replace("Doubles", "Doubles (moved)"));
    const global = join(repo, ".global-gitconfig");
    // Each would change or break the diff the check reads, if it were not pinned or disabled.
    writeFileSync(global, "[diff]\n\tnoprefix = true\n\trenames = false\n\texternal = false\n[core]\n\tquotePath = true\n");
    const result = spawnSync(process.execPath, [SCRIPT, "base"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: global } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok\s+apps\/server\/src\/grow\/grow\.ts -> modules\/grow\/server\/grow\.ts/);
  });

  it("runs the same through a symlink and under diff.noprefix", () => {
    moveGrow((source) => source.replace("* 2", "* 3"));
    git("config", "diff.noprefix", "true");
    const link = join(mkdtempSync(join(tmpdir(), "pure-moves-link-")), "check.mjs");
    symlinkSync(SCRIPT, link);
    const result = run(link, "base");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("NOT PURE");
    rmSync(dirname(link), { recursive: true, force: true });
  });

  it("fails a move git does not pair as a rename, matched by content", () => {
    // A two-line file whose specifier is most of it: rewritten, it falls under rename detection.
    write("apps/server/src/tiny.ts", 'export { a } from "./grow/a.js";\n');
    git("add", ".");
    git("commit", "-qm", "tiny");
    git("branch", "-f", "base");
    git("rm", "-q", "apps/server/src/tiny.ts");
    write("modules/tiny/server/tiny.ts", 'export { a } from "../../../apps/server/src/grow/a.js";\n');
    git("add", ".");
    git("commit", "-qm", "move tiny");
    const result = check();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("moves git did not detect as renames (1)");
    expect(result.stdout).toContain("apps/server/src/tiny.ts -> modules/tiny/server/tiny.ts");
  });

  it("lists new files under modules/ as additions and checks staged moves with --worktree", () => {
    mkdirSync(join(repo, "modules/grow/server"), { recursive: true });
    git("mv", "apps/server/src/grow/a.ts", "modules/grow/server/a.ts");
    write("modules/grow/package.json", "{}\n");
    git("add", "modules/grow/package.json");
    const result = check("--worktree");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("working tree against base");
    expect(result.stdout).toContain("additions under modules/ (1):\n  A modules/grow/package.json");
  });

  it("rejects unknown flags and extra arguments", () => {
    expect(check("--nope").status).toBe(2);
    expect(check("extra").status).toBe(2);
  });
});
