import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Library guardrails: static checks over `src/` that keep feature code on the
 * `@/ui` library. The allowlists below only shrink, and a stale entry fails the
 * test.
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(webRoot, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(srcRoot)
  .filter((path) => /\.tsx?$/.test(path))
  .map((path) => ({ rel: relative(webRoot, path), text: readFileSync(path, "utf8") }));
const tsx = files.filter(({ rel }) => rel.endsWith(".tsx"));
const inLibrary = (rel: string): boolean => rel.startsWith("src/ui/");

/** Strip comments so prose that mentions a rule doesn't trip it. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("imports: features use the @/ui barrel", () => {
  it("never deep-imports @/ui/* outside the library without a justification", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (inLibrary(rel)) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const deep = /from\s+["']@\/ui\/[^"']+["']/.test(line) || /["'](\.\.\/)+ui\//.test(line);
        if (deep && !/ui-deep-import:/.test(lines[i - 1] ?? "")) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, "import from \"@/ui\", or justify with a preceding `// ui-deep-import: <why>`").toEqual([]);
  });
});

describe("styling: tokens, not literals", () => {
  it("has no hex, rgb() or oklch() colour literals in TSX", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\boklch\(/;
    const offenders = tsx
      .filter(({ text }) => code(text).split("\n").some((line) => literal.test(line)))
      .map(({ rel }) => rel);
    expect(offenders, "use theme tokens (Tailwind classes) instead of colour literals").toEqual([]);
  });

  it("rounds corners only from the theme's radius scale, so ui.theme.radius reaches every corner", () => {
    // A bare `rounded` (Tailwind's fixed 0.25rem) or a pixel `rounded-[4px]` ignores
    // --corner-*; use rounded-xs…xl, rounded-full, rounded-none or rounded-[inherit].
    const offScale = /(?<![\w-])rounded(?:-[trblse]{1,2})?(?:(?=["'`\s])|-\[\d)/;
    const offenders = tsx
      .filter(({ text }) => code(text).split("\n").some((line) => offScale.test(line)))
      .map(({ rel }) => rel);
    expect(offenders, "use the radius scale (rounded-sm, rounded-md, …)").toEqual([]);
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

  const usesStyle = ({ text }: { text: string }): boolean => /\bstyle=\{/.test(code(text));

  it("uses inline style= only in allowlisted files", () => {
    const offenders = tsx.filter(usesStyle).map(({ rel }) => rel).filter((rel) => !(rel in STYLE_ALLOWLIST));
    expect(offenders, "use Tailwind classes; inline styles are for dynamic geometry only").toEqual([]);
  });

  it("has no stale style= allowlist entries", () => {
    const using = new Set(tsx.filter(usesStyle).map(({ rel }) => rel));
    const stale = Object.keys(STYLE_ALLOWLIST).filter((rel) => !using.has(rel));
    expect(stale, "remove these entries: the file no longer uses style=").toEqual([]);
  });
});

describe("library components", () => {
  const patterns = tsx.filter(({ rel }) => rel.startsWith("src/ui/patterns/"));

  it("roots every pattern in a data-slot", () => {
    const missing = patterns.filter(({ text }) => !/data-slot=/.test(text)).map(({ rel }) => rel);
    expect(missing).toEqual([]);
  });

  it("never sets data-icon (the legacy icon masks are gone; use <Icon>)", () => {
    const offenders = files.filter(({ text }) => /data-icon\b/.test(code(text))).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

describe("no legacy styling", () => {
  const css = walk(srcRoot)
    .filter((path) => path.endsWith(".css"))
    .map((path) => ({ rel: relative(webRoot, path), text: readFileSync(path, "utf8") }));

  it("references no legacy tokens (--inventory-*, --freshness-*, --l-*)", () => {
    const legacyToken = /--(inventory|freshness|l)-[\w-]+/;
    const offenders = [...files, ...css]
      .filter(({ text }) => legacyToken.test(code(text)))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("declares no legacy cascade layer and imports no legacy stylesheet", () => {
    const app = readFileSync(resolve(srcRoot, "styles/app.css"), "utf8");
    expect(app).not.toMatch(/\blegacy\b/);
    expect(css.map(({ rel }) => rel)).not.toEqual(
      expect.arrayContaining(["src/styles/deck.css", "src/styles/icons.css"]),
    );
  });
});
