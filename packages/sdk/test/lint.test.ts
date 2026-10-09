import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  builtWebCss,
  builtWebImports,
  colourLiterals,
  dataIconAttributes,
  deepUiImports,
  inlineStyles,
  legacyTokens,
  lintModule,
  moduleCssImports,
  moduleImports,
  modulePrefix,
  offScaleRadii,
  stripComments,
  type LintFile,
  type Offence,
} from "../lint/index.ts";

const CLI = fileURLToPath(new URL("../lint/cli.ts", import.meta.url));
const EXAMPLES = fileURLToPath(new URL("../../../examples/modules/", import.meta.url));

const file = (rel: string, text: string): LintFile => ({ rel, text });
const where = (offences: readonly Offence[]) => offences.map(({ rule, file: rel, line }) => `${rule} ${rel}:${line}`);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A module directory holding `files` (path → text), with a manifest. */
function moduleDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-module-lint-"));
  dirs.push(dir);
  writeFileSync(join(dir, "deck-module.json"), JSON.stringify({ id: "probe", version: "1.0.0", deckApi: "^0.1" }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("the guardrail rules", () => {
  it("strips comments but keeps line numbers", () => {
    expect(stripComments("a /* x\ny */ b // c\nd")).toBe("a \n b \nd");
    expect(stripComments('href="https://x"')).toBe('href="https://x"');
  });

  it("finds colour literals in code, not in comments", () => {
    const offences = colourLiterals([file("a.tsx", 'const a = "#ff0000";\n// #00ff00\nconst b = "rgb(0 0 0)";\nconst c = "oklch(0.5 0 0)";\nconst d = "#fff-ish";')]);
    expect(where(offences)).toEqual(["colour-literal a.tsx:1", "colour-literal a.tsx:3", "colour-literal a.tsx:4"]);
  });

  it("finds corners off the radius scale, prefixed or not", () => {
    const offences = offScaleRadii([
      file("a.tsx", '<div className="rounded p-2" />\n<div className="hello:rounded-2xl" />\n<div className="rounded-[4px]" />\n<div className="rounded-md rounded-full rounded-[inherit] rounded-t-lg" />'),
    ]);
    expect(where(offences)).toEqual(["radius-scale a.tsx:1", "radius-scale a.tsx:2", "radius-scale a.tsx:3"]);
  });

  it("allows inline styles only in allowlisted files, and reports a stale entry", () => {
    const files = [file("a.tsx", "<div style={{ width }} />"), file("b.tsx", "<div style={{ width }} />"), file("c.tsx", "<div />")];
    expect(where(inlineStyles(files, { "b.tsx": "dynamic geometry", "c.tsx": "gone" }))).toEqual(["inline-style a.tsx:0", "stale-style-allowlist c.tsx:0"]);
  });

  it("finds a style prop in plain JavaScript, where a no-build web half writes jsx() calls", () => {
    const files = [file("web.js", 'jsx("p", { style: { width } })'), file("a.tsx", "const theme = { style: 1 };")];
    expect(where(inlineStyles(files))).toEqual(["inline-style web.js:0"]);
  });

  it("finds data-icon attributes and legacy tokens", () => {
    expect(where(dataIconAttributes([file("a.tsx", '<span data-icon="x" />')]))).toEqual(["data-icon a.tsx:1"]);
    expect(where(legacyTokens([file("a.css", ".x {\n  color: var(--inventory-ok);\n}")]))).toEqual(["legacy-token a.css:2"]);
  });

  it("finds deep imports of the UI library unless justified", () => {
    const offences = deepUiImports([
      file("src/a.tsx", 'import { x } from "@/ui/patterns/x";\n// ui-deep-import: needs the internal\nimport { y } from "@/ui/lib/y";\nimport { z } from "@/ui";'),
    ]);
    expect(where(offences)).toEqual(["ui-deep-import src/a.tsx:1"]);
  });
});

describe("what a module's web half may import", () => {
  it("allows the import-mapped specifiers, relative files, bundled packages and types from @deck/module-sdk", () => {
    const source = [
      'import { jsx } from "react/jsx-runtime";',
      'import { useState } from "react";',
      'import { createPortal } from "react-dom";',
      'import { PageHeader } from "@deck/sdk";',
      'import type { ServerModule } from "@deck/module-sdk";',
      'import { type WebModule } from "@deck/module-sdk";',
      'import manifest from "../../deck-module.json";',
      'import { formatDistance } from "date-fns";',
      'export type { Tone } from "@deck/sdk";',
      'export { type ServerModule } from "@deck/module-sdk";',
      'type T = import("@deck/contract").ProviderEnvelope;',
    ].join("\n");
    expect(moduleImports([file("src/web/a.tsx", source)])).toEqual([]);
  });

  it("refuses React's other entry points, deck's other packages, value imports of @deck/module-sdk and the UI libraries", () => {
    const source = [
      'import { createRoot } from "react-dom/client";',
      'import { jsxDEV } from "react/jsx-dev-runtime";',
      'import { defineWebModule } from "@deck/module-sdk";',
      'import { Button } from "@deck/sdk/primitives";',
      'import { cn } from "@deck/web";',
      'import { Dialog } from "radix-ui";',
      'import * as Popover from "@radix-ui/react-popover";',
      'import { Sun } from "lucide-react";',
      'const later = import("react-dom/server");',
      "const computed = import(name);",
    ].join("\n");
    expect(where(moduleImports([file("src/web/a.tsx", source)]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((line) => `module-import src/web/a.tsx:${line}`));
  });

  it("takes Tailwind only through @deck/sdk/tailwind, with the module's own prefix", () => {
    const css = file("src/web/web.css", '@import "tailwindcss";\n@import "@deck/sdk/tailwind";\n@import "@deck/sdk/tailwind" prefix(hello);\n@import "./extra.css";\n@import "@deck/sdk/tailwind" prefix(other);');
    expect(where(moduleCssImports([css], "hello"))).toEqual(["module-css-import src/web/web.css:1", "module-css-import src/web/web.css:2", "module-css-import src/web/web.css:5"]);
  });

  it("finds Tailwind however the CSS pulls it in: @tailwind, several imports on a line, a wrapped, unquoted or relative import", () => {
    const css = {
      ...file(
        "src/web/web.css",
        [
          '@import "./a.css"; @import "tailwindcss";',
          "@tailwind utilities;",
          "@import",
          '  "tailwindcss/utilities.css";',
          "@import url(tailwindcss);",
          '@import url("@deck/sdk/tailwind") prefix(hello);',
          '@import "../../node_modules/tailwindcss/index.css";',
        ].join("\n"),
      ),
      path: "/mod/src/web/web.css",
    };
    expect(where(moduleCssImports([css], "hello"))).toEqual([1, 2, 3, 5, 7].map((line) => `module-css-import src/web/web.css:${line}`));
  });

  it("derives a letters-only prefix from the module's id", () => {
    expect(modulePrefix("hello")).toBe("hello");
    expect(modulePrefix("hello2")).toBe("hello");
    expect(modulePrefix("hello-world")).toBe("helloworld");
    const css = (prefix: string) => file("web.css", `@import "@deck/sdk/tailwind" prefix(${prefix});`);
    expect(moduleCssImports([css("helloworld")], modulePrefix("hello-world"))).toEqual([]);
    expect(where(moduleCssImports([css("hello-world")], modulePrefix("hello-world")))).toEqual(["module-css-import web.css:1"]);
    expect(moduleCssImports([css("hello")], modulePrefix("hello2"))).toEqual([]);
    expect(where(moduleCssImports([css("hello2")], modulePrefix("hello2")))).toEqual(["module-css-import web.css:1"]);
  });

  it("refuses require() and import-equals in web code", () => {
    const source = 'const x = require("date-fns");\nimport y = require("./y");\nimport type Z = require("./z");';
    expect(where(moduleImports([file("src/web/a.ts", source)]))).toEqual(["module-import src/web/a.ts:1", "module-import src/web/a.ts:2"]);
  });
});

describe("build output", () => {
  it("refuses a web.js that imports anything but the import map and its own manifest as JSON", () => {
    const built = file("dist/probe/web.js", 'import{jsx as e}from"react/jsx-runtime";import"./chunk-a.js";import m from"./deck-module.json"with{type:"json"};import{x}from"date-fns";export{e,m,x};');
    expect(builtWebImports(built).map(({ message }) => message)).toEqual([
      "web.js must be one file: deck serves no ./chunk-a.js",
      expect.stringContaining("date-fns is not in deck's import map"),
    ]);
    const bare = file("web.js", 'import m from "./deck-module.json";\nconst r = require("react");');
    expect(builtWebImports(bare).map(({ line, message }) => `${line} ${message}`)).toEqual([
      '1 import ./deck-module.json as a JSON module: with { type: "json" }',
      expect.stringMatching(/^2 web.js is native ESM/),
    ]);
  });

  it("refuses a web.js that bundles React or React DOM, but not a bundled library's colours or styles", () => {
    const bundled = file("web.js", 'import{jsx}from"react/jsx-runtime";var a={__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:{}};');
    expect(builtWebImports(bundled).map(({ message }) => message)).toEqual([expect.stringContaining("bundles its own React or React DOM")]);
    const library = moduleDir({ "web.js": 'import{jsx as e}from"react/jsx-runtime";const c="rgb(1 2 3)",d="#ff0000";export default e("p",{style:{color:c}});' });
    expect(lintModule(library)).toEqual([]);
  });

  it("refuses a web.css with classes outside the module's prefix, base styles or Tailwind's palette", () => {
    const own = file("web.css", ".probe\\:p-4{padding:1rem}.probe-when{color:var(--muted)}.probe\\:dark\\:bg-card:where(.dark, .dark *){background:var(--card)}[data-slot=x]{gap:1rem}@media (width>=48rem){.probe\\:md\\:p-6{padding:2rem}}");
    expect(builtWebCss(own, "probe")).toEqual([]);
    const plainTailwind = file(
      "web.css",
      "/*! tailwindcss v4.3.3 */@layer base{*,::after,::before{box-sizing:border-box;margin:0}}@layer theme{:root{--color-red-500:oklch(63.7% .237 25.331)}}@layer utilities{.p-4{padding:1rem}.dark .card{color:red}}",
    );
    expect(builtWebCss(plainTailwind, "probe").map(({ message }) => message)).toEqual([
      expect.stringContaining(".p-4 is not the module's own class"),
      expect.stringContaining(".card is not the module's own class"),
      expect.stringContaining("adds base styles"),
      expect.stringContaining("carries Tailwind's palette (--color-red"),
    ]);
  });

  it("gives no exemption to a Tailwind banner: a source stylesheet still gets the source rules", () => {
    const dir = moduleDir({ "src/web/web.css": "/*! tailwindcss v4.3.3 */\n.x { color: #ff0000; }" });
    expect(where(lintModule(dir))).toEqual(["colour-literal src/web/web.css:2"]);
    const built = moduleDir({ "web.css": "/*! tailwindcss v4.3.3 */.p-4{padding:1rem}" });
    expect(where(lintModule(built))).toEqual(["built-web-css web.css:1"]);
  });
});

describe("lintModule", () => {
  it("passes the maintenance example", () => {
    expect(lintModule(join(EXAMPLES, "maintenance"))).toEqual([]);
  });

  it("checks every web script and stylesheet in the module, wherever it sits, but not the loader's server entry", () => {
    const dir = moduleDir({
      "src/web/Page.tsx": '<div className="rounded" style={{ color: "#f00" }} />',
      "src/web/web.css": '@import "tailwindcss";\n.x { color: rgb(1 2 3); }',
      "web/Real.tsx": 'export const C = () => <p className="probe:bg-[red]" />;',
      "src/web/Evil.mts": 'import { createRoot } from "react-dom/client";',
      "src/server/shared.tsx": 'export const S = () => <p style = {{ width }} />;',
      "server.ts": 'const c = "#fff"; import x from "@deck/server";',
      "src/web/Page.test.tsx": 'const c = "#fff";',
      "vite.config.ts": 'const c = "#fff";',
    });
    expect(where(lintModule(dir))).toEqual([
      "colour-literal src/web/Page.tsx:1",
      "colour-literal src/web/web.css:2",
      "colour-literal web/Real.tsx:1",
      "radius-scale src/web/Page.tsx:1",
      "inline-style src/server/shared.tsx:0",
      "inline-style src/web/Page.tsx:0",
      "module-import src/web/Evil.mts:1",
      "module-css-import src/web/web.css:1",
    ]);
    expect(where(lintModule(dir, { styleAllowlist: { "src/web/Page.tsx": "dynamic geometry" } }))).not.toContain("inline-style src/web/Page.tsx:0");
  });

  it("checks a test or config file that web code imports", () => {
    const dir = moduleDir({ "src/web/index.ts": 'import { theme } from "../../theme.config";\nexport { theme };', "theme.config.ts": 'export const theme = "#ff0000";' });
    expect(where(lintModule(dir))).toEqual(["colour-literal theme.config.ts:1"]);
  });

  it("finds colours as tokens only: colour functions, named colours in CSS and arbitrary colour utilities", () => {
    const css = file("web.css", ".a { color: hsl(0 100% 50%); }\n.b { background: rebeccapurple; }\n.c { color: var(--red-ish); border-color: transparent; }\n.d { color: color(display-p3 1 0 0); }");
    expect(where(colourLiterals([css]))).toEqual(["colour-literal web.css:1", "colour-literal web.css:2", "colour-literal web.css:4"]);
    const tsx = file("a.tsx", '<p className="hello:text-[hsl(0_0%_50%)]" />\n<p className="bg-[#fff]" />\n<p className="bg-card" />');
    expect(where(colourLiterals([tsx]))).toEqual(["colour-literal a.tsx:1", "colour-literal a.tsx:2"]);
  });

  it("checks the built web.js and web.css in dist/<id>/, and those beside the manifest", () => {
    const built = moduleDir({ "src/web/index.ts": "export {};", "dist/probe/deck-module.json": "{}", "dist/probe/web.js": 'import "react-dom/client";' });
    writeFileSync(join(built, "dist/probe/deck-module.json"), JSON.stringify({ id: "probe", version: "1.0.0", deckApi: "^0.1" }));
    expect(where(lintModule(built))).toEqual(["built-web-import dist/probe/web.js:1"]);
    const plain = moduleDir({ "web.js": 'import { jsx } from "react/jsx-runtime";\nimport x from "date-fns";\nimport m from "./deck-module.json" with { type: "json" };' });
    expect(where(lintModule(plain))).toEqual(["built-web-import web.js:2"]);
  });
});

describe("deck-module lint", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

  it("exits 0 on a clean module and 1 with each offence on a seeded violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "deck-module-lint-cli-"));
    dirs.push(dir);
    cpSync(join(EXAMPLES, "maintenance"), dir, { recursive: true });
    const clean = run("lint", dir);
    expect(clean.stderr).toBe("");
    expect(clean.stdout).toContain("no offences");
    expect(clean.status).toBe(0);

    writeFileSync(join(dir, "web.css"), ".when { color: var(--muted-foreground); }\n");
    const seeded = run("lint", dir);
    expect(seeded.status).toBe(1);
    expect(seeded.stderr).toContain("web.css:1 built-web-css: .when is not the module's own class");
    expect(seeded.stderr).toContain("deck-module lint: 1 offence");
  });

  it("reads the style allowlist from the module's package.json", () => {
    const dir = moduleDir({ "src/web/Bar.tsx": "<div style={{ width }} />" });
    expect(run("lint", dir).status).toBe(1);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ deckModule: { lint: { styleAllowlist: { "src/web/Bar.tsx": "fill width from the value" } } } }));
    expect(run("lint", dir).status).toBe(0);
  });

  it("exits 2 on a package.json it cannot read options from", () => {
    const dir = moduleDir({ "package.json": "{ not json" });
    const broken = run("lint", dir);
    expect(broken.status).toBe(2);
    expect(broken.stderr).toContain("is not valid JSON");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ deckModule: { lint: { styleAllowlist: ["src/a.tsx"] } } }));
    expect(run("lint", dir).status).toBe(2);
  });

  it("says when a module with sources has no built web.js to check", () => {
    const dir = moduleDir({ "src/web/index.tsx": "export {};" });
    const result = run("lint", dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no built web.js found");
  });

  it("exits 2 on bad usage or a directory with no manifest", () => {
    expect(run().status).toBe(2);
    expect(run("lint", tmpdir(), "extra").status).toBe(2);
    const empty = mkdtempSync(join(tmpdir(), "deck-module-lint-empty-"));
    dirs.push(empty);
    const result = run("lint", empty);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has no deck-module.json");
  });
});
