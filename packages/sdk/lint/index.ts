/**
 * deck's UI guardrails as static rules over source text. They are the one source for both the
 * web app's guardrails test (apps/web/test/ui-guardrails.test.ts) and `deck-module lint`, which
 * runs on a runtime module's web half the rules that apply to it (see `lintModule`).
 *
 * Each rule takes files as `{ rel, text }` and returns its offences, each with the file, the
 * 1-based line and why. Choosing which files a rule sees is the caller's: the web app checks
 * its own `src/`, a module its web sources.
 *
 * This file runs as it is under Node (type stripping), so it uses erasable TypeScript only and
 * imports nothing relative.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export interface LintFile {
  /** The file's path relative to the root being checked, with `/` separators. */
  rel: string;
  text: string;
}

export type RuleId =
  | "ui-deep-import"
  | "colour-literal"
  | "radius-scale"
  | "inline-style"
  | "stale-style-allowlist"
  | "pattern-data-slot"
  | "data-icon"
  | "legacy-token"
  | "legacy-stylesheet"
  | "module-import"
  | "module-css-import"
  | "built-web-import";

export interface Offence {
  rule: RuleId;
  file: string;
  /** 1-based; 0 when the offence is about the whole file. */
  line: number;
  message: string;
}

/** `file:line rule: message`, as the guardrails test and the CLI print an offence. */
export const formatOffence = ({ rule, file, line, message }: Offence): string => `${file}${line > 0 ? `:${line}` : ""} ${rule}: ${message}`;

/**
 * `text` with its comments blanked, so prose that mentions a rule doesn't trip it. Line breaks
 * inside a block comment are kept, so line numbers still match the file.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, "")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** One offence per line of `file` (comments stripped) that `pattern` matches. */
function lineOffences(file: LintFile, pattern: RegExp, rule: RuleId, message: string): Offence[] {
  return stripComments(file.text)
    .split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [{ rule, file: file.rel, line: index + 1, message }] : []));
}

// ---------------------------------------------------------------------------------------------
// Styling: tokens, not literals.

