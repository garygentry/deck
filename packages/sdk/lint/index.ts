/**
 * deck's UI guardrails as static rules over source text. They are the one source for both the
 * web app's guardrails test (apps/web/test/ui-guardrails.test.ts) and `deck-module lint`, which
 * runs on a runtime module the rules that apply to it (see `lintModule`).
 *
 * Each rule takes files as `{ rel, text }` and returns its offences, each with the file, the
 * 1-based line and why. Choosing which files a rule sees is the caller's: the web app checks
 * its own `src/`, a module its web sources and its build output.
 *
 * This file runs as it is under Node (type stripping), so it uses erasable TypeScript only and
 * imports nothing relative.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import postcss, { type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import ts from "typescript";

export interface LintFile {
  /** The file's path relative to the root being checked, with `/` separators. */
  rel: string;
  text: string;
  /** The file's absolute path, where a rule resolves the file's relative imports. */
  path?: string;
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
  | "module-css-selector"
  | "built-web-import"
  | "built-web-css";

export interface Offence {
  rule: RuleId;
  file: string;
  /** 1-based; 0 when the offence is about the whole file. */
  line: number;
  message: string;
}

/** `file:line rule: message`, as the guardrails test and the CLI print an offence. */
export const formatOffence = ({ rule, file, line, message }: Offence): string => `${file}${line > 0 ? `:${line}` : ""} ${rule}: ${message}`;

/** `text` with its block comments blanked, keeping their line breaks so line numbers still match. */
const blankBlockComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""));

/**
 * A script's `text` with its comments blanked, so prose that mentions a rule doesn't trip it.
 * Line breaks inside a block comment are kept, so line numbers still match the file.
 */
export function stripComments(text: string): string {
  return blankBlockComments(text).replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A file's text with its comments blanked: CSS has block comments only (`//` is not one). */
const commentFree = (file: LintFile): string => (file.rel.endsWith(".css") ? blankBlockComments(file.text) : stripComments(file.text));

/** The 1-based line of `index` in `text`. */
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** One offence per line of `file` (comments blanked) that `pattern` matches. */
function lineOffences(file: LintFile, pattern: RegExp, rule: RuleId, message: string): Offence[] {
  return commentFree(file)
    .split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [{ rule, file: file.rel, line: index + 1, message }] : []));
}

// ---------------------------------------------------------------------------------------------
// Styling: tokens, not literals.

/** CSS's named colours (`transparent` and `currentcolor` are not colours of their own). */
const NAMED_COLOURS =
  "aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen";

/** A colour function. */
const COLOUR_FUNCTION = "(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(";

