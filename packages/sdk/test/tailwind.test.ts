import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * The `@deck/sdk/tailwind` preset, compiled as a module's stylesheet compiles it: utilities only,
 * every class under the module's prefix, and deck's tokens in place of Tailwind's palette.
 */

const TAILWIND = dirname(createRequire(import.meta.url).resolve("tailwindcss/package.json"));
const PRESET = fileURLToPath(new URL("../tailwind/index.css", import.meta.url));

async function build(css: string, candidates: string[]): Promise<string> {
  const compiler = await compile(css, {
    base: dirname(PRESET),
    async loadStylesheet(id, base) {
      const path = id.startsWith("tailwindcss/") ? join(TAILWIND, id.slice("tailwindcss/".length)) : resolve(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(candidates);
}

describe("@deck/sdk/tailwind", () => {
  const css = () =>
    build(`@import "./index.css" prefix(hello);`, [
      "hello:p-4",
      "hello:md:p-6",
      "hello:bg-card",
      "hello:text-status-warn-fg",
      "hello:rounded-md",
      "hello:font-mono",
      "hello:dark:bg-muted",
      // None of these may exist.
      "p-4",
      "bg-card",
      "hello:bg-red-500",
      "hello:text-white",
      "hello:rounded-2xl",
      "hello:font-serif",
    ]);

  it("emits the module's prefixed utilities over deck's tokens", async () => {
    const out = await css();
    expect(out).toContain(".hello\\:bg-card {\n    background-color: var(--card);");
    expect(out).toContain(".hello\\:text-status-warn-fg {\n    color: var(--status-warn-fg);");
    expect(out).toContain(".hello\\:rounded-md {\n    border-radius: var(--corner-md);");
    expect(out).toContain('.hello\\:font-mono {\n    font-family: "Geist Mono Variable"');
    expect(out).toContain("@media (width >= 48rem) {\n    .hello\\:md\\:p-6");
    // deck's dark mode is the .dark class.
    expect(out).toContain(".hello\\:dark\\:bg-muted:where(.dark, .dark *) {\n    background-color: var(--muted);");
  });

  it("has no unprefixed class, no palette, no off-scale radius and no other font", async () => {
    const out = await css();
    const classes = [...out.matchAll(/^\s*\.([^\s{]+?)(?::where\(.*\))? \{$/gm)].map((match) => match[1]);
    expect(classes.length).toBe(7);
    expect(classes.every((name) => name!.startsWith("hello\\:"))).toBe(true);
    expect(out).not.toMatch(/bg-red-500|text-white|rounded-2xl|font-serif/);
  });

  it("adds no Preflight or base styles, and declares deck's layer order", async () => {
    const out = await css();
    expect(out).toContain("@layer theme, base, components, utilities;");
    expect(out).not.toMatch(/@layer base\s*\{/);
    expect(out).not.toMatch(/box-sizing|::before/);
    // The only theme variables are the module's own, under its prefix.
    expect([...out.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1])).toEqual(["--hello-spacing"]);
  });

  it("maps the same tokens as deck's own stylesheet, from the one shared file", () => {
    const app = readFileSync(fileURLToPath(new URL("../../../apps/web/src/styles/app.css", import.meta.url)), "utf8");
    expect(app).toContain('@import "@deck/sdk/tailwind/theme.css";');
    expect(readFileSync(PRESET, "utf8")).toContain('@import "./theme.css";');
  });
});