/** A hex, `rgb()`/`rgba()` or `oklch()` colour literal. */
export const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\boklch\(/;

/** Colour literals: colours come from theme tokens (Tailwind token classes, `var(--…)`). */
export const colourLiterals = (files: readonly LintFile[]): Offence[] =>
  files.flatMap((file) => lineOffences(file, COLOUR_LITERAL, "colour-literal", "use theme tokens (Tailwind token classes or var(--…)), not a colour literal"));

/**
 * A corner off the theme's radius scale: a bare `rounded` (Tailwind's fixed 0.25rem),
 * `rounded-2xl`…`4xl` or a pixel `rounded-[4px]` ignores `--corner-*`, so `ui.theme.radius`
 * would not reach it. The scale is `rounded-xs`…`xl`, `rounded-full`, `rounded-none` and
 * `rounded-[inherit]`. A prefixed class (`hello:rounded`) counts the same.
 */
export const OFF_SCALE_RADIUS = /(?<![\w-])rounded(?:-[trblse]{1,2})?(?:(?=["'`\s])|-\[\d|-[234]xl\b)/;

export const offScaleRadii = (files: readonly LintFile[]): Offence[] =>
  files.flatMap((file) => lineOffences(file, OFF_SCALE_RADIUS, "radius-scale", "round corners from the radius scale (rounded-sm, rounded-md, …)"));

/**
 * Whether `file` sets an inline style: `style={…}` in JSX, or a `style:` prop in plain
 * JavaScript (`jsx("p", { style: … })`, as a module with no build step writes it).
 */
export const usesInlineStyle = (file: LintFile): boolean => {
  const text = stripComments(file.text);
  return /\bstyle=\{/.test(text) || (/\.m?js$/.test(file.rel) && /\bstyle\s*:/.test(text));
};

/**
 * Inline styles outside `allowlist` (file → why): they are for dynamic geometry only, and every
 * allowlisted file must still use one (an allowlist only shrinks).
 */
export function inlineStyles(files: readonly LintFile[], allowlist: Readonly<Record<string, string>> = {}): Offence[] {
  const using = files.filter(usesInlineStyle);
  const offences: Offence[] = using
    .filter(({ rel }) => !Object.hasOwn(allowlist, rel))
    .map(({ rel }) => ({ rule: "inline-style", file: rel, line: 0, message: "use classes; an inline style= is for dynamic geometry only, in an allowlisted file" }));
  const usingRels = new Set(using.map(({ rel }) => rel));
  for (const rel of Object.keys(allowlist)) {
    if (!usingRels.has(rel)) offences.push({ rule: "stale-style-allowlist", file: rel, line: 0, message: "remove this style= allowlist entry: the file no longer uses style=" });
  }
  return offences;
}

// ---------------------------------------------------------------------------------------------
// Components and legacy styling.

/** `data-icon` attributes: the legacy icon masks are gone; icons are `<Icon name>`. */
export const dataIconAttributes = (files: readonly LintFile[]): Offence[] =>
  files.flatMap((file) => lineOffences(file, /data-icon\b/, "data-icon", "render icons with <Icon name>, not data-icon"));

/** References to the legacy tokens (`--inventory-*`, `--freshness-*`, `--l-*`). */
export const legacyTokens = (files: readonly LintFile[]): Offence[] =>
  files.flatMap((file) => lineOffences(file, /--(inventory|freshness|l)-[\w-]+/, "legacy-token", "use the theme tokens; the legacy --inventory-*, --freshness-* and --l-* tokens are gone"));

/** Library patterns (`src/ui/patterns/*`) without a `data-slot` on their root. */
export const patternsWithoutDataSlot = (patterns: readonly LintFile[]): Offence[] =>
  patterns
    .filter(({ text }) => !/data-slot=/.test(text))
    .map(({ rel }) => ({ rule: "pattern-data-slot", file: rel, line: 0, message: "root every pattern in a data-slot" }));

/**
 * Deep imports of the UI library from outside it (`@/ui/…` or a relative `…/ui/…`), unless the
 * line before justifies it with `// ui-deep-import: <why>`. Features import the `@/ui` barrel.
 */
export const deepUiImports = (files: readonly LintFile[]): Offence[] =>
  files.flatMap(({ rel, text }) => {
    const lines = text.split("\n");
    return lines.flatMap((line, index) => {
      const deep = /from\s+["']@\/ui\/[^"']+["']/.test(line) || /["'](\.\.\/)+ui\//.test(line);
      return deep && !/ui-deep-import:/.test(lines[index - 1] ?? "")
        ? [{ rule: "ui-deep-import" as const, file: rel, line: index + 1, message: 'import from "@/ui", or justify with a preceding `// ui-deep-import: <why>`' }]
        : [];
    });
  });

/** The web app's stylesheet entry declares no `legacy` cascade layer, and no legacy stylesheet exists. */
export function legacyStylesheets(appCss: LintFile, css: readonly LintFile[]): Offence[] {
  const offences: Offence[] = lineOffences(appCss, /\blegacy\b/, "legacy-stylesheet", "declare no legacy cascade layer");
  for (const { rel } of css) {
    if (/(^|\/)styles\/(deck|icons)\.css$/.test(rel)) offences.push({ rule: "legacy-stylesheet", file: rel, line: 0, message: "the legacy stylesheets are gone" });
  }
  return offences;
}

// ---------------------------------------------------------------------------------------------
// Runtime modules: what a web half may import.

/**
 * The bare specifiers deck's page maps to its own modules with an import map. A runtime
 * module's built `web.js` imports these and nothing else; the web app's import map must map
 * exactly these (apps/web/test/sdk.test.ts).
 */
export const IMPORT_MAP_SPECIFIERS: readonly string[] = ["react", "react-dom", "react/jsx-runtime", "@deck/sdk"];

/** Packages whose job `@deck/sdk` does: its patterns and `<Icon>` carry deck's look and a11y. */
const UI_PACKAGES = /^(radix-ui|@radix-ui\/.+|lucide-react)$/;

interface ImportSite {
  specifier: string;
  line: number;
  /** `import type`/`export type` (or only type-only names): erased from the build. */
  typeOnly: boolean;
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".mjs": ts.ScriptKind.JS };

/** Every import in a script: static, re-exports and dynamic `import()`. */
function importSites({ rel, text }: LintFile): ImportSite[] {
  const extension = /\.[^.]+$/.exec(rel)?.[0] ?? ".js";
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension] ?? ts.ScriptKind.JS);
  const sites: ImportSite[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && named !== undefined && named.length > 0 && named.every((element) => element.isTypeOnly)));
      sites.push({ specifier: node.moduleSpecifier.text, line: at(node), typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
      const typeOnly = node.isTypeOnly || (named !== undefined && named.length > 0 && named.every((element) => element.isTypeOnly));
      sites.push({ specifier: node.moduleSpecifier.text, line: at(node), typeOnly });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      sites.push({ specifier: argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "<computed>", line: at(node), typeOnly: false });
    } else if (ts.isImportTypeNode(node)) {
      return; // `import("x").T` in a type position: erased.
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Why a module's web source may not import `specifier`, or undefined when it may. */
function importProblem({ specifier, typeOnly }: ImportSite): string | undefined {
  if (specifier.startsWith(".") || IMPORT_MAP_SPECIFIERS.includes(specifier)) return undefined;
  if (specifier === "<computed>") return "import() a fixed specifier: the build bundles what a web half needs";
  if (/^react(-dom)?\//.test(specifier)) return `deck's import map shares react, react-dom and react/jsx-runtime only: ${specifier} would bundle a second React`;
  if (specifier === "@deck/module-sdk") return typeOnly ? undefined : "import defineWebModule and the rest from @deck/sdk; @deck/module-sdk is for types (import type)";
  if (specifier.startsWith("@deck/")) return `${specifier} is not part of the module API: import from @deck/sdk`;
  if (UI_PACKAGES.test(specifier)) return `build from @deck/sdk's patterns and <Icon>, not ${specifier}`;
  return undefined; // Any other package is bundled into web.js.
}

/**
 * A module's web sources import only what its build can resolve without a second copy of deck:
 * relative files, the import-mapped `react`, `react-dom`, `react/jsx-runtime` and `@deck/sdk`,
 * types from `@deck/module-sdk`, and packages it bundles, never React's other entry points,
 * deck's other packages or the UI libraries `@deck/sdk` stands in for.
 */
export const moduleImports = (scripts: readonly LintFile[]): Offence[] =>
  scripts.flatMap((file) =>
    importSites(file).flatMap((site) => {
      const message = importProblem(site);
      return message === undefined ? [] : [{ rule: "module-import" as const, file: file.rel, line: site.line, message }];
    }),
  );

/**
 * A module's CSS takes Tailwind only through `@deck/sdk/tailwind`, with a `prefix(…)` of the
 * module's own: plain `tailwindcss` (or an `@tailwind` directive) would bring a second Preflight
 * and a palette that is not deck's tokens, and unprefixed utilities would re-declare deck's own
 * classes after deck's stylesheet, overriding its responsive variants.
 */
export const moduleCssImports = (css: readonly LintFile[]): Offence[] =>
  css.flatMap((file) => {
    const text = stripComments(file.text);
    const lineAt = (index: number) => text.slice(0, index).split("\n").length;
    const offences: Offence[] = [];
    const offence = (index: number, message: string) => offences.push({ rule: "module-css-import", file: file.rel, line: lineAt(index), message });
    // Every @import, wherever it sits on a line or however it wraps: "x", 'x', url("x") or url(x).
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]+))\s*\)?([^;]*)/g)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      const rest = match[4] ?? "";
      if (/^tailwindcss(\/|$)/.test(specifier)) offence(match.index, `import @deck/sdk/tailwind with your module's prefix, not ${specifier}`);
      else if (specifier === "@deck/sdk/tailwind" && !/\bprefix\(\s*[a-z][a-z0-9]*\s*\)/.test(rest)) {
        offence(match.index, 'import @deck/sdk/tailwind with a prefix of your module\'s own, e.g. `@import "@deck/sdk/tailwind" prefix(hello);`');
      }
    }
    for (const match of text.matchAll(/@tailwind\b/g)) offence(match.index, "take Tailwind through @deck/sdk/tailwind with your module's prefix, not an @tailwind directive");
    return offences.sort((a, b) => a.line - b.line);
  });

/**
 * The `web.js` deck serves imports only the import-mapped specifiers (and, as a JSON module,
 * its own `./deck-module.json`): deck serves `web.js`, `web.css` and `deck-module.json` and
 * nothing else, so a web half is one file, and any other bare specifier would not resolve in
 * the browser.
 */
export const builtWebImports = (webJs: LintFile): Offence[] =>
  importSites(webJs)
    .filter(({ specifier }) => !IMPORT_MAP_SPECIFIERS.includes(specifier) && specifier !== "./deck-module.json")
    .map(({ specifier, line }) => ({
      rule: "built-web-import" as const,
      file: webJs.rel,
      line,
      message: specifier.startsWith(".") ? `web.js must be one file: deck serves no ${specifier}` : `${specifier} is not in deck's import map (${IMPORT_MAP_SPECIFIERS.join(", ")}): bundle it, or import it from @deck/sdk`,
    }));

// ---------------------------------------------------------------------------------------------
// `deck-module lint`: a runtime module's profile.

const SCRIPT = /\.(tsx?|jsx?|mjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "server", "test", "tests"]);