/** A hex colour or a colour function: `#f00`, `rgb(…)`, `hsl(…)`, `oklch(…)`, `color(…)` and the like. */
export const COLOUR_LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b(?![-\\w])|\\b${COLOUR_FUNCTION}`);

/** A Tailwind arbitrary colour: `bg-[red]`, `text-[#f00]`, `border-[hsl(…)]`, prefixed or not. */
export const ARBITRARY_COLOUR = new RegExp(`-\\[(?:#|${COLOUR_FUNCTION}|(?:${NAMED_COLOURS})\\])`, "i");

/** A named colour as a word of a CSS declaration's value (not inside a custom property's name). */
const NAMED_COLOUR_VALUE = new RegExp(`(?<![-\\w])(?:${NAMED_COLOURS})(?![-\\w])`, "i");

/** Every CSS declaration's value (a `property: value` inside a block), with the line it starts on. */
function cssValues(text: string): Array<{ value: string; line: number }> {
  const values: Array<{ value: string; line: number }> = [];
  for (const match of text.matchAll(/(?<=[{;]\s*)(--[\w-]+|[a-zA-Z-]+)\s*:([^;{}]*)(?=[;}])/g)) values.push({ value: match[2]!, line: lineOf(text, match.index) });
  return values;
}

/**
 * Colour literals: colours come from theme tokens (Tailwind token classes, `var(--…)`). In
 * scripts and CSS: a hex colour, a colour function or an arbitrary colour utility; in CSS
 * also a named colour in a declaration's value.
 */
export const colourLiterals = (files: readonly LintFile[]): Offence[] =>
  files.flatMap((file) => {
    const message = "use theme tokens (Tailwind token classes or var(--…)), not a colour literal";
    const lines = new Set([
      ...lineOffences(file, COLOUR_LITERAL, "colour-literal", message).map(({ line }) => line),
      ...lineOffences(file, ARBITRARY_COLOUR, "colour-literal", message).map(({ line }) => line),
      ...(file.rel.endsWith(".css") ? cssValues(commentFree(file)).filter(({ value }) => NAMED_COLOUR_VALUE.test(value)).map(({ line }) => line) : []),
    ]);
    return [...lines].sort((a, b) => a - b).map((line) => ({ rule: "colour-literal" as const, file: file.rel, line, message }));
  });

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
  return /\bstyle\s*=\s*\{/.test(text) || (/\.[cm]?jsx?$/.test(file.rel) && /\bstyle\s*:/.test(text));
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

/**
 * The web app's stylesheet entry never mentions a `legacy` layer, not even in a comment, and no
 * legacy stylesheet exists.
 */
export function legacyStylesheets(appCss: LintFile, css: readonly LintFile[]): Offence[] {
  const offences: Offence[] = appCss.text
    .split("\n")
    .flatMap((line, index) => (/\blegacy\b/.test(line) ? [{ rule: "legacy-stylesheet" as const, file: appCss.rel, line: index + 1, message: "declare no legacy cascade layer" }] : []));
  for (const { rel } of css) {
    if (/(^|\/)styles\/(deck|icons)\.css$/.test(rel)) offences.push({ rule: "legacy-stylesheet", file: rel, line: 0, message: "the legacy stylesheets are gone" });
  }
  return offences;
}

// ---------------------------------------------------------------------------------------------
// Runtime modules: what a web half may import.

/**
 * The bare specifiers deck's page maps to its own modules with an import map. A runtime
 * module's built `web.js` imports these and nothing else (the template's build leaves exactly
 * these external); the web app's import map must map exactly these (apps/web/test/sdk.test.ts).
 */
export const IMPORT_MAP_SPECIFIERS: readonly string[] = ["react", "react-dom", "react/jsx-runtime", "@deck/sdk"];

/** Packages whose job `@deck/sdk` does: its patterns and `<Icon>` carry deck's look and a11y. */
const UI_PACKAGES = /^(radix-ui|@radix-ui\/.+|lucide-react)$/;

interface ImportSite {
  specifier: string;
  line: number;
  kind: "import" | "dynamic" | "require";
  /** `import type`/`export type` (or only type-only names): erased from the build. */
  typeOnly: boolean;
  /** The import's `with { type: "json" }` (or `assert`) attribute, if it has one. */
  json: boolean;
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/** A script, by extension. */
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Whether an import's attributes say `type: "json"`. */
function jsonAttribute(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  const attributes = (node as { attributes?: ts.ImportAttributes }).attributes;
  return (attributes?.elements ?? []).some((element) => element.name.text === "type" && ts.isStringLiteral(element.value) && element.value.text === "json");
}

/** Whether a dynamic `import()`'s options say `{ with: { type: "json" } }` (or `assert`). */
function jsonOption(options: ts.Expression | undefined): boolean {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  const named = (object: ts.ObjectLiteralExpression, names: readonly string[]) =>
    object.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && names.includes(property.name.text));
  const attributes = named(options, ["with", "assert"])?.initializer;
  if (attributes === undefined || !ts.isObjectLiteralExpression(attributes)) return false;
  const type = named(attributes, ["type"])?.initializer;
  return type !== undefined && ts.isStringLiteralLike(type) && type.text === "json";
}

/** Every import in a script: static, re-exports, dynamic `import()`, `require()` and `import x = require()`. */
function importSites({ rel, text }: LintFile): ImportSite[] {
  const extension = /\.[^.]+$/.exec(rel)?.[0] ?? ".js";
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension] ?? ts.ScriptKind.JS);
  const sites: ImportSite[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Node | undefined) => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : "<computed>");
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && named !== undefined && named.length > 0 && named.every((element) => element.isTypeOnly)));
      sites.push({ specifier: node.moduleSpecifier.text, line: at(node), kind: "import", typeOnly, json: jsonAttribute(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
      const typeOnly = node.isTypeOnly || (named !== undefined && named.length > 0 && named.every((element) => element.isTypeOnly));
      sites.push({ specifier: node.moduleSpecifier.text, line: at(node), kind: "import", typeOnly, json: jsonAttribute(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      sites.push({ specifier: literal(node.moduleReference.expression), line: at(node), kind: "require", typeOnly: node.isTypeOnly, json: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      sites.push({ specifier: literal(node.arguments[0]), line: at(node), kind: "dynamic", typeOnly: false, json: jsonOption(node.arguments[1]) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      sites.push({ specifier: literal(node.arguments[0]), line: at(node), kind: "require", typeOnly: false, json: false });
    } else if (ts.isImportTypeNode(node)) {
      return; // `import("x").T` in a type position: erased.
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Why a module's web source may not import `site`, or undefined when it may. */
function importProblem({ specifier, typeOnly, kind }: ImportSite): string | undefined {
  if (kind === "require" && !typeOnly) return `import ${specifier} as an ES module: a web half runs as native ESM in the browser, where require() does not exist`;
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
 * types from `@deck/module-sdk`, and packages it bundles, as ES modules. Never React's other
 * entry points, deck's other packages, the UI libraries `@deck/sdk` stands in for, or
 * `require()`.
 */
export const moduleImports = (scripts: readonly LintFile[]): Offence[] =>
  scripts.flatMap((file) =>
    importSites(file).flatMap((site) => {
      const message = importProblem(site);
      return message === undefined ? [] : [{ rule: "module-import" as const, file: file.rel, line: site.line, message }];
    }),
  );

/**
 * A module's Tailwind prefix: its id, lowercased, with every character that is not a letter
 * removed (Tailwind prefixes are letters only): `hello` → `hello`, `hello-world` → `helloworld`,
 * `hello2` → `hello`.
 */
export const modulePrefix = (id: string): string => id.toLowerCase().replace(/[^a-z]/g, "");

/** Whether a CSS import of `specifier` from `file` is Tailwind itself, by name or by path. */
function isTailwind(specifier: string, file: LintFile): boolean {
  if (/^tailwindcss(\/|$)/.test(specifier)) return true;
  if (!specifier.startsWith(".") || file.path === undefined) return false;
  return /(^|\/)node_modules\/tailwindcss(\/|$)/.test(resolve(dirname(file.path), specifier).split(sep).join("/"));
}

/**
 * A module's CSS takes Tailwind only through `@deck/sdk/tailwind`, with the module's prefix
 * (`modulePrefix(id)`): plain `tailwindcss` (by name or by path, or an `@tailwind` directive)
 * would bring a second Preflight and a palette that is not deck's tokens, and unprefixed
 * utilities would re-declare deck's own classes after deck's stylesheet, overriding its
 * responsive variants.
 */
export const moduleCssImports = (css: readonly LintFile[], prefix: string): Offence[] =>
  css.flatMap((file) => {
    const text = commentFree(file);
    const offences: Offence[] = [];
    const offence = (index: number, message: string) => offences.push({ rule: "module-css-import", file: file.rel, line: lineOf(text, index), message });
    // Every @import, wherever it sits on a line or however it wraps: "x", 'x', url("x") or url(x).
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]+))\s*\)?([^;]*)/g)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      const rest = match[4] ?? "";
      if (isTailwind(specifier, file)) offence(match.index, `import @deck/sdk/tailwind with your module's prefix, not ${specifier}`);
      else if (specifier === "@deck/sdk/tailwind" && /\bprefix\(\s*([^)\s]*)\s*\)/.exec(rest)?.[1] !== prefix) {
        offence(match.index, `import @deck/sdk/tailwind with your module's prefix: \`@import "@deck/sdk/tailwind" prefix(${prefix});\` (its id's letters, lowercased)`);
      }
    }
    for (const match of text.matchAll(/@tailwind\b/g)) offence(match.index, "take Tailwind through @deck/sdk/tailwind with your module's prefix, not an @tailwind directive");
    return offences.sort((a, b) => a.line - b.line);
  });

// ---------------------------------------------------------------------------------------------
// Runtime modules: build output, the web.js and web.css beside a deck-module.json.

/** React's and React DOM's internals, which appear once per bundled copy. */
const REACT_COPY = /__(?:CLIENT|DOM)_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE/;

/**
 * The `web.js` deck serves: it imports only the import-mapped specifiers (and, as a JSON module
 * with `with { type: "json" }`, its own `./deck-module.json`), since deck serves `web.js`,
 * `web.css` and `deck-module.json` and nothing else, and carries no React of its own.
 */
export function builtWebImports(webJs: LintFile): Offence[] {
  const offence = (line: number, message: string): Offence => ({ rule: "built-web-import", file: webJs.rel, line, message });
  const offences = importSites(webJs).flatMap(({ specifier, line, kind, json }) => {
    if (kind === "require") return [offence(line, `web.js is native ESM in the browser, where require(${JSON.stringify(specifier)}) does not exist`)];
    if (IMPORT_MAP_SPECIFIERS.includes(specifier)) return [];
    if (specifier === "./deck-module.json") return json ? [] : [offence(line, 'import ./deck-module.json as a JSON module: with { type: "json" }')];
    return [
      offence(
        line,
        specifier.startsWith(".") ? `web.js must be one file: deck serves no ${specifier}` : `${specifier} is not in deck's import map (${IMPORT_MAP_SPECIFIERS.join(", ")}): bundle it, or import it from @deck/sdk`,
      ),
    ];
  });
  const copy = REACT_COPY.exec(webJs.text);
  if (copy !== null) offences.push(offence(lineOf(webJs.text, copy.index), "web.js bundles its own React or React DOM: import react and react-dom, which deck's import map provides"));
  return offences;
}

/** A Tailwind palette variable (`--color-red-500`, `--hello-color-white`): not one of deck's tokens. */
const PALETTE_VARIABLE = /--(?:[a-z]+-)?color-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/;

type SelectorNode = selectorParser.Node;

/** Whether a class name is the module's own: `<prefix>:…` from the preset, or `<prefix>-…` by hand. */
const ownClass = (name: string, prefix: string): boolean => name.startsWith(`${prefix}:`) || name.startsWith(`${prefix}-`);

/**
 * Whether a compound selector (`.hello\:x:hover`) itself selects only the module's elements: it
 * has one of the module's classes, or an `:is()`/`:where()` every branch of which is scoped.
 * `:not()` and `:has()` never scope: they match elements other than the ones they name.
 */
function compoundOwned(compound: readonly SelectorNode[], prefix: string, nestingScoped: boolean): boolean {
  return compound.some(
    (node) =>
      (node.type === "class" && ownClass(node.value, prefix)) ||
      (node.type === "nesting" && nestingScoped) ||
      (node.type === "pseudo" && (node.value === ":is" || node.value === ":where") && node.nodes.length > 0 && node.nodes.every((branch) => selectorScoped(branch, prefix, nestingScoped))),
  );
}

/**
 * Whether a complex selector can match only the module's own elements: its subject compound is
 * owned, or an owned compound is its ancestor (followed by a descendant or child combinator, so
 * everything to its right sits inside the module's element). `.hello\:x span` is scoped;
 * `.hello\:x + span`, `:is(.p-4)`, `h1`, `[data-slot=x]` and `#x` are not.
 */
function selectorScoped(selector: selectorParser.Selector, prefix: string, nestingScoped: boolean): boolean {
  const compounds: SelectorNode[][] = [[]];
  const combinators: string[] = [];
  for (const node of selector.nodes) {
    if (node.type === "combinator") {
      combinators.push(node.value.trim());
      compounds.push([]);
    } else if (node.type !== "comment") compounds[compounds.length - 1]!.push(node);
  }
  const last = compounds.length - 1;
  if (compoundOwned(compounds[last]!, prefix, nestingScoped)) return true;
  return compounds.slice(0, last).some((compound, index) => (combinators[index] === "" || combinators[index] === ">") && compoundOwned(compound, prefix, nestingScoped));
}

/** Whether a declaration is a custom property of Tailwind's own (`--tw-*`) or of the module's (`--<prefix>-*`). */
const internalProperty = (property: string, prefix: string): boolean => property.startsWith("--tw-") || property.startsWith(`--${prefix}-`);

/** A rule's selectors, each with whether it is scoped; null when the selector does not parse. */
function ruleSelectors(rule: Rule, prefix: string): Array<{ selector: string; scoped: boolean }> | null {
  // A nested rule's `&` is scoped when every selector of the rule it sits in is.
  const parent = rule.parent?.type === "rule" ? (rule.parent as Rule) : undefined;
  const nestingScoped = parent !== undefined && (ruleSelectors(parent, prefix)?.every(({ scoped }) => scoped) ?? false);
  try {
    return selectorParser()
      .astSync(rule.selector)
      .nodes.map((selector) => ({ selector: selector.toString().trim(), scoped: selectorScoped(selector, prefix, nestingScoped) }));
  } catch {
    return null;
  }
}

/** Whether a rule sits in `@keyframes`, whose "selectors" are offsets, not elements. */
function inKeyframes(rule: Rule): boolean {
  for (let node = rule.parent; node !== undefined && node.type !== "root"; node = node.parent as typeof node) {
    if (node.type === "atrule" && /keyframes$/i.test((node as postcss.AtRule).name)) return true;
  }
  return false;
}

/**
 * A module's stylesheet styles only the module's elements: every selector of every style rule
 * (outside `@keyframes`) is scoped to one of its classes (see {@link selectorScoped}), since the
 * module's CSS shares deck's page and loads after deck's own. A rule that declares only
 * custom properties of Tailwind's (`--tw-*`) or the module's own (`--<prefix>-*`), as the
 * preset's theme and fallbacks do, styles nothing and may select anything. A rule that sets
 * `box-sizing` unscoped is Tailwind's Preflight shape: base styles deck already has.
 */
export function cssSelectors(file: LintFile, prefix: string, rule: "module-css-selector" | "built-web-css"): Offence[] {
  const offences: Offence[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(file.text, { from: file.path ?? file.rel });
  } catch (error) {
    return [{ rule, file: file.rel, line: (error as { line?: number }).line ?? 0, message: `the stylesheet does not parse: ${(error as Error).message}` }];
  }
  root.walkRules((node) => {
    if (inKeyframes(node)) return;
    const declarations = node.nodes.filter((child): child is postcss.Declaration => child.type === "decl");
    if (declarations.length > 0 && declarations.every(({ prop }) => internalProperty(prop, prefix))) return;
    const line = node.source?.start?.line ?? 0;
    const selectors = ruleSelectors(node, prefix);
    if (selectors === null) {
      offences.push({ rule, file: file.rel, line, message: `the selector ${node.selector} does not parse` });
      return;
    }
    const unscoped = selectors.filter(({ scoped }) => !scoped).map(({ selector }) => selector);
    if (unscoped.length === 0) return;
    if (declarations.some(({ prop }) => prop.toLowerCase() === "box-sizing")) {
      offences.push({ rule, file: file.rel, line, message: `${unscoped.join(", ")} sets box-sizing outside the module's elements: base styles (Tailwind's Preflight?) deck's page already has; import @deck/sdk/tailwind, which adds utilities only` });
      return;
    }
    for (const selector of unscoped) {
      offences.push({ rule, file: file.rel, line, message: `${selector} can match elements that are not the module's: scope every selector to one of its classes (${prefix}:… or ${prefix}-…)` });
    }
  });
  return offences;
}

/**
 * The `web.css` deck serves, which deck's page loads after its own stylesheet: it styles only
 * the module's elements ({@link cssSelectors}), with no base styles, and carries no Tailwind
 * palette.
 */
export function builtWebCss(webCss: LintFile, prefix: string): Offence[] {
  const offences = cssSelectors(webCss, prefix, "built-web-css");
  const text = blankBlockComments(webCss.text);
  const palette = PALETTE_VARIABLE.exec(text);
  if (palette !== null) offences.push({ rule: "built-web-css", file: webCss.rel, line: lineOf(text, palette.index), message: `web.css carries Tailwind's palette (${palette[0]}): colours are deck's tokens, through @deck/sdk/tailwind` });
  return offences;
}

// ---------------------------------------------------------------------------------------------
// `deck-module lint`: a runtime module's profile.

/** `rel` with `/` separators on every platform. */
const slashed = (rel: string): string => rel.split(sep).join("/");

/** The id in `dir`'s deck-module.json, or undefined when there is none to read. */
function moduleIdIn(dir: string): string | undefined {
  try {
    const { id } = JSON.parse(readFileSync(join(dir, "deck-module.json"), "utf8")) as { id?: unknown };
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A module's build output: a directory holding a deck-module.json, and the web.js/web.css beside it. */
export interface BuiltModule {
  /** The directory, relative to the module root (`""` for the root itself). */
  rel: string;
  id: string;
  webJs?: LintFile;
  webCss?: LintFile;
}

/**
 * The module's build output: the module directory itself when its manifest has a `web.js` or
 * `web.css` beside it (a module with no build step, or one installed as built), and each
 * `dist/<dir>` holding a deck-module.json (the template builds into `dist/<id>`).
 */
export function builtModules(dir: string): BuiltModule[] {
  const dist = join(dir, "dist");
  const candidates = [dir, ...(existsSync(dist) ? readdirSync(dist).map((name) => join(dist, name)).filter((path) => statSync(path).isDirectory()) : [])];
  return candidates.flatMap((candidate) => {
    const id = moduleIdIn(candidate);
    if (id === undefined) return [];
    const read = (name: string): LintFile | undefined => {
      const path = join(candidate, name);
      return existsSync(path) ? { rel: slashed(relative(dir, path)), text: readFileSync(path, "utf8"), path } : undefined;
    };
    const built: BuiltModule = { rel: slashed(relative(dir, candidate)), id };
    const webJs = read("web.js");
    const webCss = read("web.css");
    if (webJs !== undefined) built.webJs = webJs;
    if (webCss !== undefined) built.webCss = webCss;
    return webJs === undefined && webCss === undefined ? [] : [built];
  });
}

/** Directories never searched for sources: dependencies, the build's output, hidden ones. */
const SKIPPED_DIRS = new Set(["node_modules", "dist"]);
/** Files that never run in the browser unless web code imports them: tests and tool config. */
const TOOLING = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[^./]+$|\.config\.[^./]+$|\.d\.[cm]?ts$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith(".") || SKIPPED_DIRS.has(name) ? [] : walk(path);
    return [path];
  });
}

/** The file a relative import from `from` names, trying the script extensions and index files. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const extensions = Object.keys(SCRIPT_KINDS);
  const candidates = [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))];
  // A `.js` specifier may name a TypeScript source (`./x.js` → `./x.ts`).
  if (/\.[cm]?jsx?$/.test(base)) candidates.push(...[".ts", ".tsx", ".mts", ".cts"].map((extension) => base.replace(/\.[cm]?jsx?$/, extension)));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** The files reachable from `roots` by relative imports, among `among`. */
function reachable(roots: Iterable<string>, among: ReadonlySet<string>): Set<string> {
  const seen = new Set(roots);
  const queue = [...seen];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (!SCRIPT.test(path)) continue;
    for (const { specifier } of importSites({ rel: path, text: readFileSync(path, "utf8") })) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(path, specifier);
      if (target !== undefined && among.has(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

/** A server entry: `server.js`, `server.mjs` or `server.ts` (and the like), at the module's root or in `src/`. */
const SERVER_ENTRY = /^(?:src\/)?server\.(?:[cm]?[jt]s)$/;

/** Bundler output markers: Tailwind's banner on a stylesheet; a bundler's pure annotations or a source map on a script. */
const BUNDLER_MARKER = /^\/\*! tailwindcss v|\/\*\s*[@#]__PURE__\s*\*\/|\/\/# sourceMappingURL=/;

/**
 * A module's web sources, relative to `dir`: every script and stylesheet in the module, wherever
 * it sits, except:
 * - dependencies (`node_modules`), the build's output (`dist/`) and hidden directories;
 * - its server code: a server entry (`server.*` at the root or in `src/`) and the files only
 *   server code imports;
 * - tests and tool config (`test/`, `*.test.*`, `*.config.*`), unless web code imports them;
 * - the web.js and web.css beside the manifest when they are build output: when the module has
 *   sources of its own elsewhere, or the file carries a bundler's marker. A module with no build
 *   step has no other sources: its web.js and web.css are its sources too.
 */
export function moduleWebSources(dir: string): LintFile[] {
  const rel = (path: string) => slashed(relative(dir, path));
  const all = new Set(walk(dir).filter((path) => SCRIPT.test(path) || path.endsWith(".css")));
  const served = moduleIdIn(dir) === undefined ? [] : ["web.js", "web.css"].map((name) => join(dir, name)).filter((path) => all.has(path));
  const servers = [...all].filter((path) => SERVER_ENTRY.test(rel(path)));
  const tooling = (path: string) => TOOLING.test(rel(path));
  // Code reachable from a server entry is server code, unless other code reaches it too.
  const serverSide = reachable(servers, all);
  const web = reachable([...all].filter((path) => !tooling(path) && !serverSide.has(path) && !served.includes(path)), all);
  // A served file is build output when the module has web sources of its own, or a bundler wrote it.
  const noBuild = web.size === 0;
  for (const path of served) {
    if (noBuild && !BUNDLER_MARKER.test(readFileSync(path, "utf8"))) web.add(path);
  }
  return [...web]
    .map((path) => ({ rel: rel(path), text: readFileSync(path, "utf8"), path }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

export interface ModuleLintOptions {
  /** Files that may set an inline style (dynamic geometry only), mapped to why. */
  styleAllowlist?: Readonly<Record<string, string>>;
}

/**
 * Lint a runtime module directory: deck's guardrails over its web sources (scripts and CSS,
 * their imports and selectors included), and the build-output checks over each web.js/web.css
 * beside a deck-module.json. A bundle that is not also a source gets only the build-output
 * checks: it carries its dependencies' code, which the source rules are not about.
 */
export function lintModule(dir: string, options: ModuleLintOptions = {}): Offence[] {
  const sources = moduleWebSources(dir);
  const scripts = sources.filter(({ rel }) => SCRIPT.test(rel));
  const css = sources.filter(({ rel }) => rel.endsWith(".css"));
  const prefix = modulePrefix(moduleIdIn(dir) ?? "");
  return [
    ...colourLiterals(sources),
    ...offScaleRadii(scripts),
    ...inlineStyles(scripts, options.styleAllowlist),
    ...dataIconAttributes(scripts),
    ...legacyTokens(sources),
    ...moduleImports(scripts),
    ...moduleCssImports(css, prefix),
    ...css.flatMap((file) => cssSelectors(file, prefix, "module-css-selector")),
    ...builtModules(dir).flatMap((built) => [
      ...(built.webJs === undefined ? [] : builtWebImports(built.webJs)),
      ...(built.webCss === undefined ? [] : builtWebCss(built.webCss, modulePrefix(built.id))),
    ]),
  ];
}
