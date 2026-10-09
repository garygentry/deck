import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  builtWebImports,
  colourLiterals,
  dataIconAttributes,
  deepUiImports,
  inlineStyles,
  legacyTokens,
  lintModule,
  moduleCssImports,
  moduleImports,
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

  it("takes Tailwind only through @deck/sdk/tailwind, with a prefix", () => {
    const css = file("src/web/web.css", '@import "tailwindcss";\n@import "@deck/sdk/tailwind";\n@import "@deck/sdk/tailwind" prefix(hello);\n@import "./extra.css";');
    expect(where(moduleCssImports([css]))).toEqual(["module-css-import src/web/web.css:1", "module-css-import src/web/web.css:2"]);
  });

  it("finds Tailwind however the CSS pulls it in: @tailwind, several imports on a line, a wrapped or unquoted import", () => {
    const css = file(
      "web.css",
      ['@import "./a.css"; @import "tailwindcss";', "@tailwind utilities;", "@import", '  "tailwindcss/utilities.css";', "@import url(tailwindcss);", '@import url("@deck/sdk/tailwind") prefix(hello);'].join("\n"),
    );
    expect(where(moduleCssImports([css]))).toEqual(["module-css-import web.css:1", "module-css-import web.css:2", "module-css-import web.css:3", "module-css-import web.css:5"]);
  });

  it("refuses a built web.js that imports anything but the import map and its own manifest", () => {
    const built = file("dist/probe/web.js", 'import{jsx as e}from"react/jsx-runtime";import"./chunk-a.js";import m from"./deck-module.json"with{type:"json"};import{x}from"date-fns";export{e,m,x};');
    expect(where(builtWebImports(built))).toEqual(["built-web-import dist/probe/web.js:1", "built-web-import dist/probe/web.js:1"]);
    expect(builtWebImports(built).map(({ message }) => message)).toEqual([
      "web.js must be one file: deck serves no ./chunk-a.js",
      expect.stringContaining("date-fns is not in deck's import map"),
    ]);
  });
});

describe("lintModule", () => {
  it("passes the maintenance example", () => {
    expect(lintModule(join(EXAMPLES, "maintenance"))).toEqual([]);
  });

  it("checks a module's web sources under src/, but not its server entry, tests or config", () => {
    const dir = moduleDir({
      "src/web/Page.tsx": '<div className="rounded" style={{ color: "#f00" }} />',
      "src/web/web.css": '@import "tailwindcss";\n.x { color: rgb(1 2 3); }',
      "src/server.ts": 'const c = "#fff"; import x from "@deck/server";',
      "src/web/Page.test.tsx": 'const c = "#fff";',
      "vite.config.ts": 'const c = "#fff";',
    });
    expect(where(lintModule(dir))).toEqual([
      "colour-literal src/web/Page.tsx:1",
      "colour-literal src/web/web.css:2",
      "radius-scale src/web/Page.tsx:1",
      "inline-style src/web/Page.tsx:0",
      "module-css-import src/web/web.css:1",
    ]);
    expect(where(lintModule(dir, { styleAllowlist: { "src/web/Page.tsx": "dynamic geometry" } }))).not.toContain("inline-style src/web/Page.tsx:0");
  });

  it("passes a built module directory as installed, whose web.css is Tailwind's compiled output", () => {
    const dir = moduleDir({
      "web.js": 'import{jsx as e}from"react/jsx-runtime";import{PageHeader as t}from"@deck/sdk";export default e(t,{title:"x"});',
      "web.css": "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */@supports (color:rgb(from red r g b)){*{--tw-x:0}}",
    });
    expect(lintModule(dir)).toEqual([]);
  });

  it("checks the built web.js in dist/<id>/, and a no-build web.js beside the manifest", () => {
    const built = moduleDir({ "src/web/index.ts": 'export { x } from "./x.js";', "dist/probe/web.js": 'import "react-dom/client";' });
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

    writeFileSync(join(dir, "web.css"), ".maintenance-when { color: #ff0000; }\n");
    const seeded = run("lint", dir);
    expect(seeded.status).toBe(1);
    expect(seeded.stderr).toContain("web.css:1 colour-literal: use theme tokens");
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
