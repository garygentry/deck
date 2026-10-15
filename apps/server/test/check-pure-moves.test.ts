import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  describe("a bundler query (?raw) on a specifier", () => {
    /** Enough unchanged lines around the import for git to pair the move as a rename. */
    const readsA = (specifier: string) => [
      `export const raw = import("${specifier}");`,
      ...["one", "two", "three", "four", "five", "six"].map((name) => `export const ${name} = "${name}".length;`),
      "",
    ].join("\n");

    beforeEach(() => {
      write("apps/server/src/grow/reads-a.ts", readsA("./a.js?raw"));
      git("add", ".");
      git("commit", "-qm", "reads-a");
      git("branch", "-f", "base");
    });

    const moveReadsA = (specifier: string) => {
      mkdirSync(join(repo, "modules/grow/test"), { recursive: true });
      git("mv", "apps/server/src/grow/reads-a.ts", "modules/grow/test/reads-a.ts");
      write("modules/grow/test/reads-a.ts", readsA(specifier));
      git("add", "-A");
      git("commit", "-qm", "move reads-a");
    };

    it("passes when it still loads the same file, through the renames, with the same query", () => {
      moveReadsA("../../../apps/server/src/grow/a.js?raw");
      const result = check();
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toMatch(/ok\s+apps\/server\/src\/grow\/reads-a\.ts -> modules\/grow\/test\/reads-a\.ts \(.*1 specifier\(s\) rewritten, same module\)/);
    });

    it.each([
      ["another file", "../../../apps/server/src/grow/b.js?raw"],
      ["another query", "../../../apps/server/src/grow/a.js?url"],
      ["no query", "../../../apps/server/src/grow/a.js"],
    ])("fails when it now loads %s", (_name, specifier) => {
      moveReadsA(specifier);
      const result = check();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toMatch(/NOT PURE\s+apps\/server\/src\/grow\/reads-a\.ts/);
    });
  });

  describe("vitest module paths and file URLs are specifiers", () => {
    /** A test file whose paths are all spelled by `spell`, padded so git pairs the move. */
    const mocks = (spell: (path: string) => string) => [
      'import { vi } from "vitest";',
      `vi.mock("${spell("grow/a.js")}");`,
      `vi.doMock("${spell("grow/b.js")}", () => ({ b: 2 }));`,
      `vitest.unmock("${spell("grow/b.js")}");`,
      `vi.doUnmock("${spell("grow/b.js")}");`,
      `export const real = vi.importActual("${spell("grow/auth.js")}");`,
      `export const fake = vitest.importMock("${spell("shared/helper.js")}");`,
      'export const tool = vi.importMock("@x/lib/tool");',
      'const HERE = import.meta.url;',
      `export const source = new URL("${spell("grow/a.ts")}", import.meta.url);`,
      `export const dir = new URL("${spell("shared/")}", HERE);`,
      ...Array.from({ length: 40 }, (_, index) => `export const padding${index} = "line ${index}".length;`),
      "",
    ].join("\n");
    const atOld = (path: string) => `../src/${path}`;
    const atNew = (path: string) => `../../../../apps/server/src/${path}`;

    beforeEach(() => {
      write("apps/server/test/grow.test.ts", mocks(atOld));
      git("add", ".");
      git("commit", "-qm", "grow test");
      git("branch", "-f", "base");
    });

    const moveTest = (text: string) => {
      mkdirSync(join(repo, "modules/grow/test/server"), { recursive: true });
      git("mv", "apps/server/test/grow.test.ts", "modules/grow/test/server/grow.test.ts");
      write("modules/grow/test/server/grow.test.ts", text);
      git("add", "-A");
      git("commit", "-qm", "move grow test");
    };

    it("passes when each still names the same module, file or directory", () => {
      moveTest(mocks(atNew));
      const result = check();
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toMatch(/ok\s+apps\/server\/test\/grow\.test\.ts -> modules\/grow\/test\/server\/grow\.test\.ts \(.*8 specifier\(s\) rewritten, same module\)/);
    });

    it("fails a byte-identical move, whose paths now name nothing", () => {
      moveTest(mocks(atOld));
      const result = check();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('specifier "../src/grow/a.js" → "../src/grow/a.js" loads modules/grow/test/src/grow/a.js, not apps/server/src/grow/a.ts');
    });

    it.each([
      ["vi.mock", '"../../../../apps/server/src/grow/a.js");', '"../../../../apps/server/src/grow/auth-noop.js");'],
      ["vi.doMock", 'vi.doMock("../../../../apps/server/src/grow/b.js"', 'vi.doMock("../../../../apps/server/src/grow/a.js"'],
      ["vitest.unmock", 'vitest.unmock("../../../../apps/server/src/grow/b.js"', 'vitest.unmock("../../../../apps/server/src/grow/a.js"'],
      ["vi.doUnmock", 'vi.doUnmock("../../../../apps/server/src/grow/b.js"', 'vi.doUnmock("../../../../apps/server/src/grow/a.js"'],
      ["vi.importActual", "src/grow/auth.js", "src/grow/auth-noop.js"],
      ["vitest.importMock", "src/shared/helper.js", "src/grow/a.js"],
      ["a file URL to another file", "src/grow/a.ts", "src/grow/b.ts"],
      ["a file URL with an extension it did not have", 'new URL("../../../../apps/server/src/grow/a.ts"', 'new URL("../../../../apps/server/src/grow/a"'],
      ["a file URL to another directory", 'src/shared/", HERE', 'src/grow/", HERE'],
    ])("fails %s retargeted to another path", (_name, from, to) => {
      const text = mocks(atNew);
      expect(text).toContain(from);
      moveTest(text.replace(from, to));
      const result = check();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toMatch(/NOT PURE\s+apps\/server\/test\/grow\.test\.ts/);
    });

    it("follows a directory whose files all moved with it", () => {
      git("mv", "apps/server/src/shared", "apps/server/src/common");
      moveTest(mocks(atNew).replaceAll("src/shared/", "src/common/"));
      const result = check();
      expect(result.status, result.stdout).toBe(0);
    });

    it.each([
      ["vi.doMock", 'const P = "../src/grow/a.js";\nvi.doMock(P);\n'],
      ["vi.mock", "vi.mock(`../src/${'grow'}/a.js`);\n"],
      ["new URL", 'new URL(name, import.meta.url);\n'],
      ["import()", "await import(name);\n"],
    ])("fails a %s path that is not a literal, once the directory changes", (name, line) => {
      write("apps/server/test/grow.test.ts", line + mocks(atOld));
      git("add", ".");
      git("commit", "-qm", "dynamic");
      git("branch", "-f", "base");
      moveTest(line + mocks(atNew));
      const result = check();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(`${name}`);
      expect(result.stdout).toContain("with a non-literal path: cannot check that it loads the same file from the new directory");
    });

    it("passes a non-literal path when the file stays in its directory", () => {
      write("apps/server/test/grow.test.ts", 'vi.doMock(P);\n' + mocks(atOld));
      git("add", ".");
      git("commit", "-qm", "dynamic");
      git("branch", "-f", "base");
      git("mv", "apps/server/test/grow.test.ts", "apps/server/test/grown.test.ts");
      git("commit", "-qm", "rename");
      const result = check();
      expect(result.status, result.stdout).toBe(0);
    });

    it("leaves a URL against another base, or an absolute one, to the token comparison", () => {
      const extra = 'new URL("../x", "http://example.invalid/a/");\nnew URL("http://example.invalid/");\n';
      write("apps/server/test/grow.test.ts", extra + mocks(atOld));
      git("add", ".");
      git("commit", "-qm", "urls");
      git("branch", "-f", "base");
      moveTest(extra + mocks(atNew));
      expect(check().status).toBe(0);
    });
  });

  describe("every way a file names a path relative to itself", () => {
    const OLD = "apps/server/test/probe.test.ts";
    const NEW = "modules/grow/test/server/probe.test.ts";
    /** Padding so git pairs the move whatever the probe lines are. */
    const PAD = Array.from({ length: 40 }, (_, index) => `export const padding${index} = "line ${index}".length;`).join("\n");
    const atOld = (path: string) => `../src/${path}`;
    const atNew = (path: string) => `../../../../apps/server/src/${path}`;
    /** The path helpers every probe may use, imported as the checker requires. */
    const IMPORTS = [
      'import { dirname, join, resolve } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import { createRequire } from "node:module";',
    ].join("\n");

    /** Commit `before` at OLD as the base, move it to NEW as `after`, and check. */
    const probe = (before: string, after: string) => {
      if (existsSync(join(repo, NEW))) git("rm", "-q", NEW);
      write(OLD, `${before}\n${IMPORTS}\n${PAD}\n`);
      git("add", ".");
      git("commit", "-qm", "probe");
      git("branch", "-f", "base");
      mkdirSync(join(repo, "modules/grow/test/server"), { recursive: true });
      git("mv", OLD, NEW);
      write(NEW, `${after}\n${IMPORTS}\n${PAD}\n`);
      git("add", "-A");
      git("commit", "-qm", "move probe");
      return check();
    };
    /** The same lines before and after, with each path spelled for where the file is. */
    const spelled = (lines: (at: (path: string) => string) => string) => probe(lines(atOld), lines(atNew));
    const passes = (result: ReturnType<typeof check>) => expect(result.status, result.stdout).toBe(0);
    const fails = (result: ReturnType<typeof check>, text?: string) => {
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toMatch(/NOT PURE\s+apps\/server\/test\/probe\.test\.ts/);
      if (text !== undefined) expect(result.stdout).toContain(text);
    };

    describe("file URLs, by WHATWG URL resolution", () => {
      it("keeps a directory's trailing slash: `x/` and `x` differ as a base", () => {
        fails(probe(`new URL("${atOld("shared/")}", import.meta.url);`, `new URL("${atNew("shared")}", import.meta.url);`));
        passes(spelled((at) => `new URL("${at("shared/")}", import.meta.url);`));
      });

      it("fails a file named with a trailing slash, which does not read (ENOTDIR)", () => {
        fails(probe(`new URL("${atOld("grow/a.ts")}", import.meta.url);`, `new URL("${atNew("grow/a.ts/")}", import.meta.url);`));
      });

      it("decodes percent-escapes: `%61.ts` is `a.ts`", () => {
        passes(probe(`new URL("${atOld("grow/a.ts")}", import.meta.url);`, `new URL("${atNew("grow/%61.ts")}", import.meta.url);`));
        fails(probe(`new URL("${atOld("grow/b.ts")}", import.meta.url);`, `new URL("${atNew("grow/%61.ts")}", import.meta.url);`));
      });

      it("resolves against `new globalThis.URL` and a `./` directory URL", () => {
        fails(probe(`new globalThis.URL("${atOld("grow/a.ts")}", import.meta.url);`, `new globalThis.URL("${atOld("grow/a.ts")}", import.meta.url);`));
        passes(spelled((at) => `new globalThis.URL("${at("grow/a.ts")}", new URL("./", import.meta.url));`));
      });

      it.each([
        ["a parameter", (at: (path: string) => string) => `const HERE = import.meta.url;\nexport function f(HERE: string) { return new URL("${at("grow/a.ts")}", HERE); }`],
        ["a block const", (at: (path: string) => string) => `const HERE = import.meta.url;\n{ const HERE = "https://example.invalid/x/"; new URL("${at("grow/a.ts")}", HERE); }`],
      ])("does not trust a file-URL const that %s shadows", (_name, lines) => {
        fails(probe(lines(atOld), lines(atNew)), "import.meta.url");
      });

      it("names the repository root the same way on both sides", () => {
        // Cross-directory, rewritten to the new depth: with and without a trailing slash.
        passes(probe('new URL("../../../", import.meta.url);\nnew URL("../../..", import.meta.url);', 'new URL("../../../../", import.meta.url);\nnew URL("../../../..", import.meta.url);'));
        fails(probe('new URL("../../../", import.meta.url);', 'new URL("../../../", import.meta.url);'), 'URL "../../../" → "../../../" loads modules/, not ./');
        // A rename within the directory, unchanged.
        write(OLD, `new URL("../../../", import.meta.url);\n${PAD}\n`);
        git("rm", "-q", NEW);
        git("add", ".");
        git("commit", "-qm", "root");
        git("branch", "-f", "base");
        git("mv", OLD, "apps/server/test/rooted.test.ts");
        git("commit", "-qm", "rename");
        passes(check());
      });

      it.each([
        ["export { HERE }", "export { HERE };"],
        ["export { HERE as base }", "export { HERE as base };"],
        ["export default HERE", "export default HERE;"],
      ])("fails a file-URL const that escapes by %s", (_name, line) => {
        fails(spelled((at) => `const HERE = import.meta.url;\nnew URL("${at("grow/a.ts")}", HERE);\n${line}`), "HERE (bound to the file's location)");
      });

      it("trusts an unshadowed const, but not a `let` or a destructured `url`", () => {
        passes(spelled((at) => `const HERE = import.meta.url;\nnew URL("${at("grow/a.ts")}", HERE);`));
        fails(spelled((at) => `let HERE = import.meta.url;\nnew URL("${at("grow/a.ts")}", HERE);`), "import.meta.url");
        fails(spelled((at) => `const { url } = import.meta;\nnew URL("${at("grow/a.ts")}", url);`), "import.meta");
      });
    });

    describe("paths joined to the file's directory", () => {
      const anchors = [
        ["a const bound to dirname(fileURLToPath(import.meta.url))", "const here = dirname(fileURLToPath(import.meta.url));\n", "here"],
        ["a const bound to fileURLToPath(new URL(\".\", import.meta.url))", 'const here = fileURLToPath(new URL(".", import.meta.url));\n', "here"],
        ["import.meta.dirname", "", "import.meta.dirname"],
        ["__dirname", "", "__dirname"],
      ];

      it.each(anchors)("resolves join/resolve from %s", (_name, prelude, anchor) => {
        passes(spelled((at) => `${prelude}join(${anchor}, "${at("grow/a.ts")}");\nresolve(${anchor}, "${at("grow")}", "a.ts");`));
        fails(probe(`${prelude}join(${anchor}, "${atOld("grow/a.ts")}");`, `${prelude}join(${anchor}, "${atOld("grow/a.ts")}");`));
        fails(probe(`${prelude}join(${anchor}, "${atOld("grow/a.ts")}");`, `${prelude}join(${anchor}, "${atNew("grow/b.ts")}");`));
      });

      it.each([
        ["a local function", "function join2(base: string, path: string) { return path; }\n", "join2"],
        ["an unrelated object's method", "const helpers = { join: (base: string, path: string) => path };\n", "helpers.join"],
        ["an import from another module", 'import { join as pjoin } from "./grow-helpers.js";\n', "pjoin"],
      ])("gives no path semantics to %s", (_name, prelude, callee) => {
        // The literal is edited, so only path semantics could excuse it.
        fails(probe(`${prelude}export const x = ${callee}(import.meta.dirname, "./a.ts");`, `${prelude}export const x = ${callee}(import.meta.dirname, "${atNew("../test/a.ts")}");`), "import.meta.dirname");
      });

      it("gives no path semantics to a shadowed import", () => {
        const line = (at: string) => `export function f(join: (a: string, b: string) => string) { return join(import.meta.dirname, "${at}"); }`;
        fails(probe(line("./a.ts"), line(atNew("../test/a.ts"))), "import.meta.dirname");
      });

      it("accepts a renamed import, a namespace and a default import of node:path", () => {
        passes(spelled((at) => `import { join as pjoin } from "node:path";\nimport * as nodePath from "node:path";\nimport path from "path";\npjoin(__dirname, "${at("grow/a.ts")}");\nnodePath.resolve(__dirname, "${at("grow/a.ts")}");\npath.join(__dirname, "${at("grow")}", "a.ts");`));
      });

      it("resolves from import.meta.filename / __filename as the file's own path", () => {
        passes(spelled((at) => `join(import.meta.filename, "..", "${at("grow/a.ts")}");\nresolve(__filename, "../${at("grow/a.ts")}");`));
      });

      it("fails the reviewer's probe: unchanged joins from a moved file", () => {
        const probeText = [
          "const here = dirname(fileURLToPath(import.meta.url));",
          'export const diagnostics = join(here, "../src/grow/a.ts");',
          'export const tokens = join(import.meta.dirname, "../src/shared/helper.ts");',
        ].join("\n");
        fails(probe(probeText, probeText), 'path "../src/grow/a.ts" → "../src/grow/a.ts" loads modules/grow/test/src/grow/a.ts, not apps/server/src/grow/a.ts');
      });

      it.each([
        ["used as a value", "const here = dirname(fileURLToPath(import.meta.url));\nreaddirSync(here);", "here (bound to the file's location)"],
        ["joined to a non-literal", "join(__dirname, name);", "join() from the file's location"],
        ["read some other way", "export const env = import.meta.env;", "import.meta.env"],
        ["a bare __filename", "export const self = __filename;", "__filename"],
      ])("fails a location read %s", (_name, line, text) => {
        fails(probe(line, line), text);
      });

      it("allows them all in a move within one directory", () => {
        const line = "const here = dirname(fileURLToPath(import.meta.url));\nreaddirSync(here);\nexport const env = import.meta.env;";
        write(OLD, `${IMPORTS}\n${line}\n${PAD}\n`);
        git("add", ".");
        git("commit", "-qm", "probe");
        git("branch", "-f", "base");
        git("mv", OLD, "apps/server/test/probed.test.ts");
        git("commit", "-qm", "rename");
        passes(check());
      });
    });

    describe("the module-imports guard's forms, shared with it", () => {
      it.each([
        ["vi by bracket", (at: (path: string) => string) => `vi["doMock"]("${at("grow/a.js")}", () => ({}));`],
        ["vi under another name", (at: (path: string) => string) => `import { vi as v } from "vitest";\nv.mock("${at("grow/a.js")}");`],
        ["a vitest namespace", (at: (path: string) => string) => `import * as V from "vitest";\nV.vi.importActual("${at("grow/a.js")}");`],
        ["createRequire(import.meta.url)", (at: (path: string) => string) => `const req = createRequire(import.meta.url);\nreq("${at("grow/a.js")}");\nreq.resolve("${at("grow/b.js")}");`],
        ["require.resolve", (at: (path: string) => string) => `require.resolve("${at("grow/a.js")}");`],
        ["import.meta.resolve", (at: (path: string) => string) => `import.meta.resolve("${at("grow/a.js")}");`],
        ["import.meta.glob", (at: (path: string) => string) => `import.meta.glob(["${at("grow/*.ts")}", "!${at("grow/b.ts")}"]);`],
      ])("checks %s: rewritten passes, unchanged fails", (_name, lines) => {
        passes(spelled(lines));
        fails(probe(lines(atOld), lines(atOld)));
      });

      it("fails a vi[key] with a non-literal key", () => {
        fails(spelled((at) => `vi[key]("${at("grow/a.js")}");`), "vi[…]");
      });

      it("fails a createRequire whose base is not the file", () => {
        fails(spelled((at) => `const req = createRequire(join(root, "package.json"));\nreq("${at("grow/a.js")}");`), "createRequire (its base is not this file)");
      });

      it("fails a triple-slash reference path", () => {
        fails(probe(`/// <reference path="${atOld("grow/a.ts")}" />`, `/// <reference path="${atOld("grow/a.ts")}" />`), "/// <reference path>");
      });
    });
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
    // Outside the repository: an untracked file in it would fail the check.
    const global = `${repo}.gitconfig`;
    // Each would change or break the diff the check reads, if it were not pinned or disabled.
    writeFileSync(global, "[diff]\n\tnoprefix = true\n\trenames = false\n\texternal = false\n[core]\n\tquotePath = true\n");
    const result = spawnSync(process.execPath, [SCRIPT, "base"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: global } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok\s+apps\/server\/src\/grow\/grow\.ts -> modules\/grow\/server\/grow\.ts/);
    rmSync(global);
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

  describe("refuses an OK that would vouch for nothing", () => {
    it("fails checking HEAD with an uncommitted edit or an untracked file", () => {
      moveGrow((source) => source);
      expect(check().status).toBe(0);
      write("apps/server/src/shared/helper.ts", "export const helper = (n: number) => n + 1;\n");
      const edited = check();
      expect(edited.status, edited.stdout).toBe(1);
      expect(edited.stdout).toContain("NOT CHECKED: the working tree has uncommitted changes (1)");
      expect(edited.stdout).toContain(" M apps/server/src/shared/helper.ts");
      git("checkout", "--", "apps/server/src/shared/helper.ts");
      write("modules/grow/server/forgotten.ts", "export const forgotten = 1;\n");
      const untracked = check();
      expect(untracked.status, untracked.stdout).toBe(1);
      expect(untracked.stdout).toContain("?? modules/grow/server/forgotten.ts");
      // --allow-empty does not excuse it; --worktree checks those changes instead.
      expect(check("--allow-empty").status).toBe(1);
    });

    it("fails a change with no renames unless --allow-empty", () => {
      write("apps/server/src/shared/helper.ts", "export const helper = (n: number) => n * 1;\n");
      git("add", ".");
      git("commit", "-qm", "edit only");
      const empty = check();
      expect(empty.status, empty.stdout).toBe(1);
      expect(empty.stdout).toContain("renames (0):");
      expect(empty.stdout).toContain("NOT PURE: no renames");
      const allowed = check("--allow-empty");
      expect(allowed.status, allowed.stdout).toBe(0);
      expect(allowed.stdout).toContain("OK: every rename is a pure move");
      expect(check("--worktree").status).toBe(1);
      expect(check("--worktree", "--allow-empty").status).toBe(0);
    });
  });

  it("rejects unknown flags and extra arguments", () => {
    expect(check("--nope").status).toBe(2);
    expect(check("extra").status).toBe(2);
  });
});
