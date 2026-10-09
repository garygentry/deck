import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../../scripts/check-pure-moves.mjs");

const SOURCE = [
  'import { helper } from "../shared/helper.js";',
  'import type { Shape } from "./types.js";',
  "",
  "/** Doubles a shape's size. */",
  "export function grow(shape: Shape): Shape {",
  "  return { ...shape, size: helper(shape.size) * 2 };",
  "}",
  "",
].join("\n");

describe("check-pure-moves", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const check = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, "base", ...args], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pure-moves-"));
    git("init", "-q");
    git("config", "user.email", "pure@example.invalid");
    git("config", "user.name", "pure");
    git("config", "commit.gpgsign", "false");
    write("apps/server/src/grow/grow.ts", SOURCE);
    write("apps/server/src/grow/notes.ts", "export const notes = [1, 2, 3];\n");
    git("add", ".");
    git("commit", "-q", "-m", "before");
    git("branch", "base");
    mkdirSync(join(repo, "modules/grow"), { recursive: true });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes a move that edits only specifiers and comments", () => {
    git("mv", "apps/server/src/grow", "modules/grow/server");
    write("modules/grow/server/grow.ts", SOURCE
      .replace('"../shared/helper.js"', '"../../../apps/server/src/shared/helper.js"')
      .replace("Doubles a shape's size.", "Doubles a shape's size (moved)."));
    git("commit", "-qam", "move");
    const result = check();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok\s+apps\/server\/src\/grow\/grow\.ts -> modules\/grow\/server\/grow\.ts \(similarity \d+%, 1 specifier line\(s\), 2 comment line\(s\)\)/);
    expect(result.stdout).toContain("OK: every rename is a pure move");
  });

  it("fails a move that changes code", () => {
    git("mv", "apps/server/src/grow", "modules/grow/server");
    write("modules/grow/server/grow.ts", SOURCE.replace("* 2", "* 3"));
    git("commit", "-qam", "move");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("NOT PURE");
    expect(result.stdout).toContain("+   return { ...shape, size: helper(shape.size) * 3 };");
  });

  it("fails a move git does not detect as a rename", () => {
    git("rm", "-q", "apps/server/src/grow/notes.ts");
    write("modules/grow/server/notes.ts", "export const other = { completely: 'different' };\n");
    git("add", ".");
    git("commit", "-qm", "rewrite");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("apps/server/src/grow/notes.ts -> modules/grow/server/notes.ts");
  });

  it("checks staged moves in the working tree with --worktree", () => {
    mkdirSync(join(repo, "modules/grow/server"));
    git("mv", "apps/server/src/grow/notes.ts", "modules/grow/server/notes.ts");
    const result = check("--worktree");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("working tree against base");
  });

  it("rejects unknown flags", () => {
    expect(check("--nope").status).toBe(2);
  });
});
