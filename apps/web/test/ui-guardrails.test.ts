import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  colourLiterals,
  dataIconAttributes,
  deepUiImports,
  formatOffence,
  inlineStyles,
  legacyStylesheets,
  legacyTokens,
  offScaleRadii,
  patternsWithoutDataSlot,
  type Offence,
} from "@deck/sdk/lint";
import { describe, expect, it } from "vitest";

/**
 * Library guardrails: static checks over `src/` that keep feature code on the
 * `@/ui` library. The rules live in `@deck/sdk/lint`, which `deck-module lint`
 * also runs on runtime modules, so deck and its modules keep one set of rules.
 * The allowlists below only shrink, and a stale entry fails the test.
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(webRoot, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const read = (path: string) => ({ rel: relative(webRoot, path), text: readFileSync(path, "utf8") });
const files = walk(srcRoot).filter((path) => /\.tsx?$/.test(path)).map(read);
const css = walk(srcRoot).filter((path) => path.endsWith(".css")).map(read);
const tsx = files.filter(({ rel }) => rel.endsWith(".tsx"));
const inLibrary = (rel: string): boolean => rel.startsWith("src/ui/");

const shown = (offences: readonly Offence[]) => offences.map(formatOffence);

describe("imports: features use the @/ui barrel", () => {
  it("never deep-imports @/ui/* outside the library without a justification", () => {
    expect(shown(deepUiImports(files.filter(({ rel }) => !inLibrary(rel))))).toEqual([]);
  });
});

describe("styling: tokens, not literals", () => {
  it("has no hex, rgb() or oklch() colour literals in TSX", () => {
    expect(shown(colourLiterals(tsx))).toEqual([]);
  });

  it("rounds corners only from the theme's radius scale, so ui.theme.radius reaches every corner", () => {
    expect(shown(offScaleRadii(tsx))).toEqual([]);
  });

  // Inline styles allowed: dynamic geometry only.
  const STYLE_ALLOWLIST: Record<string, string> = {
    "src/ui/primitives/sidebar.tsx": "vendored shadcn: sidebar width CSS vars",
    "src/ui/primitives/toggle-group.tsx": "vendored shadcn: --gap CSS var",
    "src/ui/patterns/code-block.tsx": "maxHeight prop (dynamic geometry)",
    "src/ui/patterns/log-output.tsx": "maxHeight prop (dynamic geometry)",
    "src/ui/patterns/meter.tsx": "fill width from the value (dynamic geometry)",
    "src/ui/patterns/tree-view.tsx": "--tree-depth CSS var per row (indentation geometry)",
  };

  it("uses inline style= only in allowlisted files, with no stale entries", () => {
    expect(shown(inlineStyles(tsx, STYLE_ALLOWLIST))).toEqual([]);
  });
});

describe("library components", () => {
  it("roots every pattern in a data-slot", () => {
    expect(shown(patternsWithoutDataSlot(tsx.filter(({ rel }) => rel.startsWith("src/ui/patterns/"))))).toEqual([]);
  });

  it("never sets data-icon (the legacy icon masks are gone; use <Icon>)", () => {
    expect(shown(dataIconAttributes(files))).toEqual([]);
  });
});

describe("no legacy styling", () => {
  it("references no legacy tokens (--inventory-*, --freshness-*, --l-*)", () => {
    expect(shown(legacyTokens([...files, ...css]))).toEqual([]);
  });

  it("declares no legacy cascade layer and imports no legacy stylesheet", () => {
    expect(shown(legacyStylesheets(read(resolve(srcRoot, "styles/app.css")), css))).toEqual([]);
  });
});
