import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

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
import { Scanner } from "@tailwindcss/oxide";
import { describe, expect, it } from "vitest";

import { moduleWebDirs, REPO_ROOT, sourceRel, walkFiles, webSourceFiles } from "./support/source-roots.js";

/**
 * Library guardrails: static checks over `src/` and the built-in modules' web halves
 * (`modules/<id>/web`) that keep feature code on the `@/ui` library. The rules live in
 * `@deck/sdk/lint`, which `deck-module lint` also runs on runtime modules, so deck and its
 * modules keep one set of rules. The allowlists below only shrink, and a stale entry fails the
 * test.
 */

/**
 * The sources the rules run over, in a repository: the web app's own and every module web half's
 * TS(X) and CSS (`webSourceRoots`), plus the token mapping deck shares with runtime modules.
 */
function collect(repo: string = REPO_ROOT) {
  const read = (path: string) => ({ rel: sourceRel(path, repo), text: readFileSync(path, "utf8") });
  const sources = webSourceFiles(repo);
  const files = sources.filter((path) => /\.tsx?$/.test(path)).map(read);
  const css = [...sources, ...walkFiles(join(repo, "packages/sdk/tailwind"))].filter((path) => path.endsWith(".css")).map(read);
  return { files, css, tsx: files.filter(({ rel }) => rel.endsWith(".tsx")), appCss: read(join(repo, "apps/web/src/styles/app.css")) };
}

const { files, css, tsx, appCss } = collect();
const inLibrary = (rel: string): boolean => rel.startsWith("src/ui/");

const shown = (offences: readonly Offence[]) => offences.map(formatOffence);

/**
 * The files under `modules/` that Tailwind's own scanner reads for the `@source` lines of an
 * app.css `text` (resolved, as the build resolves them, from app.css's directory). Module web
 * halves live outside apps/web, so these lines are the only way their classes reach the CSS.
 */
function tailwindSourceFiles(text: string): string[] {
  const base = join(REPO_ROOT, "apps/web/src/styles");
  const sources = [...text.matchAll(/^@source\s+"([^"]+)";/gm)].map(([, pattern]) => ({ base, pattern: pattern!, negated: false }));
  const scanner = new Scanner({ sources });
  scanner.scan();
  return scanner.files.filter((path) => path.startsWith(join(REPO_ROOT, "modules") + "/"));
}

describe("scope", () => {
  it("covers every built-in module's web half", () => {
    const dirs = moduleWebDirs();
    expect(dirs.map((dir) => relative(REPO_ROOT, dir))).toContain("modules/llm-usage/web");
    for (const dir of dirs) {
      const rel = relative(REPO_ROOT, dir);
      expect(files.some((file) => file.rel.startsWith(`${rel}/`)), rel).toBe(true);
    }
  });

  it("has Tailwind scan every file of every built-in module's web half (subdirectories too)", () => {
    const scanned = new Set(tailwindSourceFiles(appCss.text));
    const missed = moduleWebDirs().flatMap(walkFiles).filter((path) => /\.tsx?$/.test(path) && !scanned.has(path));
    expect(missed.map((path) => relative(REPO_ROOT, path))).toEqual([]);
    expect(scanned.size).toBeGreaterThan(0);
  });

  it("would catch an @source that stops at the module web directories (it scans no file)", () => {
    expect(tailwindSourceFiles('@source "../../../../modules/*/web";\n')).toEqual([]);
  });

  it("refuses an offending TSX or CSS line in a module's web half", () => {
    const repo = mkdtempSync(join(tmpdir(), "guardrails-"));
    try {
      const put = (path: string, text: string) => {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      };
      put("apps/web/src/styles/app.css", "@import \"tailwindcss\";\n");
      // Built from parts: Tailwind scans this file, and a literal class here would reach the app's CSS.
      const offScale = ["rounded", "2xl"].join("-");
      put("modules/llm-usage/web/Bad.tsx", [
        'import { Button } from "@/ui/primitives/button";',
        `export const Bad = () => <div className="${offScale}" style={{ color: "#ff0000" }} data-icon="x"><Button /></div>;`,
      ].join("\n"));
      put("modules/llm-usage/web/bad.css", ".bad { color: var(--inventory-ok); }\n");
      const fake = collect(repo);
      const at = (offences: readonly Offence[]) => offences.map(({ file }) => file);
      const bad = "modules/llm-usage/web/Bad.tsx";
      expect(at(deepUiImports(fake.files))).toContain(bad);
      expect(at(colourLiterals(fake.tsx))).toContain(bad);
      expect(at(offScaleRadii(fake.tsx))).toContain(bad);
      expect(at(inlineStyles(fake.tsx))).toContain(bad);
      expect(at(dataIconAttributes(fake.files))).toContain(bad);
      expect(at(legacyTokens([...fake.files, ...fake.css]))).toContain("modules/llm-usage/web/bad.css");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

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
    expect(css.map(({ rel }) => rel)).toEqual(expect.arrayContaining(["packages/sdk/tailwind/theme.css", "src/styles/theme.css"]));
    expect(shown(legacyTokens([...files, ...css]))).toEqual([]);
  });

  it("declares no legacy cascade layer and imports no legacy stylesheet", () => {
    expect(shown(legacyStylesheets(appCss, css))).toEqual([]);
  });
});