/** `rel` with `/` separators on every platform. */
const slashed = (rel: string): string => rel.split(sep).join("/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith(".") || SKIPPED_DIRS.has(name) ? [] : walk(path);
    return [path];
  });
}

/**
 * A module's web sources, relative to `dir`: every script and stylesheet under `src/` (or, for
 * a module with no build step, under `dir` itself), except its server entry (`server.*` or a
 * `server/` directory), tests, config files (`*.config.*`), declarations and build output.
 */
export function moduleWebSources(dir: string): LintFile[] {
  const root = existsSync(join(dir, "src")) ? join(dir, "src") : dir;
  return walk(root)
    .filter((path) => {
      const name = path.slice(path.lastIndexOf(sep) + 1);
      return (SCRIPT.test(name) || name.endsWith(".css")) && !/^server\.[^.]+$/.test(name) && !/\.config\.[^.]+$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith(".d.ts");
    })
    .map((path) => ({ rel: slashed(relative(dir, path)), text: readFileSync(path, "utf8") }))
    // A built module directory (what dist/<id> holds) carries Tailwind's compiled web.css: build
    // output, with Tailwind's own fallbacks in it, not the module's source.
    .filter(({ rel, text }) => !(rel.endsWith(".css") && text.startsWith("/*! tailwindcss")))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The module's built `web.js`, if any: `web.js` beside its manifest, or `dist/<id>/web.js`. */
export function builtWebJs(dir: string): LintFile | undefined {
  const candidates = ["web.js"];
  try {
    const { id } = JSON.parse(readFileSync(join(dir, "deck-module.json"), "utf8")) as { id?: unknown };
    if (typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id)) candidates.push(`dist/${id}/web.js`);
  } catch {
    // No readable manifest: only a web.js beside it.
  }
  const rel = candidates.find((candidate) => existsSync(join(dir, candidate)));
  return rel === undefined ? undefined : { rel, text: readFileSync(join(dir, rel), "utf8") };
}

export interface ModuleLintOptions {
  /** Files that may set an inline style (dynamic geometry only), mapped to why. */
  styleAllowlist?: Readonly<Record<string, string>>;
}

/**
 * Lint a runtime module directory: deck's guardrails over its web sources, its imports and
 * CSS, and its built `web.js` if there is one.
 */
export function lintModule(dir: string, options: ModuleLintOptions = {}): Offence[] {
  const sources = moduleWebSources(dir);
  const scripts = sources.filter(({ rel }) => SCRIPT.test(rel));
  const css = sources.filter(({ rel }) => rel.endsWith(".css"));
  const built = builtWebJs(dir);
  // A web.js beside the manifest is what the browser loads as it is: it gets the built check.
  const modular = scripts.filter(({ rel }) => rel !== built?.rel);
  return [
    ...colourLiterals(sources),
    ...offScaleRadii(scripts),
    ...inlineStyles(scripts, options.styleAllowlist),
    ...dataIconAttributes(scripts),
    ...legacyTokens(sources),
    ...moduleImports(modular),
    ...moduleCssImports(css),
    ...(built === undefined ? [] : builtWebImports(built)),
  ];
}
